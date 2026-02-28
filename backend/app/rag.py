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
# Constants  (DO NOT CHANGE — working configuration)
# ---------------------------------------------------------------------------
EMBEDDING_MODEL      = "all-MiniLM-L6-v2"   # dim = 384
GROQ_MODEL           = "llama-3.3-70b-versatile"
SIMILARITY_THRESHOLD = 1.0                   # cosine DISTANCE 0-2: < 1.2 keeps related docs
TOP_K                = 3                     # max chunks to retrieve
CHUNK_SIZE           = 500                   # target tokens per chunk
CHUNK_OVERLAP        = 50                    # overlap tokens between consecutive chunks

# ---------------------------------------------------------------------------
# Model & Groq client — loaded once at import time
# ---------------------------------------------------------------------------
embedding_model = SentenceTransformer(EMBEDDING_MODEL)
groq_client     = Groq(api_key=GROQ_API_KEY)

# ---------------------------------------------------------------------------
# Text chunking  (unchanged)
# ---------------------------------------------------------------------------

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping word-level chunks of ~chunk_size tokens."""
    words = text.split()
    if not words:
        return []

    target_words = int(chunk_size * 0.75)
    overlap_words = int(overlap * 0.75)

    chunks = []
    start = 0
    while start < len(words):
        end = min(start + target_words, len(words))
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end == len(words):
            break
        start += target_words - overlap_words

    logger.info("Chunked text into %d chunk(s).", len(chunks))
    return chunks


# ---------------------------------------------------------------------------
# Embedding helpers  (unchanged)
# ---------------------------------------------------------------------------

def generate_embedding(text_content: str) -> list[float]:
    """Return a 384-dim embedding vector for the given text."""
    embedding = embedding_model.encode(text_content)
    return embedding.tolist()


# ---------------------------------------------------------------------------
# Document storage  (CHANGED: now accepts user_id)
# ---------------------------------------------------------------------------

def store_document(content: str, user_id: str) -> None:
    """Embed and persist a single document chunk with its owner user_id."""
    logger.info("Storing chunk (%d chars) for user_id=%s", len(content), user_id)
    embedding = generate_embedding(content)
    try:
        with engine.connect() as conn:
            conn.execute(
                text(
                    "INSERT INTO documents (content, embedding, user_id) "
                    "VALUES (:content, CAST(:embedding AS vector), :user_id)"
                ),
                {"content": content, "embedding": str(embedding), "user_id": user_id},
            )
            conn.commit()
        logger.info("Chunk stored successfully.")
    except Exception as exc:
        logger.error("Failed to store chunk: %s", exc)
        raise


def store_chunks(chunks: list[str], user_id: str) -> int:
    """Embed and persist multiple chunks. Returns count stored."""
    stored = 0
    for i, chunk in enumerate(chunks):
        if not chunk.strip():
            continue
        logger.info("Storing chunk %d/%d…", i + 1, len(chunks))
        store_document(chunk, user_id)
        stored += 1
    logger.info("Stored %d chunk(s) for user_id=%s.", stored, user_id)
    return stored


# ---------------------------------------------------------------------------
# Document deletion  (NEW)
# ---------------------------------------------------------------------------

def delete_user_documents(user_id: str) -> int:
    """Delete ALL documents belonging to user_id. Returns number of rows deleted."""
    logger.info("Deleting all documents for user_id=%s", user_id)
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text("DELETE FROM documents WHERE user_id = :user_id"),
                {"user_id": user_id},
            )
            conn.commit()
            deleted = result.rowcount
        logger.info("Deleted %d document(s) for user_id=%s.", deleted, user_id)
        return deleted
    except Exception as exc:
        logger.error("Failed to delete documents for user_id=%s: %s", user_id, exc)
        raise


# ---------------------------------------------------------------------------
# Vector search  (CHANGED: filters by user_id)
# ---------------------------------------------------------------------------

def search_similar(query: str, user_id: str) -> list[str]:
    """
    Return up to TOP_K chunks owned by user_id whose cosine distance
    to the query embedding is below SIMILARITY_THRESHOLD.
    """
    logger.info("Searching docs for user_id=%s | query=%r", user_id, query[:80])
    query_embedding = generate_embedding(query)

    try:
        with engine.connect() as conn:
            result = conn.execute(
                text(
                    """
                    SELECT content,
                           embedding <=> CAST(:embedding AS vector) AS distance
                    FROM   documents
                    WHERE  user_id = :user_id
                    ORDER  BY distance
                    LIMIT  :limit
                    """
                ),
                {"embedding": str(query_embedding), "limit": TOP_K, "user_id": user_id},
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
# Groq response generators  (unchanged)
# ---------------------------------------------------------------------------

def _rag_response(context_docs: list[str], user_message: str) -> str:
    """Generate an answer grounded in retrieved document chunks. Never says 'I cannot find...'"""
    context_text = "\n\n---\n\n".join(context_docs)
    logger.info("Calling Groq in RAG mode with %d chunk(s).", len(context_docs))

    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a retrieval-augmented AI assistant.\n\n"
                    "Respond in clean Markdown format.\n\n"
                    "Formatting Rules:\n"
                    "- Use headings (##) when appropriate.\n"
                    "- Use bullet points for lists.\n"
                    "- Use **bold** for key terms.\n"
                    "- Use code blocks for technical content.\n"
                    "- Add proper spacing between sections.\n\n"
                    "Context Usage Rules:\n"
                    "1. Use ONLY the information relevant to the user's question.\n"
                    "2. Do NOT continue into the next section of the document.\n"
                    "3. Do NOT summarize unrelated content even if it appears in the context.\n"
                    "4. Extract only the portion that directly answers the question.\n"
                    "5. If context is insufficient, clearly answer using general knowledge.\n\n"
                    f"Context:\n{context_text}"
                ),
            },
            {"role": "user", "content": user_message},
        ],
        temperature=0.3,
    )
    return completion.choices[0].message.content


def _fallback_response(user_message: str) -> str:
    """Generate a general AI response when no relevant documents exist."""
    logger.info("Calling Groq in Fallback mode.")

    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful AI assistant.\n\n"
                    "Respond in clean Markdown format.\n\n"
                    "Formatting Rules:\n"
                    "- Use headings (##) when appropriate.\n"
                    "- Use bullet points for lists.\n"
                    "- Use **bold** for key terms.\n"
                    "- Use code blocks for technical explanations.\n"
                    "- Add proper spacing between sections.\n\n"
                    "Provide a structured, readable, and professional answer."
                ),
            },
            {"role": "user", "content": user_message},
        ],
        temperature=0.7,
    )
    return completion.choices[0].message.content


# ---------------------------------------------------------------------------
# Public entry point  (CHANGED: user_id-aware routing)
# ---------------------------------------------------------------------------

def process_chat(user_message: str, user_id: str | None = None) -> dict:
    """
    Smart dual-mode RAG handler.

    Decision tree:
      1. user_id is None  → PUBLIC mode  → skip search → fallback (mode="fallback")
      2. user_id is set   → AUTHENTICATED mode:
           a. Search user's documents
           b. Relevant chunks found → RAG       (mode="rag")
           c. No relevant chunks   → fallback   (mode="fallback")

    Both modes always return a useful answer — never a refusal.
    Returns: {"mode": "rag"|"fallback", "response": "..."}
    """
    # Public mode: not logged in → always fallback
    if user_id is None:
        logger.info("Mode: FALLBACK (public — no auth).")
        return {"mode": "fallback", "response": _fallback_response(user_message)}

    # Authenticated mode: search user's own documents
    context_docs = search_similar(user_message, user_id)

    if context_docs:
        logger.info("Mode: RAG (%d relevant chunk(s) found for user %s).", len(context_docs), user_id)
        return {"mode": "rag", "response": _rag_response(context_docs, user_message)}

    logger.info("Mode: FALLBACK (no relevant chunks for user %s).", user_id)
    return {"mode": "fallback", "response": _fallback_response(user_message)}


# ---------------------------------------------------------------------------
# Session Summarization  (NEW)
# ---------------------------------------------------------------------------

def generate_session_summary(chat_history: list[dict]) -> str:
    """
    Given a list of chat messages, generate a professional summary of the session.
    """
    logger.info("Generating session summary from %d messages.", len(chat_history))
    
    # Format the chat history for the prompt
    history_text = ""
    for msg in chat_history:
        role = msg.get("role", "unknown").upper()
        text = msg.get("text", "")
        mode = msg.get("mode", "")
        mode_str = f" [Context: {mode.upper()}]" if mode else ""
        history_text += f"{role}{mode_str}: {text}\n\n"
        
    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a professional AI assistant tasked with summarizing a user's chat session.\n\n"
                    "Analyze the provided chat history and generate a concise, professional summary.\n"
                    "Identify:\n"
                    "1. The general topic or purpose of the session.\n"
                    "2. The top 3 key insights discussed.\n"
                    "3. If any documents were explicitly mentioned or used (flagged by 'RAG' context), note them.\n\n"
                    "Format the output strictly in Markdown using headings and bullet points."
                ),
            },
            {"role": "user", "content": f"Here is the chat history:\n\n{history_text}"},
        ],
        temperature=0.3,
    )
    return completion.choices[0].message.content