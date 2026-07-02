"""
main.py — FastAPI Application
==============================

ARCHITECTURE OVERVIEW (v4 — Async Upload)
------------------------------------------
Document upload is now fully asynchronous:

  Client ──► POST /upload-document  (fast, ~200ms)
                    │
                    ▼  returns {job_id, status: "queued"}  HTTP 202
                    │
              BackgroundTask starts
                    │
                    ├── Extract text / OCR       (logs timing)
                    ├── Chunk text               (logs timing)
                    ├── Generate embeddings      (logs timing)
                    ├── Save to database         (logs timing)
                    └── Mark job "ready"         (logs total time)

  Client ──► GET /upload-document/status/{job_id}  (every 2 s)
                    │
                    ▼  returns {status, progress, message, timings}

All other endpoints (RAG chat, session summary, clear documents) are
UNCHANGED and continue to work exactly as before.
"""

import io
import logging
import logging.config
import tempfile
import time
import traceback
from pathlib import Path
from typing import Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import SUPABASE_URL, SUPABASE_ANON_KEY
from app.rag import (
    process_chat, chunk_text, store_chunks, delete_user_documents,
    generate_session_summary, expand_query, search_similar,
    rerank_chunks, stream_rag_response, clean_ocr_text,
)
from app.document_processor import DocumentProcessor
from app.job_store import (
    create_job, update_job, get_job,
    get_active_job_for_user_file, cleanup_old_jobs,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Arch AI Chatbot API", version="4.0.0")

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "*",   # Allow all in development
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ---------------------------------------------------------------------------
# Singletons
# ---------------------------------------------------------------------------
# DocumentProcessor is heavy to initialise (loads Tesseract config, etc.).
# We create it ONCE at startup and reuse it for every upload request.
# SentenceTransformer is loaded in rag.py at import time — also a singleton.
doc_processor = DocumentProcessor()

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    chat_history: Optional[list[dict]] = None


class SessionSummaryRequest(BaseModel):
    messages: list[dict]


# ---------------------------------------------------------------------------
# Auth helpers — unchanged from v3
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str) -> str:
    """
    Verify a Supabase access token by calling Supabase /auth/v1/user.
    Returns the user UUID on success. Raises HTTP 401 on failure.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Invalid Authorization header format.",
        )

    token = authorization[7:]  # strip "Bearer "

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": SUPABASE_ANON_KEY,
            },
        )

    if resp.status_code != 200:
        logger.warning("Supabase auth rejected token: %s", resp.status_code)
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired session. Please log in again.",
        )

    user_data = resp.json()
    user_id   = user_data.get("id")
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="Could not extract user identity.",
        )

    return user_id


async def get_optional_user(authorization: Optional[str] = None) -> Optional[str]:
    """
    Like get_current_user but returns None for missing / invalid token.
    Used by /rag-chat to support both public and authenticated modes.
    """
    if not authorization:
        return None
    try:
        return await get_current_user(authorization)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Background task — ALL heavy document work lives here
# ---------------------------------------------------------------------------

def process_document_background(
    job_id   : str,
    tmp_path : str,
    filename : str,
    user_id  : str,
) -> None:
    """
    The production-style background processing function.

    This runs in FastAPI's thread-pool worker, completely detached from
    the HTTP request that created it. The HTTP response (202) has already
    been sent to the client by the time this starts.

    Stages and their status transitions:
    ─────────────────────────────────────
    queued      (set by upload endpoint)
    extracting  PDF/image text + table extraction + initial OCR
    ocr         Explicitly marked when OCR is the dominant step
    chunking    Splitting text into overlapping windows
    embedding   Generating 384-dim vectors per chunk (SentenceTransformer)
    saving      Writing vectors + text to PostgreSQL via pgvector
    ready       ✅ Done — RAG search now active

    On any exception:
    ─────────────────
    status → "error"
    error  → human-readable description
    The server does NOT crash. The frontend will display the error.

    Timing:
    ───────
    Wall-clock time is recorded for every stage and stored in
    job["timings"]. The frontend currently does not display timings, but
    they are visible in the server logs for performance profiling.

    Parameters
    ----------
    job_id   : str   The job to update throughout processing.
    tmp_path : str   Path to the temp file written by the upload endpoint.
    filename : str   Original filename (e.g., "report.pdf") for logging.
    user_id  : str   Supabase user UUID — all chunks are tagged with this.
    """
    total_start = time.perf_counter()
    timings: dict[str, float] = {}

    try:
        # ── STAGE 1: Extract text (PDF plumber, PyMuPDF, Tesseract OCR) ──────
        update_job(
            job_id,
            status   = "extracting",
            progress = 10,
            message  = "📄 Extracting text from document…",
        )

        t0 = time.perf_counter()
        tmp_file_path = Path(tmp_path)
        file_bytes    = tmp_file_path.read_bytes()   # read from temp file

        processed = doc_processor.process_file(file_bytes, filename)
        timings["extraction_s"] = round(time.perf_counter() - t0, 3)
        logger.info(
            "[bg:%s] Extraction done in %.2fs | chars=%d | tables=%d | images=%d",
            job_id, timings["extraction_s"],
            len(processed.text),
            len(processed.tables),
            len(processed.images),
        )

        # ── Check: does the document have any usable text? ───────────────────
        if not processed.text.strip():
            update_job(
                job_id,
                status   = "error",
                progress = 0,
                message  = "❌ No content could be extracted from this file.",
                error    = "Document appears to be empty or corrupted.",
            )
            return

        # ── STAGE 2: OCR annotation (the extraction above already ran OCR;
        #    we update the status label so the frontend shows "Running OCR"
        #    during what was really part of extraction for scanned files) ──────
        is_scanned = (
            processed.metadata.get("processing") == "full_ocr"
            or processed.metadata.get("type")     == "image"
        )

        if is_scanned:
            # OCR was the primary step — update label retroactively
            # (the wall-clock time is already counted in extraction_s)
            update_job(
                job_id,
                status   = "ocr",
                progress = 30,
                message  = "🔍 OCR complete — text extracted from scanned content.",
            )
            timings["ocr_s"] = timings["extraction_s"]   # OCR = extraction for scanned
            logger.info("[bg:%s] OCR timing attributed: %.2fs", job_id, timings["ocr_s"])

        # ── STAGE 3: Chunking ─────────────────────────────────────────────────
        update_job(
            job_id,
            status   = "chunking",
            progress = 45,
            message  = "✂️ Chunking document into overlapping windows…",
        )

        t0     = time.perf_counter()
        text   = clean_ocr_text(processed.text) if is_scanned else processed.text
        chunks = chunk_text(text)
        timings["chunking_s"] = round(time.perf_counter() - t0, 3)
        logger.info(
            "[bg:%s] Chunked into %d chunks in %.3fs",
            job_id, len(chunks), timings["chunking_s"],
        )

        if not chunks:
            update_job(
                job_id,
                status   = "error",
                progress = 0,
                message  = "❌ No chunks produced — document may be too short.",
                error    = "chunk_text() returned an empty list.",
            )
            return

        # ── STAGE 4: Embedding + DB save ──────────────────────────────────────
        # We combine embedding generation and DB save into one stage because
        # store_chunks() generates the embedding just before saving each chunk.
        # The on_progress callback lets us report granular progress.
        update_job(
            job_id,
            status   = "embedding",
            progress = 55,
            message  = f"🧠 Generating embeddings for {len(chunks)} chunks…",
        )

        embed_start = time.perf_counter()
        n_chunks    = len(chunks)

        def _on_chunk_saved(chunks_done: int, total: int) -> None:
            """
            Called by store_chunks() after EACH chunk is embedded + saved.

            We use this callback to smoothly animate the progress bar
            from 55% (embedding starts) to 95% (saving complete).

            The formula maps chunks_done/total → a value in [55, 95].
            At chunk 0/N: 55%, at chunk N/N: 95%.
            """
            # fraction of chunks done, mapped to the 55–95 range
            fraction = chunks_done / total if total > 0 else 1.0
            progress = int(55 + fraction * 40)   # 55% → 95%

            # Transition the status label at the halfway point
            if chunks_done == 1:
                status  = "embedding"
                message = f"🧠 Embedding chunk {chunks_done}/{total}…"
            elif chunks_done > total // 2:
                status  = "saving"
                message = f"💾 Saving chunk {chunks_done}/{total} to knowledge base…"
            else:
                status  = "embedding"
                message = f"🧠 Embedding chunk {chunks_done}/{total}…"

            update_job(job_id, status=status, progress=progress, message=message)

        t0_embed = time.perf_counter()
        stored   = store_chunks(chunks, user_id, on_progress=_on_chunk_saved)
        timings["embedding_s"] = round(time.perf_counter() - t0_embed, 3)
        timings["db_save_s"]   = timings["embedding_s"]   # combined stage
        logger.info(
            "[bg:%s] Embedding + DB save: %d chunks in %.2fs",
            job_id, stored, timings["embedding_s"],
        )

        # ── STAGE 5: Done ─────────────────────────────────────────────────────
        timings["total_s"] = round(time.perf_counter() - total_start, 3)

        # Build a rich result dict that the frontend could display
        result = {
            "filename"   : filename,
            "chunks"     : stored,
            "metadata"   : processed.metadata,
            "timings"    : timings,
            "message"    : _build_success_message(filename, stored, processed, timings),
        }

        update_job(
            job_id,
            status   = "ready",
            progress = 100,
            message  = "✅ Ready! You can now ask questions about this document.",
            result   = result,
            timings  = timings,
        )

        logger.info(
            "[bg:%s] ✅ DONE | file=%s | chunks=%d | "
            "extract=%.2fs | chunk=%.3fs | embed+save=%.2fs | TOTAL=%.2fs",
            job_id, filename, stored,
            timings.get("extraction_s", 0),
            timings.get("chunking_s",   0),
            timings.get("embedding_s",  0),
            timings["total_s"],
        )

    except Exception as exc:
        # ── Global exception handler ───────────────────────────────────────────
        # NEVER crash the background thread. Log everything, mark the job
        # as failed, and let the frontend show the error to the user.
        timings["total_s"] = round(time.perf_counter() - total_start, 3)
        error_detail       = str(exc)
        full_tb            = traceback.format_exc()

        logger.error(
            "[bg:%s] ❌ FAILED after %.2fs | file=%s | error=%s\n%s",
            job_id, timings["total_s"], filename, error_detail, full_tb,
        )

        update_job(
            job_id,
            status   = "error",
            progress = 0,
            message  = f"❌ Processing failed: {error_detail[:200]}",
            error    = error_detail,
            timings  = timings,
        )

    finally:
        # Always delete the temp file, whether processing succeeded or failed.
        # This prevents disk accumulation from failed uploads.
        try:
            Path(tmp_path).unlink(missing_ok=True)
            logger.debug("[bg:%s] Temp file removed: %s", job_id, tmp_path)
        except Exception as cleanup_exc:
            logger.warning(
                "[bg:%s] Could not remove temp file %s: %s",
                job_id, tmp_path, cleanup_exc,
            )


def _build_success_message(filename: str, stored: int, processed, timings: dict) -> str:
    """Build the human-readable success message shown in the frontend."""
    parts = [f"✅ '{filename}' processed successfully:"]

    if processed.metadata.get("total_pages"):
        parts.append(f"📄 {processed.metadata['total_pages']} pages")

    if processed.metadata.get("tables_found", 0) > 0:
        parts.append(f"📊 {processed.metadata['tables_found']} tables extracted")

    if processed.metadata.get("images_found", 0) > 0:
        parts.append(f"🔍 {processed.metadata['images_found']} images OCR'd")

    if processed.metadata.get("processing") == "full_ocr":
        parts.append("🔍 Full OCR applied (scanned document)")

    parts.append(f"💾 {stored} chunks stored")
    parts.append(f"⏱ Total: {timings.get('total_s', 0):.1f}s")

    return " • ".join(parts)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", tags=["health"])
def root():
    logger.info("Health check hit.")
    return {
        "status"  : "ok",
        "message" : "Arch AI Chatbot API is running 🚀",
        "version" : "4.0.0",
        "upload"  : "async — returns job_id immediately",
        "features": {
            "multi_format_upload": True,
            "ocr"                : True,
            "async_upload"       : True,
            "table_extraction"   : True,
            "cost"               : "FREE - No API costs!",
        },
    }


# ---------------------------------------------------------------------------
# Chat endpoints — COMPLETELY UNCHANGED from v3
# ---------------------------------------------------------------------------

@app.post("/rag-chat", tags=["chat"])
async def rag_chat(
    request      : ChatRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Dual-mode RAG endpoint.
    No Authorization → public fallback.
    With Authorization → hybrid search + RAG or fallback by relevance.
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    user_id = await get_optional_user(authorization)
    logger.info(
        "POST /rag-chat | user_id=%s | message=%r",
        user_id or "public", request.message[:80],
    )

    try:
        result = process_chat(
            request.message,
            user_id      = user_id,
            chat_history = request.chat_history,
        )
        logger.info("POST /rag-chat | mode=%s", result["mode"])
        return result
    except Exception as exc:
        logger.error("POST /rag-chat | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Something went wrong while processing your message. Please try again.",
        )


@app.post("/rag-chat/stream", tags=["chat"])
async def rag_chat_stream(
    request      : ChatRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Streaming version of /rag-chat.
    Tokens stream as they arrive from Groq — no waiting for full response.
    Response headers: X-Mode, X-Confidence, X-Source.
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    user_id = await get_optional_user(authorization)
    logger.info(
        "POST /rag-chat/stream | user_id=%s | message=%r",
        user_id or "public", request.message[:80],
    )

    if user_id is None:
        mode       = "fallback"
        confidence = "N/A"
        docs       = []
    else:
        expanded           = expand_query(request.message)
        docs, avg_distance = search_similar(expanded, user_id)
        if docs:
            docs       = rerank_chunks(expanded, docs)
            mode       = "rag"
            confidence = (
                "High"    if avg_distance < 0.4 else
                "Medium"  if avg_distance < 0.6 else
                "Low"     if avg_distance < 0.7 else
                "Very Low"
            )
        else:
            mode       = "fallback"
            confidence = "N/A"
            docs       = []

    return StreamingResponse(
        stream_rag_response(docs, request.message, request.chat_history),
        media_type="text/plain",
        headers={
            "X-Mode"                       : mode,
            "X-Confidence"                 : confidence,
            "X-Source"                     : (
                "From your document" if mode == "rag"
                else "General AI knowledge"
            ),
            "Access-Control-Expose-Headers": "X-Mode, X-Confidence, X-Source",
        },
    )


@app.post("/api/session/summary", tags=["chat"])
async def session_summary(
    request      : SessionSummaryRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Authenticated endpoint — generates a professional Markdown summary of
    the user's chat session before logout.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required.")
    user_id = await get_current_user(authorization)

    logger.info(
        "POST /api/session/summary | user_id=%s | history_len=%d",
        user_id, len(request.messages),
    )

    if not request.messages:
        return {"summary": "No chat history to summarize."}

    try:
        summary_text = generate_session_summary(request.messages)
        return {"summary": summary_text}
    except Exception as exc:
        logger.error("POST /api/session/summary | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to generate session summary. Please try again.",
        )


# ---------------------------------------------------------------------------
# Document upload — ASYNC (v4 change)
# ---------------------------------------------------------------------------

@app.post("/upload-document", status_code=202, tags=["documents"])
async def upload_document(
    background_tasks: BackgroundTasks,
    file            : UploadFile = File(...),
    authorization   : Optional[str] = Header(default=None),
):
    """
    Async document upload endpoint (v4).

    What changed from v3
    --------------------
    v3: All processing (OCR, chunking, embedding, DB save) happened
        synchronously inside this function. The HTTP connection stayed
        open for 5–60 seconds. A network timeout would kill the pipeline.

    v4: This endpoint validates the file, writes it to a temp file,
        creates a job record, schedules the heavy work as a background
        task, and returns HTTP 202 in ~200 ms.

        The client polls GET /upload-document/status/{job_id} every
        2 seconds to track progress.

    Duplicate prevention
    --------------------
    If the same user uploads the same filename while a previous job is
    still processing, we return the existing job_id immediately — no
    second processing run is started.

    Returns (HTTP 202)
    ------------------
    {
        "job_id" : "a3f1c9d2...",
        "status" : "queued",
        "filename": "report.pdf"
    }
    """
    # ── Auth ──────────────────────────────────────────────────────────────────
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Login required to upload documents.",
        )
    user_id = await get_current_user(authorization)

    # ── Validate file type (fast — no IO) ────────────────────────────────────
    is_supported, file_category = DocumentProcessor.is_supported_format(file.filename)
    if not is_supported:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file format. "
                "Supported: PDF, PNG, JPG, JPEG, WEBP, BMP, TIFF"
            ),
        )

    # ── Lazy cleanup of old jobs (prevents memory leak) ───────────────────────
    cleanup_old_jobs()

    # ── Duplicate-upload check ────────────────────────────────────────────────
    # If the same user already has an active (non-terminal) job for this
    # filename, return that existing job_id instead of starting a new run.
    existing_job_id = get_active_job_for_user_file(file.filename, user_id)
    if existing_job_id:
        existing_job = get_job(existing_job_id)
        logger.info(
            "POST /upload-document | Duplicate detected — reusing job_id=%s "
            "user=%s file=%s status=%s",
            existing_job_id, user_id, file.filename,
            existing_job.get("status") if existing_job else "unknown",
        )
        return {
            "job_id"  : existing_job_id,
            "status"  : existing_job.get("status", "queued") if existing_job else "queued",
            "filename": file.filename,
            "reused"  : True,
        }

    # ── Read file bytes ────────────────────────────────────────────────────────
    # We must read the bytes NOW (while the UploadFile object is still valid).
    # After the HTTP request returns, the file object is closed and unreadable.
    try:
        file_bytes = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Could not read the uploaded file.",
        )

    if not file_bytes:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is empty.",
        )

    logger.info(
        "POST /upload-document | user_id=%s | filename=%s | type=%s | size=%d bytes",
        user_id, file.filename, file_category, len(file_bytes),
    )

    # ── Write to temp file ────────────────────────────────────────────────────
    # We can't pass raw bytes across threads safely in all cases.
    # Writing to a named temp file and passing the path is the correct approach.
    # The background task reads from this path and deletes the file when done.
    try:
        suffix   = Path(file.filename).suffix  # e.g., ".pdf"
        tmp_file = tempfile.NamedTemporaryFile(
            suffix  = suffix,
            delete  = False,   # We delete manually in the background task
            prefix  = "archai_upload_",
        )
        tmp_file.write(file_bytes)
        tmp_file.close()
        tmp_path = tmp_file.name
    except Exception as exc:
        logger.error("Failed to write temp file: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Server could not stage the uploaded file. Please try again.",
        )

    # ── Create job record ─────────────────────────────────────────────────────
    job_id = create_job(filename=file.filename, user_id=user_id)

    # ── Schedule background processing ───────────────────────────────────────
    # BackgroundTasks.add_task() is non-blocking.
    # The task starts after THIS request handler returns its response.
    # The HTTP 202 response is sent to the client BEFORE the task runs.
    background_tasks.add_task(
        process_document_background,
        job_id   = job_id,
        tmp_path = tmp_path,
        filename = file.filename,
        user_id  = user_id,
    )

    # ── Return immediately ────────────────────────────────────────────────────
    logger.info(
        "POST /upload-document | Accepted job_id=%s | user=%s | file=%s",
        job_id, user_id, file.filename,
    )

    return {
        "job_id"  : job_id,
        "status"  : "queued",
        "filename": file.filename,
    }


# ---------------------------------------------------------------------------
# Job status endpoint — NEW in v4
# ---------------------------------------------------------------------------

@app.get("/upload-document/status/{job_id}", tags=["documents"])
async def get_upload_status(
    job_id        : str,
    authorization : Optional[str] = Header(default=None),
):
    """
    Poll the status of a background document-processing job.

    Security
    --------
    Requires authentication. Verifies that the requesting user owns the job.
    One user cannot read another user's job status.

    Response
    --------
    {
        "job_id"   : "a3f1c9d2…",
        "status"   : "embedding",      # one of the 8 status values
        "progress" : 70,               # 0–100 integer
        "message"  : "🧠 Embedding chunk 4/7…",
        "timings"  : {                 # only populated after stages complete
            "extraction_s" : 1.23,
            "chunking_s"   : 0.04,
            "embedding_s"  : 8.91,
            "total_s"      : 10.2
        },
        "result"   : { ... } | null,   # populated only on status = "ready"
        "error"    : null | "message"  # populated only on status = "error"
    }

    Frontend polling contract
    -------------------------
    - Poll every 2 seconds.
    - Stop polling when status is "ready" or "error".
    - Display the "message" field directly to the user.
    - Use "progress" (0–100) to drive the progress bar width.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required.")

    user_id = await get_current_user(authorization)

    job = get_job(job_id)

    if job is None:
        raise HTTPException(
            status_code=404,
            detail=f"Job '{job_id}' not found. It may have expired (jobs expire after 1 hour).",
        )

    # Security: ensure this user owns this job
    if job["user_id"] != user_id:
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to view this job.",
        )

    # Return only the fields the frontend needs
    return {
        "job_id"  : job["job_id"],
        "status"  : job["status"],
        "progress": job["progress"],
        "message" : job["message"],
        "timings" : job["timings"],
        "result"  : job.get("result"),
        "error"   : job.get("error"),
    }


