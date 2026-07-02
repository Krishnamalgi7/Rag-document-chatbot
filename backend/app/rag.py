import logging
import time
import re
from typing import AsyncGenerator

from sentence_transformers import SentenceTransformer, CrossEncoder
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
EMBEDDING_MODEL      = "all-MiniLM-L6-v2"                       # dim = 384
RERANKER_MODEL       = "cross-encoder/ms-marco-MiniLM-L-6-v2"   # re-ranking model
GROQ_MODEL           = "llama-3.3-70b-versatile"
SIMILARITY_THRESHOLD = 0.7               # cosine DISTANCE cutoff (0-2, lower = more similar)
SOFT_THRESHOLD       = 0.9               # relaxed threshold for soft retry
TOP_K                = 5                 # chunks retrieved before re-ranking
FINAL_TOP_K          = 3                 # chunks passed to Groq after re-ranking
CHUNK_SIZE           = 500               # target tokens per chunk
CHUNK_OVERLAP        = 50                # overlap tokens between chunks
MAX_HISTORY_MESSAGES = 20                # cap for session summary
CHAT_HISTORY_WINDOW  = 6                 # recent messages injected into Groq context
GROQ_MAX_RETRIES     = 3                 # retry attempts on Groq API failure

# ---------------------------------------------------------------------------
# Models & Groq client — loaded once at import time
# ---------------------------------------------------------------------------
embedding_model = SentenceTransformer(EMBEDDING_MODEL)
reranker_model  = CrossEncoder(RERANKER_MODEL)
groq_client     = Groq(api_key=GROQ_API_KEY)


# ===========================================================================
# 1. OCR QUALITY PREPROCESSING
# ===========================================================================

def clean_ocr_text(raw_text: str) -> str:
    """
    Clean noisy OCR output before chunking.
    Always call this before chunk_text() for scanned docs and images.

    Fixes:
      - Excessive blank lines
      - Non-ASCII noise characters
      - Multiple consecutive spaces
      - Hyphenated line breaks  (e.g. rec-\\nord → record)
      - Lines that break mid-sentence
    """
    raw_text = re.sub(r'\n{3,}', '\n\n', raw_text)         # collapse excessive blank lines
    raw_text = re.sub(r'[^\x00-\x7F]+', ' ', raw_text)     # remove non-ASCII noise
    raw_text = re.sub(r'\s{2,}', ' ', raw_text)             # collapse multiple spaces
    raw_text = re.sub(r'(\w)-\n(\w)', r'\1\2', raw_text)    # fix hyphenated line breaks
    raw_text = re.sub(r'\n([a-z])', r' \1', raw_text)       # join mid-sentence line breaks
    logger.info("OCR text cleaned. Length: %d chars.", len(raw_text))
    return raw_text.strip()


# ===========================================================================
# 2. TEXT CHUNKING
# ===========================================================================

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """
    Split text into overlapping word-level chunks.
    Effective chunk ≈ 375 words (chunk_size * 0.75), overlap ≈ 37 words.
    For OCR/scanned docs, always call clean_ocr_text() first.
    """
    words = text.split()
    if not words:
        return []

    target_words  = int(chunk_size * 0.75)
    overlap_words = int(overlap * 0.75)

    chunks = []
    start  = 0
    while start < len(words):
        end   = min(start + target_words, len(words))
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end == len(words):
            break
        start += target_words - overlap_words

    logger.info("Chunked text into %d chunk(s).", len(chunks))
    return chunks


# ===========================================================================
# 3. EMBEDDING HELPERS
# ===========================================================================

def generate_embedding(text_content: str) -> list[float]:
    """Return a 384-dim embedding vector for the given text."""
    return embedding_model.encode(text_content).tolist()


# ===========================================================================
# 4. GROQ CALL WITH RETRY + EXPONENTIAL BACKOFF
# ===========================================================================

