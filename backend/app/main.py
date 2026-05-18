import io
import logging
import logging.config
import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

from app.config import SUPABASE_URL, SUPABASE_ANON_KEY
from app.rag import (
    process_chat, chunk_text, store_chunks, delete_user_documents,
    generate_session_summary, expand_query, search_similar,
    rerank_chunks, stream_rag_response,
)
from app.document_processor import DocumentProcessor

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
app = FastAPI(title="Arch AI Chatbot API - Multi-Modal", version="3.0.0")

# ---------------------------------------------------------------------------
# CORS - Updated for development
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "*"  # Allow all in development
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ---------------------------------------------------------------------------
# Initialize Document Processor (FREE version - no API costs!)
# ---------------------------------------------------------------------------
doc_processor = DocumentProcessor()

# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    chat_history: Optional[list[dict]] = None  # last N messages for context

class SessionSummaryRequest(BaseModel):
    messages: list[dict]

# ---------------------------------------------------------------------------
# Auth helper — verifies Supabase JWT and returns user_id
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str) -> str:
    """
    Verify a Supabase access token by calling Supabase /auth/v1/user.
    Returns the user UUID on success. Raises HTTP 401 on failure.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid Authorization header format.")

    token = authorization[7:]  # strip "Bearer "

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": SUPABASE_ANON_KEY,
            },
            timeout=15.0,
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
    return {
        "status": "ok",
        "message": "Arch AI Chatbot API is running 🚀",
        "version": "3.0.0-FREE",
        "features": {
            "multi_format_upload": True,
            "ocr": True,
            "vision_analysis": False,  # FREE version uses OCR only
            "table_extraction": True,
            "cost": "FREE - No API costs!"
        },
        "supported_formats": {
            "pdf": [".pdf"],
            "images": [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"]
        }
    }


@app.post("/rag-chat", tags=["chat"])
async def rag_chat(
    request: ChatRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Dual-mode RAG endpoint with multi-modal support.
    - No Authorization header → public mode → always fallback
    - Valid Authorization header → authenticated mode → RAG or fallback by relevance
    Returns {"mode": "rag"|"fallback", "response": "..."}
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    user_id = await get_optional_user(authorization)
    logger.info("POST /rag-chat | user_id=%s | message=%r", user_id or "public", request.message[:80])

    try:
        result = process_chat(request.message, user_id=user_id, chat_history=request.chat_history)
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
    request: ChatRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Streaming version of /rag-chat.
    Returns tokens as they arrive from Groq — no waiting for full response.
    Response headers include X-Mode and X-Confidence for the frontend.

    Frontend reads response as a stream and appends tokens word by word.
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    user_id = await get_optional_user(authorization)
    logger.info(
        "POST /rag-chat/stream | user_id=%s | message=%r",
        user_id or "public", request.message[:80],
    )

    # Determine mode and retrieve context (same logic as process_chat)
    if user_id is None:
        # Public mode — stream fallback directly
        mode       = "fallback"
        confidence = "N/A"
        docs       = []
    else:
        expanded = expand_query(request.message)
        docs, avg_distance = search_similar(expanded, user_id)
        if docs:
            docs       = rerank_chunks(expanded, docs)
            mode       = "rag"
            confidence = (
                "High"   if avg_distance < 0.4 else
                "Medium" if avg_distance < 0.6 else
                "Low"    if avg_distance < 0.7 else
                "Very Low"
            )
        else:
            mode       = "fallback"
            confidence = "N/A"
            docs       = []

    # Stream response with mode/confidence in headers for React to read
    return StreamingResponse(
        stream_rag_response(docs, request.message, request.chat_history),
        media_type="text/plain",
        headers={
            "X-Mode"       : mode,
            "X-Confidence" : confidence,
            "X-Source"     : "From your document" if mode == "rag" else "General AI knowledge",
            "Access-Control-Expose-Headers": "X-Mode, X-Confidence, X-Source",
        },
    )


@app.post("/api/session/summary", tags=["chat"])
async def session_summary(
    request: SessionSummaryRequest,
    authorization: Optional[str] = Header(default=None),
):
    """
    Authenticated endpoint to generate a professional summary of the user's session
    before logout.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required.")
    user_id = await get_current_user(authorization)

    logger.info("POST /api/session/summary | user_id=%s | history_len=%d", user_id, len(request.messages))

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


