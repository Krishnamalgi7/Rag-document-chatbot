import logging
from sentence_transformers import SentenceTransformer
from sqlalchemy import text
from app.database import engine
from app.config import GROQ_API_KEY
from groq import Groq

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EMBEDDING_MODEL      = "all-MiniLM-L6-v2"   # dim = 384
GROQ_MODEL           = "llama-3.1-8b-instant"
SIMILARITY_THRESHOLD = 1.2                   # cosine DISTANCE 0-2: < 1.2 keeps related docs
TOP_K                = 5                     # max chunks to retrieve
CHUNK_SIZE           = 500                   # target tokens per chunk (~4 chars/token ≈ 2000 chars)
CHUNK_OVERLAP        = 50                    # overlap tokens between consecutive chunks

# ---------------------------------------------------------------------------
# Model & Groq client — loaded once at import time
# ---------------------------------------------------------------------------
embedding_model = SentenceTransformer(EMBEDDING_MODEL)
groq_client     = Groq(api_key=GROQ_API_KEY)

# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """
    Split text into overlapping word-level chunks of ~chunk_size tokens.
    Uses word count as a proxy for token count (1 token ≈ 0.75 words).
    chunk_size=500 tokens → ~375 words per chunk.
    """
    words = text.split()
    if not words:
        return []

    target_words = int(chunk_size * 0.75)   # approximate words per chunk
    overlap_words = int(overlap * 0.75)

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + target_words, len(words))
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end == len(words):
            break
        start += target_words - overlap_words  # slide with overlap

    logger.info("Chunked text into %d chunk(s).", len(chunks))
    return chunks


# ---------------------------------------------------------------------------
# Embedding helpers
# ---------------------------------------------------------------------------

def generate_embedding(text_content: str) -> list[float]:
    """Return a 384-dim embedding vector for the given text."""
    embedding = embedding_model.encode(text_content)
    return embedding.tolist()


# ---------------------------------------------------------------------------
# Document storage
# ---------------------------------------------------------------------------

def store_document(content: str) -> None:
    """Embed and persist a single document chunk to the vector store."""
    logger.info("Storing document chunk (%d chars).", len(content))
    embedding = generate_embedding(content)
    try:
        with engine.connect() as conn:
            conn.execute(
                text(
                    "INSERT INTO documents (content, embedding) "
                    "VALUES (:content, CAST(:embedding AS vector))"
                ),
                {"content": content, "embedding": str(embedding)},
            )
            conn.commit()
        logger.info("Document chunk stored successfully.")
    except Exception as exc:
        logger.error("Failed to store document chunk: %s", exc)
        raise


def store_chunks(chunks: list[str]) -> int:
    """
    Embed and persist multiple chunks from a single document.
    Returns the number of chunks stored.
    """
    stored = 0
    for i, chunk in enumerate(chunks):
        if not chunk.strip():
            continue
        logger.info("Storing chunk %d/%d…", i + 1, len(chunks))
        store_document(chunk)
        stored += 1
    logger.info("Stored %d chunk(s) total.", stored)
    return stored


# ---------------------------------------------------------------------------
# Vector search with similarity threshold
# ---------------------------------------------------------------------------

def search_similar(query: str) -> list[str]:
    """
    Return up to TOP_K document chunks whose cosine distance to the query
    embedding is below SIMILARITY_THRESHOLD.
    """
    logger.info("Searching documents for: %r", query[:80])
    query_embedding = generate_embedding(query)

    try:
        with engine.connect() as conn:
            result = conn.execute(
                text(
                    """
                    SELECT content,
                           embedding <=> CAST(:embedding AS vector) AS distance
                    FROM   documents
                    ORDER  BY distance
                    LIMIT  :limit
                    """
                ),
                {"embedding": str(query_embedding), "limit": TOP_K},
            )
            rows = result.fetchall()
    except Exception as exc:
        logger.error("Vector search failed: %s", exc)
        raise

    relevant = [row[0] for row in rows if row[1] < SIMILARITY_THRESHOLD]
    logger.info(
        "Retrieved %d / %d chunks within threshold %.2f",
        len(relevant), len(rows), SIMILARITY_THRESHOLD,
    )
    return relevant


# ---------------------------------------------------------------------------
# Groq response generators
# ---------------------------------------------------------------------------

def _rag_response(context_docs: list[str], user_message: str) -> str:
    """Generate an answer grounded in retrieved document chunks."""
    context_text = "\n\n---\n\n".join(context_docs)
    logger.info("Calling Groq in RAG mode with %d chunk(s).", len(context_docs))

    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful AI assistant.\n\n"
                    "Use the provided document context to answer the user's question accurately.\n"
                    "Prioritize the context. If the context does not contain the answer, "
                    "use your general knowledge to provide a helpful response.\n\n"
                    f"Context:\n{context_text}"
                ),
            },
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
    )
    return completion.choices[0].message.content


def _fallback_response(user_message: str) -> str:
    """Generate a general AI response when no relevant documents exist."""
    logger.info("Calling Groq in Fallback mode.")

    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful AI assistant."},
            {"role": "user", "content": user_message},
        ],
        temperature=0.7,
    )
    return completion.choices[0].message.content


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def process_chat(user_message: str) -> dict:
    """
    Dual-mode RAG chat handler.
    Returns: {"mode": "rag"|"fallback", "response": "..."}
    """
    context_docs = search_similar(user_message)

    if context_docs:
        return {"mode": "rag", "response": _rag_response(context_docs, user_message)}

    return {"mode": "fallback", "response": _fallback_response(user_message)}