def _call_groq_with_retry(messages: list[dict], temperature: float = 0.3) -> str:
    """
    Call Groq API with automatic retry on failure.
    Backoff: 1s → 2s → 4s between attempts.
    """
    for attempt in range(GROQ_MAX_RETRIES):
        try:
            completion = groq_client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages,
                temperature=temperature,
            )
            return completion.choices[0].message.content
        except Exception as exc:
            logger.warning(
                "Groq attempt %d/%d failed: %s",
                attempt + 1, GROQ_MAX_RETRIES, exc,
            )
            if attempt == GROQ_MAX_RETRIES - 1:
                logger.error("Groq API failed after %d attempts.", GROQ_MAX_RETRIES)
                raise
            wait = 2 ** attempt   # 1s → 2s → 4s
            logger.info("Retrying in %ds…", wait)
            time.sleep(wait)


# ===========================================================================
# 5. DOCUMENT STORAGE  (unchanged — works with existing schema)
# ===========================================================================

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


def store_chunks(
    chunks: list[str],
    user_id: str,
    on_progress=None,          # optional callable(chunks_done: int, total: int)
) -> int:
    """
    Embed and persist multiple chunks. Returns count stored.

    on_progress parameter (optional)
    ---------------------------------
    If provided, called after EACH chunk is successfully stored.
    Signature: on_progress(chunks_done: int, total_non_empty: int)

    The background upload task uses this to update the job's progress
    percentage in real time as embeddings are generated and saved.

    All existing callers that don't pass on_progress continue to work
    unchanged — the default is None and the callback is never invoked.

    WHY NOT MAKE THIS ASYNC?
    -------------------------
    store_document() uses SQLAlchemy's synchronous engine. The entire
    document-processing pipeline is CPU/IO-bound synchronous code. The
    BackgroundTask wrapper runs it in a thread, so sync is correct here.
    """
    # Count only non-empty chunks so the progress denominator is accurate
    non_empty = [c for c in chunks if c.strip()]
    total      = len(non_empty)
    stored     = 0

    for i, chunk in enumerate(non_empty):
        logger.info("Storing chunk %d/%d…", i + 1, total)
        store_document(chunk, user_id)
        stored += 1
        # Report progress after each chunk so the frontend progress bar moves
        if on_progress is not None:
            try:
                on_progress(stored, total)
            except Exception as cb_exc:
                # Never let a progress callback crash the actual storage loop
                logger.warning(
                    "on_progress callback raised an exception (ignored): %s",
                    cb_exc,
                )

    logger.info("Stored %d chunk(s) for user_id=%s.", stored, user_id)
    return stored


# ===========================================================================
# 6. DOCUMENT DELETION  (unchanged)
# ===========================================================================

def delete_user_documents(user_id: str) -> int:
    """Delete ALL documents for user_id. Returns rows deleted."""
    logger.info("Deleting all documents for user_id=%s", user_id)
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text("DELETE FROM documents WHERE user_id = :user_id"),
                {"user_id": user_id},
            )
            conn.commit()
            deleted = result.rowcount
        logger.info("Deleted %d doc(s) for user_id=%s.", deleted, user_id)
        return deleted
    except Exception as exc:
        logger.error("Failed to delete documents for user_id=%s: %s", user_id, exc)
        raise


# ===========================================================================
# 7. QUERY EXPANSION
# ===========================================================================

def expand_query(user_message: str) -> str:
    """
    Rephrase vague user queries into keyword-rich search queries using Groq.
    Improves retrieval for conversational or ambiguous questions.

    Example:
        "what did it say about payment?" → "payment terms methods refund policy"

    Falls back to original query if Groq call fails.
    """
    logger.info("Expanding query: %r", user_message[:80])
    try:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a search query optimizer.\n"
                    "Rephrase the user's question into a concise, keyword-rich search query "
                    "suitable for document retrieval.\n"
                    "Return ONLY the rephrased query — no explanation, no punctuation at end."
                ),
            },
            {"role": "user", "content": user_message},
        ]
        expanded = _call_groq_with_retry(messages, temperature=0.1).strip()
        logger.info("Expanded query: %r", expanded[:80])
        return expanded
    except Exception as exc:
        logger.warning("Query expansion failed, using original: %s", exc)
        return user_message   # graceful fallback