@app.post("/upload-document", tags=["documents"])
async def upload_document(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
):
    """
    Multi-format document upload endpoint (FREE version with OCR).
    Supports: PDFs (text + scanned), Images (with OCR), Tables.
    
    Authenticated endpoint — requires valid Supabase session.
    Processes document, extracts content, and stores with user's user_id.
    """
    # Require authentication
    if not authorization:
        raise HTTPException(status_code=401, detail="Login required to upload documents.")
    user_id = await get_current_user(authorization)

    # Validate file type
    is_supported, file_category = DocumentProcessor.is_supported_format(file.filename)
    if not is_supported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format. Supported: PDF, PNG, JPG, JPEG, WEBP, BMP, TIFF",
        )

    logger.info("POST /upload-document | user_id=%s | filename=%s | type=%s", 
                user_id, file.filename, file_category)

    # Read file bytes
    try:
        file_bytes = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read the uploaded file.")

    # Process document with FREE multi-modal processor (OCR only, no API costs)
    try:
        processed = doc_processor.process_file(file_bytes, file.filename)
        
        if not processed.text.strip():
            raise HTTPException(
                status_code=422,
                detail="No content could be extracted from this file. The file may be corrupted or empty.",
            )
        
        logger.info(
            "Processed %s: %d chars text, %d tables, %d images (FREE OCR)",
            file.filename,
            len(processed.text),
            len(processed.tables),
            len(processed.images)
        )
        
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as exc:
        logger.error("Document processing failed: %s", exc)
        raise HTTPException(
            status_code=422,
            detail=f"Could not process the document: {str(exc)}",
        )

    # Chunk and store with user_id
    try:
        chunks = chunk_text(processed.text)
        stored = store_chunks(chunks, user_id)
        logger.info("POST /upload-document | stored %d chunks for user_id=%s.", stored, user_id)
    except Exception as exc:
        logger.error("POST /upload-document | store error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Content extracted but failed to store. Please try again.",
        )

    # Build response message
    message_parts = [f"✅ '{file.filename}' processed successfully (FREE OCR):"]
    
    if processed.metadata.get("total_pages"):
        message_parts.append(f"📄 {processed.metadata['total_pages']} pages")
    
    if processed.metadata.get("tables_found", 0) > 0:
        message_parts.append(f"📊 {processed.metadata['tables_found']} tables extracted")
    
    if processed.metadata.get("images_found", 0) > 0:
        message_parts.append(f"🔍 {processed.metadata['images_found']} images OCR'd")
    
    if processed.metadata.get("processing") == "full_ocr":
        message_parts.append("🔍 Full OCR applied (scanned document)")
    
    message_parts.append(f"💾 {stored} chunks stored")
    message_parts.append("💰 Cost: $0.00 (FREE)")

    return {
        "status": "ok",
        "filename": file.filename,
        "file_type": file_category,
        "chunks": stored,
        "metadata": processed.metadata,
        "message": " • ".join(message_parts),
    }


# Legacy endpoint for backward compatibility
@app.post("/upload-pdf", tags=["documents"])
async def upload_pdf_legacy(
    file: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
):
    """
    Legacy PDF upload endpoint - redirects to new multi-format endpoint.
    Kept for backward compatibility with existing frontend.
    """
    return await upload_document(file, authorization)


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
            "status": "ok",
            "deleted": deleted,
            "message": f"🗑️ {deleted} document chunk(s) permanently deleted.",
        }
    except Exception as exc:
        logger.error("DELETE /clear-user-documents | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to delete documents. Please try again.",
        )