# ---------------------------------------------------------------------------
# Legacy endpoint — unchanged
# ---------------------------------------------------------------------------

@app.post("/upload-pdf", tags=["documents"])
async def upload_pdf_legacy(
    background_tasks: BackgroundTasks,
    file            : UploadFile = File(...),
    authorization   : Optional[str] = Header(default=None),
):
    """
    Legacy PDF-only upload endpoint. Delegates to the new async endpoint.
    Kept for backward compatibility.
    """
    return await upload_document(background_tasks, file, authorization)


# ---------------------------------------------------------------------------
# Document deletion — unchanged
# ---------------------------------------------------------------------------

@app.delete("/clear-user-documents", tags=["documents"])
async def clear_user_documents(
    authorization: Optional[str] = Header(default=None),
):
    """
    Authenticated endpoint — deletes ALL documents belonging to the current user.
    Called by the frontend on logout.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required.")
    user_id = await get_current_user(authorization)

    logger.info("DELETE /clear-user-documents | user_id=%s", user_id)

    try:
        deleted = delete_user_documents(user_id)
        return {
            "status" : "ok",
            "deleted": deleted,
            "message": f"🗑️ {deleted} document chunk(s) permanently deleted.",
        }
    except Exception as exc:
        logger.error("DELETE /clear-user-documents | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to delete documents. Please try again.",
        )