# ===========================================================================
# 8. RE-RANKING
# ===========================================================================

def rerank_chunks(query: str, chunks: list[str]) -> list[str]:
    """
    Re-rank retrieved chunks using CrossEncoder for better relevance ordering.
    Returns top FINAL_TOP_K chunks sorted by relevance score (highest first).
    Falls back to original order if re-ranking fails.
    """
    if len(chunks) <= 1:
        return chunks[:FINAL_TOP_K]

    try:
        pairs  = [[query, chunk] for chunk in chunks]
        scores = reranker_model.predict(pairs)
        ranked = sorted(zip(scores, chunks), key=lambda x: x[0], reverse=True)
        result = [chunk for _, chunk in ranked][:FINAL_TOP_K]
        logger.info(
            "Re-ranked %d chunks → kept top %d. Best score: %.3f",
            len(chunks), len(result), ranked[0][0],
        )
        return result
    except Exception as exc:
        logger.warning("Re-ranking failed, using original order: %s", exc)
        return chunks[:FINAL_TOP_K]


# ===========================================================================
# 9. HYBRID SEARCH (vector + full-text) WITH SOFT RETRY
# ===========================================================================

def search_similar(query: str, user_id: str) -> tuple[list[str], float]:
    """
    Hybrid search: pgvector cosine similarity + PostgreSQL full-text search.
    Works with your existing Supabase schema — no changes needed.

    Scoring formula (lower = more relevant):
        hybrid_score = vec_distance * 0.7 + (1 - text_rank) * 0.3

    Soft retry: if strict threshold finds nothing, retries at SOFT_THRESHOLD.
    Falls back to pure vector search if full-text parsing fails.

    Returns: (chunks, avg_distance)
        avg_distance is used downstream for confidence scoring.

    Cosine distance scale:
        0.0 = identical
        0.3 = very similar   ← ideal matches
        0.7 = SIMILARITY_THRESHOLD cutoff
        1.0 = unrelated
        2.0 = opposite
    """
    logger.info("Hybrid search | user=%s | query=%r", user_id, query[:80])
    query_embedding = generate_embedding(query)

    # Sanitize query for PostgreSQL full-text search
    fts_query = re.sub(r'[^\w\s]', '', query).strip()
    fts_query = ' & '.join(fts_query.split()) if fts_query else query

    def _run_search(threshold: float, limit: int) -> list[tuple]:
        """Run hybrid search with given threshold. Falls back to pure vector on error."""
        try:
            with engine.connect() as conn:
                return conn.execute(
                    text(
                        """
                        SELECT
                            content,
                            embedding <=> CAST(:embedding AS vector) AS vec_distance,
                            COALESCE(
                                ts_rank(
                                    to_tsvector('english', content),
                                    to_tsquery('english', :fts_query)
                                ), 0
                            ) AS text_rank
                        FROM documents
                        WHERE user_id = :user_id
                          AND embedding <=> CAST(:embedding AS vector) < :threshold
                        ORDER BY
                            (embedding <=> CAST(:embedding AS vector)) * 0.7
                            + (1.0 - COALESCE(
                                ts_rank(
                                    to_tsvector('english', content),
                                    to_tsquery('english', :fts_query)
                                ), 0)
                            ) * 0.3
                        LIMIT :limit
                        """
                    ),
                    {
                        "embedding" : str(query_embedding),
                        "fts_query" : fts_query,
                        "user_id"   : user_id,
                        "threshold" : threshold,
                        "limit"     : limit,
                    },
                ).fetchall()
        except Exception as exc:
            logger.warning("Hybrid search error, falling back to pure vector: %s", exc)
            with engine.connect() as conn:
                return conn.execute(
                    text(
                        """
                        SELECT content,
                               embedding <=> CAST(:embedding AS vector) AS vec_distance,
                               0 AS text_rank
                        FROM   documents
                        WHERE  user_id  = :user_id
                          AND  embedding <=> CAST(:embedding AS vector) < :threshold
                        ORDER  BY vec_distance
                        LIMIT  :limit
                        """
                    ),
                    {
                        "embedding" : str(query_embedding),
                        "user_id"   : user_id,
                        "threshold" : threshold,
                        "limit"     : limit,
                    },
                ).fetchall()

    # Strict threshold search
    rows = _run_search(SIMILARITY_THRESHOLD, TOP_K)

    # Soft retry if nothing found
    if not rows:
        logger.info(
            "No chunks at strict threshold %.2f — soft retry at %.2f…",
            SIMILARITY_THRESHOLD, SOFT_THRESHOLD,
        )
        rows = _run_search(SOFT_THRESHOLD, 1)
        if rows:
            logger.info("Soft retry found %d chunk(s).", len(rows))

    if not rows:
        logger.info("No relevant chunks found for user=%s.", user_id)
        return [], 1.0   # avg_distance 1.0 signals no results

    chunks       = [row[0] for row in rows]
    distances    = [row[1] for row in rows]
    avg_distance = sum(distances) / len(distances)

    logger.info(
        "Retrieved %d chunk(s) | avg_distance=%.3f | user=%s",
        len(chunks), avg_distance, user_id,
    )
    return chunks, avg_distance


