"""
job_store.py — In-Memory Upload Job Registry
==============================================

PURPOSE
-------
Tracks the lifecycle of every document-upload job from the moment the
file arrives at the server until all background processing is done.

WHY IN-MEMORY (not Redis / SQLite)?
------------------------------------
Jobs only live for minutes. The server process is already running.
Adding Redis or a DB table just to store 60-second transient state
would be over-engineering. If the server restarts mid-job the user
will just re-upload (the job was seconds old anyway).

JOB LIFECYCLE
-------------
  create_job()          → status = "queued"
  update_job(...)       → status = any status below
  update_job(status="ready")  → terminal success state
  update_job(status="error")  → terminal failure state

STATUS VALUES
-------------
  queued      File stored, background task not yet started.
  extracting  PDF text / table extraction running.
  ocr         Tesseract OCR running on scanned pages or images.
  chunking    Splitting extracted text into overlapping chunks.
  embedding   SentenceTransformer encoding each chunk.
  saving      Writing embedding vectors to the database.
  ready       All done — RAG search is now active for this file.
  error       Something failed — see job["error"] for details.

THREAD SAFETY
-------------
FastAPI BackgroundTasks run in a thread pool (via asyncio.run_in_executor
or directly, depending on the task). We protect the shared dict with a
threading.Lock so concurrent jobs (rare but possible) don't corrupt each
other's state.

CLEANUP
-------
cleanup_old_jobs() removes jobs older than MAX_JOB_AGE_SECONDS.
Call it once per upload request so old entries don't accumulate forever.
"""

import threading
import time
import uuid
import logging

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

# Jobs older than this (seconds) are swept during cleanup.
# 3600 = 1 hour — plenty of time for any upload + processing to finish.
MAX_JOB_AGE_SECONDS = 3600

# ── Internal store ───────────────────────────────────────────────────────────

# The main data structure: { job_id (str) → job_record (dict) }
_jobs: dict[str, dict] = {}

# A reentrant lock so multiple threads can't corrupt the dict simultaneously.
# We use RLock (reentrant) so the same thread can acquire it more than once
# without deadlocking (useful if helper functions call each other).
_lock = threading.RLock()


# ── Public API ───────────────────────────────────────────────────────────────

def create_job(filename: str, user_id: str) -> str:
    """
    Register a new upload job and return its unique job_id.

    Called immediately after file validation, BEFORE the background task
    is scheduled. The frontend receives this job_id in the HTTP 202 response
    and uses it to poll the status endpoint.

    Parameters
    ----------
    filename : str
        The original uploaded filename (e.g., "report.pdf").
        Used for duplicate-detection via get_active_job_for_user_file().
    user_id : str
        The Supabase user UUID who owns this job.
        The status endpoint checks this to prevent one user reading
        another user's job state.

    Returns
    -------
    str
        A unique job ID (UUID4 hex string, 32 chars).
    """
    job_id = uuid.uuid4().hex  # e.g. "a3f1c9d2e0b847f6a1234567890abcde"

    job_record = {
        "job_id"     : job_id,
        "user_id"    : user_id,
        "filename"   : filename,
        # ── Status & progress ──────────────────────────────────────────────
        "status"     : "queued",   # always starts here
        "progress"   : 0,          # 0 – 100 integer
        "message"    : "⏳ Queued — waiting for background worker…",
        # ── Result data (filled on success) ───────────────────────────────
        "result"     : None,       # dict with chunks, metadata, etc.
        # ── Error data (filled on failure) ────────────────────────────────
        "error"      : None,       # human-readable error string
        # ── Per-stage timing measurements (seconds) ───────────────────────
        # Each key is filled in as the stage completes.
        "timings"    : {},
        # ── Housekeeping ──────────────────────────────────────────────────
        "created_at" : time.time(),  # Unix timestamp
    }

    with _lock:
        _jobs[job_id] = job_record

    logger.info(
        "[job_store] Created job_id=%s | user=%s | file=%s",
        job_id, user_id, filename,
    )
    return job_id


