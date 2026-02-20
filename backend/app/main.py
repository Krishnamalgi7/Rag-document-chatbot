import io
import logging
import logging.config
import pdfplumber
import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from app.config import SUPABASE_URL, SUPABASE_ANON_KEY
from app.rag import process_chat, chunk_text, store_chunks, delete_user_documents

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
app = FastAPI(title="MyChatbot API", version="2.0.0")

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str

# ---------------------------------------------------------------------------
# Auth helper — verifies Supabase JWT and returns user_id
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str) -> str:
    """
    Verify a Supabase access token by calling Supabase /auth/v1/user.
    Returns the user UUID on success. Raises HTTP 401 on failure.
    This approach requires no extra JWT library — Supabase validates the token.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid Authorization header format.")

    token = authorization[7:]  # strip "Bearer "

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": SUPABASE_ANON_KEY,
            },
            timeout=10.0,
        )

    if resp.status_code != 200:
        logger.warning("Supabase auth rejected token: %s", resp.status_code)
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired session. Please log in again.",
        )

    user_data = resp.json()
    user_id = user_data.get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Could not extract user identity.")

    return user_id


async def get_optional_user(authorization: Optional[str] = None) -> Optional[str]:
    """
    Like get_current_user but returns None for missing/invalid token.
    Used by /rag-chat to support both public and authenticated modes.
    """
    if not authorization:
        return None
    try:
        return await get_current_user(authorization)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", tags=["health"])
def root():
    logger.info("Health check hit.")
    return {"status": "ok", "message": "MyChatbot API is running 🚀"}


@app.post("/rag-chat", tags=["chat"])
async def rag_chat(
    request: ChatRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Dual-mode RAG endpoint.
    - No Authorization header → public mode → always fallback
    - Valid Authorization header → authenticated mode → RAG or fallback by relevance
    Returns {"mode": "rag"|"fallback", "response": "..."}
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    user_id = await get_optional_user(authorization)
    logger.info("POST /rag-chat | user_id=%s | message=%r", user_id or "public", request.message[:80])

    try:
        result = process_chat(request.message, user_id=user_id)
        logger.info("POST /rag-chat | mode=%s", result["mode"])
        return result
    except Exception as exc:
        logger.error("POST /rag-chat | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Something went wrong while processing your message. Please try again.",
        )


@app.post("/upload-pdf", tags=["documents"])
async def upload_pdf(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
):
    """
    Authenticated endpoint — requires valid Supabase session.
    Extracts PDF text, chunks it, and stores chunks with the user's user_id.
    """
    # Require authentication
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required to upload documents.")
    user_id = await get_current_user(authorization)

    # Validate file type
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted.",
        )

    logger.info("POST /upload-pdf | user_id=%s | filename=%s", user_id, file.filename)

    # Read bytes
    try:
        pdf_bytes = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read the uploaded file.")

    # Extract text
    try:
        text_pages = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total_pages = len(pdf.pages)
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_pages.append(page_text.strip())

        full_text = "\n\n".join(text_pages)
        logger.info("Extracted text from %d/%d pages (%d chars).", len(text_pages), total_pages, len(full_text))
    except Exception as exc:
        logger.error("PDF text extraction failed: %s", exc)
        raise HTTPException(
            status_code=422,
            detail="Could not extract text from the PDF. The file may be scanned or encrypted.",
        )

    if not full_text.strip():
        raise HTTPException(
            status_code=422,
            detail="No readable text found in this PDF. It may be a scanned image-only PDF.",
        )

    # Chunk and store with user_id
    try:
        chunks = chunk_text(full_text)
        stored = store_chunks(chunks, user_id)
        logger.info("POST /upload-pdf | stored %d chunks for user_id=%s.", stored, user_id)
    except Exception as exc:
        logger.error("POST /upload-pdf | store error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Text extracted but failed to store. Please try again.",
        )

    return {
        "status":   "ok",
        "filename": file.filename,
        "pages":    total_pages,
        "chunks":   stored,
        "message":  f"✅ '{file.filename}' processed: {total_pages} pages → {stored} chunks stored.",
    }


@app.delete("/clear-user-documents", tags=["documents"])
async def clear_user_documents(
    authorization: Optional[str] = Header(default=None),
):
    """
    Authenticated endpoint — deletes ALL documents belonging to the current user.
    Called by the frontend on logout to ensure no data persists.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required.")
    user_id = await get_current_user(authorization)

    logger.info("DELETE /clear-user-documents | user_id=%s", user_id)

    try:
        deleted = delete_user_documents(user_id)
        return {
            "status":  "ok",
            "deleted": deleted,
            "message": f"🗑️ {deleted} document chunk(s) permanently deleted.",
        }
    except Exception as exc:
        logger.error("DELETE /clear-user-documents | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to delete documents. Please try again.",
        )