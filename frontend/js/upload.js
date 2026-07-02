/* =========================================================
   upload.js — FILE SELECTION & DOCUMENT UPLOAD (v4 — Async)
   =========================================================

   WHAT CHANGED IN v4
   -------------------
   Previously (v3): Upload was synchronous.
     1. User picks file.
     2. uploadDocumentToServer() is called.
     3. The browser waits 5–60 seconds for OCR + embedding + DB save.
     4. One success/error message is shown.

   Now (v4): Upload is two-phase asynchronous.
     PHASE 1 — Upload (~200ms):
       Send the file to the backend.
       Backend validates, saves to temp file, creates a job, returns
       HTTP 202 immediately with { job_id }.

     PHASE 2 — Progress Polling (every 2 seconds):
       Call GET /upload-document/status/{job_id} repeatedly.
       Map each backend status to a user-friendly message and a
       progress bar percentage.
       Stop when status is "ready" or "error".

   WHY THIS IS BETTER
   -------------------
   1. The browser never freezes — the UI stays fully responsive.
   2. The user sees exactly what the server is doing (OCR, embedding…).
   3. Network timeouts can't kill OCR/embedding — they run on the server.
   4. The progress bar gives realistic feedback on slow documents.

   FILES INVOLVED
   ---------------
   upload.js    — this file  (UI logic + polling loop)
   api.js       — uploadDocumentToServer(), pollUploadStatus()
   chat.css     — .upload-progress-* styles for the progress bar
   chat.html    — #progress-bar-container, #progress-bar-fill, etc.
   ========================================================= */

import { uploadDocumentToServer, pollUploadStatus } from "./api.js";


// ── Constants ─────────────────────────────────────────────
// How often to poll the status endpoint (milliseconds).
// 2000ms = 2 seconds. Balances responsiveness vs. server load.
// At 2s polling, a 30-second OCR job generates ~15 HTTP requests — negligible.
const POLL_INTERVAL_MS = 2000;

// Maximum number of consecutive poll failures before giving up.
// Each failure is logged. After MAX_POLL_FAILURES, we stop polling and show an error.
const MAX_POLL_FAILURES = 5;

// Allowed file extensions (must match backend's SUPPORTED_FORMATS dict)
const ALLOWED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"];

// Maps each backend status value to the percentage shown on the progress bar.
// These are STARTING values — the backend's own "progress" field may give
// finer-grained values during embedding/saving.
const STATUS_PROGRESS = {
  queued     : 5,
  extracting : 25,
  ocr        : 45,
  chunking   : 60,
  embedding  : 70,
  saving     : 88,
  ready      : 100,
  error      : 0,
};

// Maps backend status to the label shown in the progress bar.
const STATUS_MESSAGES = {
  queued     : "Queued",
  extracting : "Extracting text",
  ocr        : "Running OCR",
  chunking   : "Chunking document",
  embedding  : "Generating embeddings",
  saving     : "Saving to knowledge base",
  ready      : "Ready",
  error      : "Processing failed",
};


// ── Module-level state ────────────────────────────────────
// These are module-scoped variables. No frameworks or state-management
// libraries needed — just plain variables tracked between function calls.

let selectedFile   = null;    // The File object the user has selected
let isUploading    = false;   // True during Phase 1 AND Phase 2 (prevents double-click)
let pollIntervalId = null;    // setInterval handle so we can clearInterval() it later
let pollFailures   = 0;       // Consecutive polling failures counter