# ===========================================================================
# 10. CONFIDENCE SCORE
# ===========================================================================

def compute_confidence(avg_distance: float) -> str:
    """
    Convert average cosine distance to a human-readable confidence label.

    Distance scale:
        < 0.4  → High
        < 0.6  → Medium
        < 0.7  → Low
        >= 0.7 → Very Low
    """
    if avg_distance < 0.4:
        return "High"
    elif avg_distance < 0.6:
        return "Medium"
    elif avg_distance < 0.7:
        return "Low"
    else:
        return "Very Low"


# ===========================================================================
# 11. CHAT HISTORY INJECTION HELPER
# ===========================================================================

def _build_messages_with_history(
    system_prompt : str,
    user_message  : str,
    chat_history  : list[dict] | None,
) -> list[dict]:
    """
    Build Groq messages list with recent chat history for conversational context.
    Injects last CHAT_HISTORY_WINDOW messages before the current user message.

    Each history item expected format:
        {"role": "user" | "assistant", "text": "message content"}
    """
    messages = [{"role": "system", "content": system_prompt}]

    if chat_history:
        for msg in chat_history[-CHAT_HISTORY_WINDOW:]:
            role    = msg.get("role", "user")
            content = msg.get("text", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_message})
    return messages


# ===========================================================================
# 12. GROQ RESPONSE GENERATORS
# ===========================================================================

def _rag_response(
    context_docs : list[str],
    user_message : str,
    chat_history : list[dict] | None = None,
) -> str:
    """Generate an answer grounded in retrieved document chunks with chat history context."""
    context_text = "\n\n---\n\n".join(context_docs)
    logger.info("Calling Groq RAG mode | chunks=%d", len(context_docs))

    system_prompt = (
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
        "2. Do NOT summarize unrelated content from the context.\n"
        "3. Extract only the portion that directly answers the question.\n"
        "4. If context is insufficient, answer from general knowledge.\n"
        "5. Use recent conversation history to understand follow-up questions.\n\n"
        f"Document Context:\n{context_text}"
    )
    messages = _build_messages_with_history(system_prompt, user_message, chat_history)
    return _call_groq_with_retry(messages, temperature=0.3)


