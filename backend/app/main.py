import io
import logging
import logging.config
import pdfplumber
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.rag import process_chat, store_document, chunk_text, store_chunks

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
app = FastAPI(title="MyChatbot API", version="1.0.0")

# ---------------------------------------------------------------------------
# CORS — allow all origins in development
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
# Routes
# ---------------------------------------------------------------------------

@app.get("/", tags=["health"])
def root():
    logger.info("Health check hit.")
    return {"status": "ok", "message": "MyChatbot API is running 🚀"}


@app.post("/rag-chat", tags=["chat"])
def rag_chat(request: ChatRequest):
    """
    Dual-mode RAG endpoint.
    Returns {"mode": "rag"|"fallback", "response": "..."}
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    logger.info("POST /rag-chat | message=%r", request.message[:80])

    try:
        result = process_chat(request.message)
        logger.info("POST /rag-chat | mode=%s", result["mode"])
        return result
    except Exception as exc:
        logger.error("POST /rag-chat | error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Something went wrong while processing your message. Please try again.",
        )


@app.post("/upload-pdf", tags=["documents"])
async def upload_pdf(file: UploadFile = File(...)):
    """
    Accept a PDF file, extract text, chunk it, embed each chunk,
    and store all chunks in the vector store.
    """
    # Validate file type
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted. Please upload a .pdf file.",
        )

    logger.info("POST /upload-pdf | filename=%s | size=%s", file.filename, file.size)

    # Read file bytes
    try:
        pdf_bytes = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read the uploaded file.")

    # Extract text from PDF
    try:
        text_pages = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total_pages = len(pdf.pages)
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_pages.append(page_text.strip())

        full_text = "\n\n".join(text_pages)
        logger.info(
            "Extracted text from %d/%d pages (%d chars).",
            len(text_pages), total_pages, len(full_text),
        )
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

    # Chunk and store
    try:
        chunks = chunk_text(full_text)
        stored = store_chunks(chunks)
        logger.info("POST /upload-pdf | stored %d chunks from '%s'.", stored, file.filename)
    except Exception as exc:
        logger.error("POST /upload-pdf | store error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Text extracted but failed to store in the database. Please try again.",
        )

    return {
        "status":   "ok",
        "filename": file.filename,
        "pages":    total_pages,
        "chunks":   stored,
        "message":  f"✅ '{file.filename}' processed: {total_pages} pages → {stored} chunks stored.",
    }