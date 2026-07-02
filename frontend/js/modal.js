/* =========================================================
   modal.js — SESSION SUMMARY MODAL (LOGOUT FLOW)
   =========================================================
   PURPOSE:
     This file manages the "End of Session Summary" modal
     that appears when a logged-in user clicks "Logout".

   THE LOGOUT FLOW (step by step):
     1. User clicks "Logout"
     2. We fetch a summary of the session from the backend
     3. The modal appears and shows the summary (rendered as Markdown)
     4. User can:
        a) Copy the summary text to clipboard
        b) Download the summary as a .txt file
        c) Cancel and go back to the chat
        d) Finalize Logout — this deletes their documents and signs them out

   WHY A MODAL?
     A modal (popup dialog) is used here because we want to
     interrupt the user's action (logout) to let them review
     and save their session summary BEFORE their data is deleted.
     This is important for privacy-conscious apps.

   INTERVIEW TIP:
     "The modal is shown/hidden by toggling the 'visible' CSS class.
      The summary text is rendered using marked.js (Markdown parser).
      Clipboard copy uses the browser's Clipboard API."
   ========================================================= */

import { fetchSessionSummary, clearUserDocuments } from "./api.js";
import { signOutUser } from "./auth.js";
import { renderMarkdown } from "./utils.js";


// ── Module-level variables ─────────────────────────────────
// We store the summary text so it can be copied and downloaded
let currentSummaryText = "";  // The plain text summary from the backend
let isLoadingSummary   = false; // Prevents multiple simultaneous fetches


// ── initModal ─────────────────────────────────────────────
//
// WHAT IT DOES:
//   Sets up all event listeners for the modal's buttons.
//   Called once when the page loads.
//
// PARAMETERS:
//   - elements : Object with all the modal DOM elements
//
export function initModal(elements) {
  const {
    btnCloseModal,   // The ✕ button in the modal header
    btnCopySummary,  // "📋 Copy Text" button
    btnDownload,     // "📥 Download .txt" button
    btnCancel,       // "Cancel" button in the footer
    btnFinalizeLogout, // "Finalize Logout & Delete Data" button
    getAccessToken,  // Function to get current JWT token
    getMessages,     // Function to get current chat messages
  } = elements;

  // ── Close button (✕) ─────────────────────────────────────
  // Cancels the logout — hides the modal without signing out
  btnCloseModal.addEventListener("click", function () {
    if (!isLoadingSummary) {
      // Only allow closing if we're not currently loading the summary
      hideModal(elements.modalOverlay);
    }
  });

  // ── Cancel button ─────────────────────────────────────────
  // Same as close button — user decides to stay logged in
  btnCancel.addEventListener("click", function () {
    if (!isLoadingSummary) {
      hideModal(elements.modalOverlay);
    }
  });

  // ── Copy summary to clipboard ─────────────────────────────
  btnCopySummary.addEventListener("click", function () {
    copySummaryToClipboard(btnCopySummary);
  });

  // ── Download summary as text file ─────────────────────────
  btnDownload.addEventListener("click", function () {
    downloadSummaryAsFile();
  });

  // ── Finalize Logout ───────────────────────────────────────
  // This is the destructive action: delete documents + sign out
  btnFinalizeLogout.addEventListener("click", async function () {
    if (!isLoadingSummary) {
      const currentToken = getAccessToken();
      await finalizeLogout(currentToken, elements);
    }
  });

  // ── Close modal when clicking the dark overlay ─────────────
  // If user clicks OUTSIDE the modal card (on the dark backdrop),
  // we treat it as a cancel action.
  elements.modalOverlay.addEventListener("click", function (event) {
    // Only close if the click was directly on the overlay,
    // NOT on the modal content card inside it.
    // event.target is the element that was clicked.
    // event.currentTarget is the element the listener is attached to.
    if (event.target === elements.modalOverlay && !isLoadingSummary) {
      hideModal(elements.modalOverlay);
    }
  });
}


// ── openLogoutModal ───────────────────────────────────────
//
// WHAT IT DOES:
//   Shows the summary modal and begins fetching the session summary.
//   Called when the user clicks the "Logout" button.
//
// PARAMETERS:
//   - messages    : Array of all chat messages in the current session
//   - accessToken : JWT token for the API request
//   - elements    : Object with DOM element references
//
export async function openLogoutModal(messages, accessToken, elements) {
  const { modalOverlay, summaryContainer, btnFinalizeLogout, btnCopySummary, btnDownload } = elements;

  // Reset state before opening
  currentSummaryText = "";
  isLoadingSummary   = true;

  // Show the modal overlay immediately
  // The user sees the loading spinner while we fetch the summary
  showModal(modalOverlay);

  // Show the loading spinner inside the modal body
  showLoadingState(summaryContainer);

  // Disable the action buttons while loading
  btnFinalizeLogout.disabled = true;
  btnCopySummary.disabled    = true;
  btnDownload.disabled       = true;

  try {
    // Fetch the session summary from the backend
    // This sends the chat history to the AI which generates a professional summary
    const summaryText = await fetchSessionSummary(messages, accessToken);

    // Store the plain text for copy/download
    currentSummaryText = summaryText;

    // Render the summary as Markdown HTML and display it
    showSummaryContent(summaryContainer, summaryText);

    // Enable action buttons now that we have content
    btnFinalizeLogout.disabled = false;
    btnCopySummary.disabled    = false;
    btnDownload.disabled       = false;

  } catch (fetchError) {
    // If the summary fetch failed, show a fallback message
    // We still want to let the user logout even if summary generation fails
    currentSummaryText = "Your session has ended, but we couldn't generate a summary at this time.";
    showSummaryContent(summaryContainer, currentSummaryText);
    btnFinalizeLogout.disabled = false; // Still allow logout
    console.error("[modal] Summary fetch error:", fetchError);

  } finally {
    isLoadingSummary = false;
  }
}