// ── initUpload ────────────────────────────────────────────
//
// WHAT IT DOES:
//   Attaches all event listeners for the file upload UI.
//   Called once from chat.js when the page loads.
//
// PARAMETERS:
//   elements — object containing all upload-related DOM element refs
//
export function initUpload(elements) {
  const { dropZone, fileInput, btnUpload, getAccessToken } = elements;

  // Click the drop zone → open OS file picker
  dropZone.addEventListener("click", function () {
    if (!selectedFile) {
      fileInput.click();
    }
  });

  // User selects file via OS picker → handle it
  fileInput.addEventListener("change", function (event) {
    const chosenFile = event.target.files[0];
    if (chosenFile) {
      handleFileSelection(chosenFile, elements);
    }
  });

  // Drag-and-drop — three events are needed:
  // 1. dragover — must preventDefault() or drop won't fire
  dropZone.addEventListener("dragover", function (event) {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });

  // 2. dragleave — remove visual highlight
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("dragging");
  });

  // 3. drop — get the file and handle it
  dropZone.addEventListener("drop", function (event) {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    const droppedFile = event.dataTransfer.files[0];
    if (droppedFile) {
      handleFileSelection(droppedFile, elements);
    }
  });

  // Upload button click → start the two-phase upload
  btnUpload.addEventListener("click", function () {
    const currentToken = getAccessToken();
    handleUpload(currentToken, elements);
  });
}


// ── handleFileSelection ───────────────────────────────────
//
// WHAT IT DOES:
//   Validates the file type, stores the file, updates the drop zone UI.
//   Called when the user picks a file via the picker OR drag-drops one.
//
export function handleFileSelection(file, elements) {
  const { uploadFeedback } = elements;

  // Frontend validation (backend also validates — defence in depth)
  const fileName  = file.name.toLowerCase();
  const isAllowed = ALLOWED_EXTENSIONS.some(function (ext) {
    return fileName.endsWith(ext);
  });

  if (!isAllowed) {
    showUploadFeedback(uploadFeedback, "error", "Only PDF and image files are accepted.");
    clearSelectedFile(elements);
    return;
  }

  selectedFile = file;
  updateDropZoneWithFile(file, elements);
}


// ── handleUpload ──────────────────────────────────────────
//
// WHAT IT DOES:
//   Orchestrates the full two-phase async upload flow.
//
//   Phase 1: send file → get job_id → start Phase 2
//   Phase 2: poll status every 2s → update progress bar → stop on done/error
//
// WHY ASYNC?
//   We use "await" to wait for the fetch() calls in api.js.
//   The function is async so the browser doesn't block while waiting.
//
async function handleUpload(accessToken, elements) {
  const { btnUpload, uploadFeedback } = elements;

  // Guard conditions
  if (!selectedFile) return;   // No file chosen
  if (isUploading)   return;   // Already in progress
  if (!accessToken)  return;   // Not logged in

  // ── PHASE 1: Upload the file ───────────────────────────────────────────────
  isUploading = true;
  pollFailures = 0;

  // Disable the button and show uploading state
  btnUpload.disabled    = true;
  btnUpload.textContent = "Uploading…";

  // Hide any previous feedback/progress bar
  hideUploadFeedback(uploadFeedback);
  hideProgressBar(elements);

  let jobId = null;

  try {
    // Send the file to the backend.
    // This returns in ~200ms with { job_id, status: "queued", filename }.
    const initialResponse = await uploadDocumentToServer(selectedFile, accessToken);
    jobId = initialResponse.job_id;

    if (!jobId) {
      throw new Error("Server did not return a job ID.");
    }

  } catch (uploadError) {
    // Phase 1 failed — show error immediately (no polling needed)
    let errorMsg = uploadError.message;
    if (errorMsg.includes("Failed to fetch")) {
      errorMsg = "Cannot reach the server. Is the backend running?";
    } else {
      errorMsg = uploadError.message;
    }
    showUploadFeedback(uploadFeedback, "error", errorMsg);
    _resetUploadState(elements);
    return;
  }

  // Phase 1 succeeded — clear the file selection immediately
  // (the job is running on the server; the local file object is no longer needed)
  clearSelectedFile(elements);

  // Show the progress bar in its initial "queued" state
  showProgressBar(elements, STATUS_PROGRESS.queued, STATUS_MESSAGES.queued);
  btnUpload.textContent = "Processing…";

  // ── PHASE 2: Poll the status endpoint every 2 seconds ─────────────────────
  //
  // setInterval() schedules a function to run repeatedly at a fixed interval.
  // We save the interval ID so we can stop it with clearInterval() later.
  //
  // WHY setInterval INSTEAD OF A while LOOP?
  //   A while(true) loop with await would block the current async context.
  //   setInterval is non-blocking — it schedules callbacks on the event loop
  //   and returns immediately, keeping the UI fully responsive.
  //
  pollIntervalId = setInterval(async function () {
    try {
      const statusData = await pollUploadStatus(jobId, accessToken);
      _handleStatusUpdate(statusData, elements);
    } catch (pollError) {
      pollFailures += 1;
      console.warn("[upload] Poll failure #" + pollFailures + ":", pollError.message);

      if (pollFailures >= MAX_POLL_FAILURES) {
        // Too many consecutive failures — stop polling, show error
        _stopPolling();
        showUploadFeedback(
          uploadFeedback,
          "error",
          "Lost contact with server. The document may still be processing — refresh to check."
        );
        _resetUploadState(elements);
      }
    }
  }, POLL_INTERVAL_MS);
}