def _fallback_response(
    user_message : str,
    chat_history : list[dict] | None = None,
) -> str:
    """Generate a general AI response when no relevant document chunks exist."""
    logger.info("Calling Groq Fallback mode.")

    system_prompt = (
        "You are a helpful AI assistant.\n\n"
        "Respond in clean Markdown format.\n\n"
        "Formatting Rules:\n"
        "- Use headings (##) when appropriate.\n"
        "- Use bullet points for lists.\n"
        "- Use **bold** for key terms.\n"
        "- Use code blocks for technical explanations.\n"
        "- Add proper spacing between sections.\n\n"
        "Important: This answer is NOT based on any uploaded document. "
        "Clearly mention this at the very start of your response.\n\n"
        "Use recent conversation history to understand follow-up questions.\n\n"
        "Provide a structured, readable, and professional answer."
    )
    messages = _build_messages_with_history(system_prompt, user_message, chat_history)
    return _call_groq_with_retry(messages, temperature=0.7)


# ===========================================================================
# 13. STREAMING RESPONSE
# ===========================================================================

async def stream_rag_response(
    context_docs : list[str],
    user_message : str,
    chat_history : list[dict] | None = None,
) -> AsyncGenerator[str, None]:
    """
    Streaming version — yields tokens as they arrive from Groq.
    Use this in a FastAPI StreamingResponse endpoint.

    FastAPI usage example:
    -------------------------------------------------------------------------
    from fastapi.responses import StreamingResponse
    from app.rag import search_similar, rerank_chunks, expand_query, stream_rag_response

    @app.post("/chat/stream")
    async def chat_stream(request: ChatRequest):
        expanded        = expand_query(request.message)
        docs, _         = search_similar(expanded, request.user_id)
        docs            = rerank_chunks(expanded, docs)
        return StreamingResponse(
            stream_rag_response(docs, request.message, request.chat_history),
            media_type="text/plain"
        )
    -------------------------------------------------------------------------
    """
    is_rag       = bool(context_docs)
    context_text = "\n\n---\n\n".join(context_docs) if is_rag else ""

    system_prompt = (
        (
            "You are a retrieval-augmented AI assistant.\n"
            "Use ONLY the relevant parts of the document context to answer.\n"
            "Use conversation history for follow-up context.\n"
            f"Document Context:\n{context_text}"
        ) if is_rag else (
            "You are a helpful AI assistant. "
            "No document context is available — answer from general knowledge "
            "and clearly inform the user at the start of your response."
        )
    )

    messages = _build_messages_with_history(system_prompt, user_message, chat_history)

    try:
        stream = groq_client.chat.completions.create(
            model       = GROQ_MODEL,
            messages    = messages,
            temperature = 0.3 if is_rag else 0.7,
            stream      = True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta
    except Exception as exc:
        logger.error("Streaming failed: %s", exc)
        yield "\n\n⚠️ Streaming error. Please try again."


# ===========================================================================
# 14. PUBLIC ENTRY POINT  (fully backward compatible)
# ===========================================================================

def process_chat(
    user_message : str,
    user_id      : str | None        = None,
    chat_history : list[dict] | None = None,
) -> dict:
    """
    Smart dual-mode RAG handler with all enhancements.
    Fully backward compatible — existing calls without chat_history still work.

    Pipeline:
      Public (no user_id)  → fallback directly
      Authenticated        → expand query
                           → hybrid search (vector + full-text)
                           → re-rank chunks
                           → RAG if chunks found, else fallback

    Returns:
    {
        "mode"       : "rag" | "fallback",
        "response"   : "...",
        "confidence" : "High" | "Medium" | "Low" | "Very Low" | "N/A",
        "source"     : "📄 Answered from your document" |
                       "🤖 Answered from general AI knowledge"
    }

    chat_history format (each item):
        {"role": "user" | "assistant", "text": "...", "mode": "rag" | "fallback"}
    """
    # ── Public / unauthenticated ────────────────────────────────────────────
    if user_id is None:
        logger.info("Mode: FALLBACK (public).")
        return {
            "mode"       : "fallback",
            "response"   : _fallback_response(user_message, chat_history),
            "confidence" : "N/A",
            "source"     : "🤖 Answered from general AI knowledge",
        }

    # ── Step 1: Expand query ────────────────────────────────────────────────
    expanded_query = expand_query(user_message)

    # ── Step 2: Hybrid search ───────────────────────────────────────────────
    context_docs, avg_distance = search_similar(expanded_query, user_id)

    # ── Step 3: Re-rank ─────────────────────────────────────────────────────
    if context_docs:
        context_docs = rerank_chunks(expanded_query, context_docs)

    # ── Step 4: Confidence score ────────────────────────────────────────────
    confidence = compute_confidence(avg_distance) if context_docs else "N/A"

    # ── Step 5: RAG or fallback ─────────────────────────────────────────────
    if context_docs:
        logger.info(
            "Mode: RAG | chunks=%d | confidence=%s | user=%s",
            len(context_docs), confidence, user_id,
        )
        return {
            "mode"       : "rag",
            "response"   : _rag_response(context_docs, user_message, chat_history),
            "confidence" : confidence,
            "source"     : "📄 Answered from your document",
        }

    logger.info("Mode: FALLBACK (no relevant chunks) | user=%s", user_id)
    return {
        "mode"       : "fallback",
        "response"   : _fallback_response(user_message, chat_history),
        "confidence" : "N/A",
        "source"     : "🤖 Answered from general AI knowledge",
    }


# ===========================================================================
# 15. SESSION SUMMARIZATION
# ===========================================================================

def generate_session_summary(chat_history: list[dict]) -> str:
    """
    Generate a professional Markdown summary of the chat session.

    Truncation strategy for long sessions:
      <= MAX_HISTORY_MESSAGES → use all messages
      >  MAX_HISTORY_MESSAGES → keep first 5 (opening topic)
                                + last 15 (recent context)
                                Preserves what session started about AND how it ended.
    """
    original_count = len(chat_history)

    if original_count > MAX_HISTORY_MESSAGES:
        KEEP_START   = 5
        KEEP_END     = MAX_HISTORY_MESSAGES - KEEP_START   # 15
        opening      = chat_history[:KEEP_START]
        recent       = chat_history[-KEEP_END:]
        seen         = {id(m) for m in opening}
        recent       = [m for m in recent if id(m) not in seen]
        chat_history = opening + recent
        logger.info(
            "Long session (%d msgs) → truncated to first %d + last %d = %d for summary.",
            original_count, KEEP_START, len(recent), len(chat_history),
        )

    logger.info(
        "Generating summary from %d / %d message(s).",
        len(chat_history), original_count,
    )

    history_text = ""
    for msg in chat_history:
        role         = msg.get("role", "unknown").upper()
        content      = msg.get("text", "")
        mode         = msg.get("mode", "")
        mode_str     = f" [Context: {mode.upper()}]" if mode else ""
        history_text += f"{role}{mode_str}: {content}\n\n"

    messages = [
        {
            "role": "system",
            "content": (
                "You are a professional AI assistant summarizing a chat session.\n\n"
                "You may be given a partial history (opening + recent messages; middle omitted).\n"
                "Account for this when writing the summary.\n\n"
                "Generate a concise, professional Markdown summary covering:\n"
                "1. The general topic or purpose of the session.\n"
                "2. The top 3 key insights discussed.\n"
                "3. Documents used (flagged by 'RAG' context), if any.\n"
                "4. If truncated, note that the summary covers the start and end of the session.\n\n"
                "Format strictly in Markdown with headings and bullet points."
            ),
        },
        {
            "role"   : "user",
            "content": f"Chat history:\n\n{history_text}",
        },
    ]
    return _call_groq_with_retry(messages, temperature=0.3)