// ── finalizeLogout ────────────────────────────────────────
//
// WHAT IT DOES:
//   The FINAL step of the logout flow.
//   1. Deletes all the user's uploaded documents from the backend
//   2. Signs the user out of Supabase
//   3. Hides the modal
//   4. Calls the onLogoutComplete callback to reset the UI
//
// WHY DELETE DOCUMENTS BEFORE SIGN OUT?
//   We need the access token to call the delete endpoint.
//   Once we call signOutUser(), the token is invalidated.
//   So we must delete FIRST, then sign out.
//
// PARAMETERS:
//   - accessToken : The JWT token (must be used before signOut)
//   - elements    : Object with DOM element references
//
async function finalizeLogout(accessToken, elements) {
  const { modalOverlay, btnFinalizeLogout, onLogoutComplete } = elements;

  // Show a "working" state on the button
  btnFinalizeLogout.disabled = true;
  btnFinalizeLogout.textContent = "Logging out…";

  try {
    // Step 1: Delete all user documents from the backend database
    // This fulfills the "Files are securely deleted on logout" promise
    await clearUserDocuments(accessToken);

    // Step 2: Sign out from Supabase
    // This invalidates the JWT token and clears localStorage
    await signOutUser();

  } catch (logoutError) {
    // Even if something goes wrong, we still want to complete the logout
    console.error("[modal] Logout error:", logoutError);
  }

  // Step 3: Hide the modal
  hideModal(modalOverlay);

  // Step 4: Tell the main app to reset the UI (clear messages, show auth form)
  if (typeof onLogoutComplete === "function") {
    onLogoutComplete();
  }
}


// ── copySummaryToClipboard ────────────────────────────────
//
// WHAT IT DOES:
//   Copies the summary text to the user's clipboard using
//   the browser's Clipboard API.
//
// HOW THE CLIPBOARD API WORKS:
//   navigator.clipboard.writeText() is a modern browser API
//   that writes text to the clipboard. It returns a Promise,
//   so we use .then() and .catch() to handle success/failure.
//
// WHAT HAPPENS IF REMOVED:
//   The "Copy Text" button would do nothing useful.
//
function copySummaryToClipboard(btnCopySummary) {
  if (!currentSummaryText) return;

  // navigator.clipboard.writeText() is async — we use .then() for feedback
  navigator.clipboard.writeText(currentSummaryText)
    .then(function () {
      // Temporarily change button text to confirm the copy worked
      const originalText = btnCopySummary.textContent;
      btnCopySummary.textContent = "✅ Copied!";
      setTimeout(function () {
        btnCopySummary.textContent = originalText;
      }, 2000);
    })
    .catch(function () {
      // Clipboard API might fail in certain browser security contexts
      console.error("[modal] Clipboard copy failed.");
    });
}


// ── downloadSummaryAsFile ─────────────────────────────────
//
// WHAT IT DOES:
//   Creates a .txt file from the summary text and triggers
//   a download in the browser WITHOUT a server request.
//
// HOW IT WORKS (step by step):
//   1. Create a Blob — a "Binary Large Object" — essentially
//      a file-like object in memory
//   2. Create a temporary URL for that Blob using URL.createObjectURL()
//   3. Create a hidden <a> link pointing to that URL
//   4. Programmatically click the link — this triggers the download
//   5. Release the URL from memory with URL.revokeObjectURL()
//
// WHY THIS APPROACH?
//   The browser doesn't have a "save file" API directly.
//   The trick is to create a downloadable link and click it automatically.
//   This is a standard pattern for client-side file downloads.
//
function downloadSummaryAsFile() {
  if (!currentSummaryText) return;

  // Step 1: Create a Blob with our text content
  const textBlob = new Blob(
    [currentSummaryText],  // Array of content parts
    { type: "text/plain" } // MIME type — tells the browser it's a text file
  );

  // Step 2: Create a temporary URL for the blob
  const blobUrl = URL.createObjectURL(textBlob);

  // Step 3: Create a hidden <a> element
  const downloadLink = document.createElement("a");
  downloadLink.href = blobUrl;
  downloadLink.download = "ArchAI_Session_Summary.txt"; // Suggested filename

  // Step 4: Click the link (triggers download dialog in browser)
  downloadLink.click();

  // Step 5: Release the memory used by the blob URL
  URL.revokeObjectURL(blobUrl);
}


// ── showModal ─────────────────────────────────────────────
// Shows the modal by adding the "visible" CSS class.
// The CSS class changes display from "none" to "flex".
function showModal(modalOverlay) {
  modalOverlay.classList.add("visible");
}

// ── hideModal ─────────────────────────────────────────────
// Hides the modal by removing the "visible" class.
function hideModal(modalOverlay) {
  modalOverlay.classList.remove("visible");
}

// ── showLoadingState ──────────────────────────────────────
// Shows the spinning loader inside the modal body.
function showLoadingState(container) {
  container.innerHTML = `
    <div class="summary-loading">
      <div class="loading-spinner"></div>
      <p>Analyzing chat history and generating your session summary...</p>
    </div>
  `;
}

// ── showSummaryContent ────────────────────────────────────
// Renders the markdown summary and displays it in the modal body.
function showSummaryContent(container, markdownText) {
  // Convert the Markdown text to HTML using marked.js (via utils.js)
  const htmlContent = renderMarkdown(markdownText);

  // Set the HTML content in the modal body
  container.innerHTML = `<div class="summary-markdown">${htmlContent}</div>`;
}