// ── _handleStatusUpdate ───────────────────────────────────
//
// WHAT IT DOES:
//   Processes a single status response from the polling interval.
//   Updates the progress bar and stops polling on terminal states.
//
// Called by: the setInterval callback in handleUpload()
//
function _handleStatusUpdate(statusData, elements) {
  const { uploadFeedback } = elements;
  const status   = statusData.status;
  const progress = statusData.progress || STATUS_PROGRESS[status] || 0;
  const message  = statusData.message  || STATUS_MESSAGES[status] || status;

  // Reset consecutive failure counter on any successful response
  pollFailures = 0;

  // Update the progress bar with the latest values
  updateProgressBar(elements, progress, message);

  // ── Terminal state: SUCCESS ───────────────────────────────────────────────
  if (status === "ready") {
    _stopPolling();

    // Extract the result info from the response
    const result    = statusData.result || {};
    const chunkInfo = result.chunks ? ` (${result.chunks} chunks)` : "";
    const timeInfo  = (result.timings && result.timings.total_s)
      ? ` in ${result.timings.total_s.toFixed(1)}s`
      : "";

    // Hide the progress bar and show the green success message
    hideProgressBar(elements);
    showUploadFeedback(
      uploadFeedback,
      "success",
      "Document ready" + chunkInfo + timeInfo + " — you can now ask questions about it."
    );

    // Auto-hide success message after 8 seconds
    setTimeout(function () {
      hideUploadFeedback(uploadFeedback);
    }, 8000);

    _resetUploadState(elements);
    return;
  }

  // ── Terminal state: ERROR ─────────────────────────────────────────────────
  if (status === "error") {
    _stopPolling();
    hideProgressBar(elements);

    const errorDetail = statusData.error || "Unknown error during processing.";
    showUploadFeedback(
      uploadFeedback,
      "error",
      "Processing failed: " + errorDetail
    );

    // Auto-hide error after 10 seconds
    setTimeout(function () {
      hideUploadFeedback(uploadFeedback);
    }, 10000);

    _resetUploadState(elements);
  }

  // Non-terminal statuses (queued, extracting, ocr, chunking, embedding, saving)
  // just update the progress bar and wait for the next poll.
}


// ── _stopPolling ──────────────────────────────────────────
// Clears the setInterval so polling stops.
function _stopPolling() {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}


// ── _resetUploadState ─────────────────────────────────────
// Resets the isUploading flag and restores the upload button to its default state.
function _resetUploadState(elements) {
  const { btnUpload } = elements;
  isUploading           = false;
  btnUpload.disabled    = true;      // stays disabled until a new file is selected
  btnUpload.textContent = "Upload to session";
}


// ── clearSelectedFile ─────────────────────────────────────
// Resets the drop zone back to its empty "Click or drag" placeholder.
function clearSelectedFile(elements) {
  const { dropZone, fileInput } = elements;

  selectedFile   = null;
  fileInput.value = "";

  dropZone.classList.remove("has-file");
  dropZone.innerHTML = `
    <div class="drop-zone-placeholder">
      <div class="drop-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
      </div>
      <span class="drop-text">Drop file or click to browse</span>
      <span class="drop-hint">.pdf .png .jpg .jpeg .webp .tiff</span>
    </div>
  `;
}