def update_job(job_id: str, **fields) -> None:
    """
    Update one or more fields of a job record atomically.

    Designed to be called from the background task at each stage
    transition. Passes keyword arguments directly into the job dict.

    Common usage examples
    ---------------------
    # Transition to a new status with descriptive message:
    update_job(job_id, status="extracting", progress=10,
               message="📄 Extracting text from PDF…")

    # Record a timing measurement after a stage completes:
    update_job(job_id, timings={**get_job(job_id)["timings"],
                                "extraction_s": 2.31})

    # Mark as complete with the final result dict:
    update_job(job_id, status="ready", progress=100,
               message="✅ Ready!", result={...})

    # Mark as failed:
    update_job(job_id, status="error", progress=0,
               message="❌ Processing failed.",
               error="pdfplumber: EOF marker not found")

    Parameters
    ----------
    job_id : str
        The job to update. Silently ignored if the job doesn't exist
        (avoids crashing the background task on a stale ID).
    **fields
        Any key(s) from the job record schema.
    """
    with _lock:
        if job_id not in _jobs:
            logger.warning(
                "[job_store] update_job called on unknown job_id=%s", job_id
            )
            return
        _jobs[job_id].update(fields)

    # Log the status transition (but not every tiny progress tick to avoid noise)
    if "status" in fields:
        logger.info(
            "[job_store] job_id=%s → status=%s  progress=%s%%  message=%s",
            job_id,
            fields["status"],
            fields.get("progress", "?"),
            fields.get("message", ""),
        )


def get_job(job_id: str) -> dict | None:
    """
    Return a copy of the job record, or None if the job_id is unknown.

    We return a COPY (via dict.copy()) so callers can't accidentally
    mutate the internal store without going through update_job().

    Parameters
    ----------
    job_id : str

    Returns
    -------
    dict | None
        A shallow copy of the job record, or None.
    """
    with _lock:
        job = _jobs.get(job_id)
        return job.copy() if job else None


def get_active_job_for_user_file(filename: str, user_id: str) -> str | None:
    """
    Return the job_id of an existing in-progress (non-terminal) job
    for the same user + filename combination, or None if none exists.

    PURPOSE — DUPLICATE UPLOAD PREVENTION
    ---------------------------------------
    If a user clicks "Upload" twice for the same file while the first
    job is still processing, we reuse the existing job_id instead of
    starting a second expensive OCR + embedding run.

    "Terminal" statuses (ready, error) are excluded: if a previous
    upload finished successfully or failed, the user is allowed to
    re-upload the same file.

    Parameters
    ----------
    filename : str
    user_id  : str

    Returns
    -------
    str | None
        Existing active job_id, or None if no active job exists.
    """
    # Terminal statuses — a job in these states is "done" and
    # should NOT be reused as the active job for a new upload.
    terminal_statuses = {"ready", "error"}

    with _lock:
        for jid, job in _jobs.items():
            if (
                job["user_id"]  == user_id
                and job["filename"] == filename
                and job["status"]   not in terminal_statuses
            ):
                logger.info(
                    "[job_store] Duplicate upload detected — reusing job_id=%s "
                    "for user=%s file=%s (status=%s)",
                    jid, user_id, filename, job["status"],
                )
                return jid

    return None


def cleanup_old_jobs() -> int:
    """
    Delete jobs older than MAX_JOB_AGE_SECONDS from the in-memory store.

    WHY NEEDED?
    -----------
    Without cleanup, the dict grows indefinitely (one entry per upload
    over the entire server lifetime). Since jobs are small dicts (~1 KB),
    this is only a memory concern for very long-running servers, but
    it's good practice to clean up anyway.

    WHEN CALLED?
    ------------
    Called at the start of each POST /upload-document request. This gives
    a "lazy cleanup" — we only sweep when there's actual upload traffic,
    not on a background timer. This keeps the code simple.

    Returns
    -------
    int
        Number of jobs removed.
    """
    cutoff = time.time() - MAX_JOB_AGE_SECONDS
    removed = 0

    with _lock:
        expired_ids = [
            jid for jid, job in _jobs.items()
            if job["created_at"] < cutoff
        ]
        for jid in expired_ids:
            del _jobs[jid]
            removed += 1

    if removed:
        logger.info(
            "[job_store] Cleaned up %d expired job(s) (older than %ds).",
            removed, MAX_JOB_AGE_SECONDS,
        )

    return removed