// ── updateDropZoneWithFile ────────────────────────────────
// Replaces the drop zone placeholder with file details + a remove (✕) button.
function updateDropZoneWithFile(file, elements) {
  const { dropZone, uploadFeedback, btnUpload } = elements;

  dropZone.classList.add("has-file");

  const fileSizeKB = (file.size / 1024).toFixed(1);

  dropZone.innerHTML = `
    <div class="file-selected">
      <div class="file-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
      </div>
      <div class="file-info">
        <span class="file-name" title="${file.name}">${file.name}</span>
        <span class="file-size">${fileSizeKB} KB</span>
      </div>
      <button class="btn-remove-file" id="btn-remove-file" title="Remove" aria-label="Remove file">&times;</button>
    </div>
  `;

  // Enable the upload button now that a valid file is selected
  btnUpload.disabled = false;

  // Wire the remove button (must be done AFTER innerHTML is set)
  const removeButton = document.getElementById("btn-remove-file");
  if (removeButton) {
    removeButton.addEventListener("click", function (event) {
      // stopPropagation prevents this click from also opening the file picker
      event.stopPropagation();
      clearSelectedFile(elements);
      hideUploadFeedback(uploadFeedback);
      hideProgressBar(elements);
      btnUpload.disabled = true;
    });
  }
}


// ── Progress bar helpers ──────────────────────────────────
//
// The progress bar lives inside #upload-feedback area.
// We inject it dynamically when Phase 2 starts and remove it on completion.
//
// HTML structure injected:
//   <div id="upload-progress-wrapper" class="upload-progress-wrapper">
//     <div class="upload-progress-bar-track">
//       <div id="upload-progress-fill" class="upload-progress-bar-fill"
//            style="width: 25%"></div>
//     </div>
//     <p id="upload-progress-label" class="upload-progress-label">
//       📄 Extracting text…
//     </p>
//   </div>

function showProgressBar(elements, progressPercent, message) {
  const { uploadFeedback } = elements;

  // If progress bar doesn't exist yet, create it
  let wrapper = document.getElementById("upload-progress-wrapper");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id        = "upload-progress-wrapper";
    wrapper.className = "upload-progress-wrapper";
    wrapper.innerHTML = `
      <div class="upload-progress-bar-track">
        <div id="upload-progress-fill" class="upload-progress-bar-fill" style="width: 0%"></div>
      </div>
      <p id="upload-progress-label" class="upload-progress-label">Starting…</p>
    `;
    // Insert the progress bar BEFORE the uploadFeedback element
    uploadFeedback.parentNode.insertBefore(wrapper, uploadFeedback);
  }

  wrapper.style.display = "block";
  updateProgressBar(elements, progressPercent, message);
}

function updateProgressBar(elements, progressPercent, message) {
  const fill  = document.getElementById("upload-progress-fill");
  const label = document.getElementById("upload-progress-label");

  if (fill) {
    // CSS transition on width creates the smooth animation
    fill.style.width = progressPercent + "%";
  }
  if (label) {
    label.textContent = message;
  }
}

function hideProgressBar(elements) {
  const wrapper = document.getElementById("upload-progress-wrapper");
  if (wrapper) {
    wrapper.style.display = "none";
  }
}


// ── Feedback message helpers ──────────────────────────────

// Shows a styled success or error message below the upload area.
function showUploadFeedback(feedbackElement, type, message) {
  feedbackElement.textContent = message;
  feedbackElement.className   = "upload-feedback " + type;
  feedbackElement.style.display = "block";
}

// Hides the feedback message.
function hideUploadFeedback(feedbackElement) {
  feedbackElement.style.display = "none";
  feedbackElement.textContent   = "";
  feedbackElement.className     = "upload-feedback";
}


// ── getSelectedFile ───────────────────────────────────────
// Exported so other modules can check if a file is selected.
export function getSelectedFile() {
  return selectedFile;
}
