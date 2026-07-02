/* =========================================================
   chat.js — MAIN APPLICATION CONTROLLER
   =========================================================
   PURPOSE:
     This is the "brain" of the frontend application.
     It coordinates all the other modules (auth, upload, modal)
     and handles:
     - Initializing everything when the page loads
     - Managing the auth state (logged in vs. logged out UI)
     - Sending chat messages to the backend
     - Rendering messages in the chat window
     - Handling the chat input textarea

   FLOW OVERVIEW:
     1. Page loads → initApp() runs
     2. Supabase auth state is checked → show auth form OR kb panel
     3. User types a message → sendMessage() is called
     4. Message is sent to backend → response streams back word by word
     5. Each word is appended to the last AI message bubble in real time
     6. User clicks Logout → modal.js handles the logout flow

   INTERVIEW TIP:
     "chat.js is the entry point / coordinator module. It doesn't
      do everything itself — it delegates to auth.js, upload.js,
      modal.js, and api.js. This is the separation of concerns
      principle applied to vanilla JavaScript."
   ========================================================= */

import { initSupabase, loginUser, signupUser, getCurrentSession, onAuthChange }
  from "./auth.js";
import { initUpload }          from "./upload.js";
import { initModal, openLogoutModal } from "./modal.js";
import { streamChatMessage }   from "./api.js";
import { autoGrow, renderMarkdown } from "./utils.js";


// ── Application State ─────────────────────────────────────
// These are the key pieces of data that the app tracks.
// In React, these would be useState() variables.
// Here, they are simple module-level variables.

let currentSession  = null;  // The Supabase session (null = not logged in)
let currentUser     = null;  // The user object (has .email, .id, etc.)
let chatMessages    = [];    // Array of all messages: { role, text, mode, confidence }
let isWaitingForAI  = false; // True while the AI is generating a response
let currentAuthMode = "login"; // "login" or "signup" — controls the auth form


// ── DOM Element References ────────────────────────────────
// We get all DOM elements once at the start and store them here.
// This is MUCH more efficient than calling document.getElementById()
// repeatedly inside functions.
//
// WHY GET THEM ALL AT ONCE?
//   Each call to document.getElementById() makes the browser search
//   through the entire DOM. Getting them all once and caching them
//   avoids this repeated work.
const elements = {
  // Sidebar elements
  sidebar:            document.getElementById("sidebar"),
  sidebarToggle:      document.getElementById("sidebar-toggle"),
  sidebarContent:     document.getElementById("sidebar-content"),

  // Auth panel (shown before login)
  authPanel:          document.getElementById("auth-panel"),
  authTitle:          document.getElementById("auth-title"),
  inputEmail:         document.getElementById("input-email"),
  inputPassword:      document.getElementById("input-password"),
  authMessage:        document.getElementById("auth-message"),
  btnAuth:            document.getElementById("btn-auth"),
  btnAuthToggle:      document.getElementById("btn-auth-toggle"),

  // KB (Knowledge Base) panel (shown after login)
  kbPanel:            document.getElementById("kb-panel"),
  userEmail:          document.getElementById("user-email"),
  btnLogout:          document.getElementById("btn-logout"),
  dropZone:           document.getElementById("drop-zone"),
  fileInput:          document.getElementById("file-input"),
  btnUpload:          document.getElementById("btn-upload"),
  uploadFeedback:     document.getElementById("upload-feedback"),

  // Chat area elements
  publicBadge:        document.getElementById("public-badge"),
  chatMessages:       document.getElementById("chat-messages"),
  chatEmpty:          document.getElementById("chat-empty"),
  chatEmptyText:      document.getElementById("chat-empty-text"),
  chatInput:          document.getElementById("chat-input"),
  btnSend:            document.getElementById("btn-send"),
  inputHint:          document.getElementById("input-hint"),

  // Modal elements
  modalOverlay:       document.getElementById("modal-overlay"),
  summaryContainer:   document.getElementById("summary-container"),
  btnCloseModal:      document.getElementById("btn-close-modal"),
  btnCopySummary:     document.getElementById("btn-copy-summary"),
  btnDownload:        document.getElementById("btn-download"),
  btnCancel:          document.getElementById("btn-cancel"),
  btnFinalizeLogout:  document.getElementById("btn-finalize-logout"),
};


// ── initApp ───────────────────────────────────────────────
//
// WHAT IT DOES:
//   The main entry point. Called once when the page loads.
//   Sets up Supabase, checks if the user is already logged in,
//   and wires up all event listeners.
//
// WHY "ASYNC"?
//   We use "await" inside this function (to check the Supabase session),
//   so the function must be declared async.
//
async function initApp() {
  // Step 1: Create the Supabase client
  // Without this, no auth functions will work
  initSupabase();

  // Step 2: Check if the user is already logged in from a previous session
  // Supabase stores the session in localStorage, so the user stays
  // logged in even after refreshing the page
  const existingSession = await getCurrentSession();
  if (existingSession) {
    currentSession = existingSession;
    currentUser    = existingSession.user;
    showKBPanel(); // Show the knowledge base panel for logged-in users
  } else {
    showAuthPanel(); // Show the login/signup form for guests
  }

  // Step 3: Listen for future auth state changes
  // This runs automatically whenever the user logs in or out
  onAuthChange(function (event, newSession) {
    currentSession = newSession;
    currentUser    = newSession ? newSession.user : null;

    if (newSession) {
      showKBPanel();  // User just logged in
    } else {
      showAuthPanel(); // User just logged out
      resetChatUI();   // Clear the chat messages
    }
  });

  // Step 4: Set up the sidebar toggle button
  elements.sidebarToggle.addEventListener("click", toggleSidebar);

  // Step 5: Set up the auth form (login/signup)
  setupAuthForm();

  // Step 6: Set up the chat input and send button
  setupChatInput();

  // Step 7: Set up the file upload area (drag-drop, file picker, upload button)
  initUpload({
    dropZone:       elements.dropZone,
    fileInput:      elements.fileInput,
    btnUpload:      elements.btnUpload,
    uploadFeedback: elements.uploadFeedback,
    getAccessToken: function () {
      return currentSession ? currentSession.access_token : null;
    },
  });

  // Step 8: Set up the logout modal
  initModal({
    modalOverlay:     elements.modalOverlay,
    summaryContainer: elements.summaryContainer,
    btnCloseModal:    elements.btnCloseModal,
    btnCopySummary:   elements.btnCopySummary,
    btnDownload:      elements.btnDownload,
    btnCancel:        elements.btnCancel,
    btnFinalizeLogout: elements.btnFinalizeLogout,
    getAccessToken:   function () {
      return currentSession ? currentSession.access_token : null;
    },
    getMessages: function () {
      return chatMessages;
    },
    onLogoutComplete: function () {
      // This runs after the user finishes the logout flow in the modal
      resetChatUI();
    },
  });
}


// ── setupAuthForm ─────────────────────────────────────────
//
// WHAT IT DOES:
//   Attaches event listeners to the auth form:
//   - "Login" / "Sign Up" button
//   - "No account? Sign up" toggle button
//   - Enter key in email/password fields
//
function setupAuthForm() {
  // Main action button: Login or Sign Up
  elements.btnAuth.addEventListener("click", handleAuthSubmit);

  // Toggle between login and signup mode
  elements.btnAuthToggle.addEventListener("click", toggleAuthMode);

  // Allow pressing Enter in the input fields to submit the form
  // This matches the original React app's onKeyDown behavior
  elements.inputEmail.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      handleAuthSubmit();
    }
  });

  elements.inputPassword.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      handleAuthSubmit();
    }
  });
}


// ── toggleAuthMode ────────────────────────────────────────
//
// WHAT IT DOES:
//   Switches the auth form between "login" mode and "signup" mode.
//   Plays a "morphing" animation (from the original React app) by
//   briefly adding the "morphing-out" CSS class before switching.
//
function toggleAuthMode() {
  // Clear any error message when switching modes
  hideAuthMessage();

  // Play the morph-out animation
  elements.authPanel.classList.add("morphing-out");

  // After 250ms (the animation duration), switch the mode
  setTimeout(function () {
    elements.authPanel.classList.remove("morphing-out");

    // Toggle between "login" and "signup"
    currentAuthMode = (currentAuthMode === "login") ? "signup" : "login";

    // Update all the text in the form to match the new mode
    updateAuthFormText();
  }, 250);
}


// ── updateAuthFormText ────────────────────────────────────
// Updates button labels and hint text based on the current auth mode.
function updateAuthFormText() {
  if (currentAuthMode === "login") {
    elements.authTitle.textContent    = "Sign in";
    elements.btnAuth.textContent      = "Continue";
    elements.btnAuthToggle.textContent = "No account? Create one";
  } else {
    elements.authTitle.textContent    = "Create account";
    elements.btnAuth.textContent      = "Create account";
    elements.btnAuthToggle.textContent = "Already have an account? Sign in";
  }
}


// ── handleAuthSubmit ──────────────────────────────────────
//
// WHAT IT DOES:
//   Called when the user clicks Login or Sign Up.
//   Validates the inputs, calls the appropriate Supabase function,
//   and shows success/error messages.
//
async function handleAuthSubmit() {
  const email    = elements.inputEmail.value.trim();
  const password = elements.inputPassword.value;

  // Basic validation — both fields are required
  if (!email || !password) {
    showAuthMessage("error", "Email and password are required.");
    return;
  }

  // Show loading state
  elements.btnAuth.disabled    = true;
  elements.btnAuth.textContent = "Please wait…";
  hideAuthMessage();

  try {
    if (currentAuthMode === "login") {
      // Call Supabase login
      await loginUser(email, password);
      // On success, onAuthChange() fires automatically and shows the KB panel

    } else {
      // Call Supabase signup
      await signupUser(email, password);
      // Signup doesn't log in immediately — user must confirm email
      showAuthMessage("success", "Check your email to confirm signup, then sign in.");
      currentAuthMode = "login";
      updateAuthFormText();
    }

  } catch (authError) {
    // Show the error from Supabase (e.g., "Invalid login credentials")
    showAuthMessage("error", authError.message);

  } finally {
    // Always re-enable the button after the request completes
    elements.btnAuth.disabled = false;
    updateAuthFormText(); // Restores the correct button text
  }
}


// ── setupChatInput ────────────────────────────────────────
//
// WHAT IT DOES:
//   Attaches event listeners to the chat textarea and send button.
//
function setupChatInput() {
  // Send message when the send button is clicked
  elements.btnSend.addEventListener("click", sendMessage);

  // Send message on Enter key (but NOT Shift+Enter, which adds a newline)
  elements.chatInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); // Prevent the newline from being added
      sendMessage();
    }
  });

  // Auto-grow the textarea as the user types
  // Also enable/disable the send button based on whether there is text
  elements.chatInput.addEventListener("input", function () {
    autoGrow(elements.chatInput);

    // Enable the send button only when there is non-empty text
    // .trim() removes whitespace — so a message of only spaces is treated as empty
    const hasText = elements.chatInput.value.trim().length > 0;
    elements.btnSend.disabled = !hasText || isWaitingForAI;
  });
}


// ── sendMessage ───────────────────────────────────────────
//
// WHAT IT DOES:
//   The core chat function. Called when the user sends a message.
//   1. Reads and validates the input
//   2. Adds the user's message bubble to the chat
//   3. Shows a loading indicator
//   4. Streams the AI response from the backend
//   5. Updates the AI bubble word by word
//
async function sendMessage() {
  const messageText = elements.chatInput.value.trim();

  // Don't send empty messages or send while already waiting
  if (!messageText || isWaitingForAI) return;

  // Disable the input while processing
  isWaitingForAI = true;
  elements.btnSend.disabled = true;

  // Add the user's message to our messages array and render it
  chatMessages.push({ role: "user", text: messageText });
  renderUserMessage(messageText);

  // Clear the textarea and reset its height
  elements.chatInput.value = "";
  elements.chatInput.style.height = "auto";

  // Show the loading indicator (three bouncing dots)
  showLoadingIndicator();
  updateEmptyState(); // Hide the "Start a conversation" placeholder

  // Build the chat history to send to the backend
  // We send the last 6 messages for context (same as original React app)
  const recentHistory = chatMessages.slice(-6).map(function (message) {
    return {
      role: message.role === "ai" ? "assistant" : message.role,
      text: message.text,
      mode: message.mode,
    };
  });

  // We track the AI message we're building here
  let aiMessageElement = null; // The DOM bubble element
  let aiFullText       = "";   // Accumulated response text

  // ── Streaming Callbacks ────────────────────────────────
  // Instead of one big function, we pass three callback functions
  // to streamChatMessage(). Each one handles a different event.

  // Called with each text chunk as it arrives from the backend
  function onChunk(textChunk) {
    aiFullText = aiFullText + textChunk;

    if (!aiMessageElement) {
      // First chunk: create the AI message bubble and remove loading dots
      hideLoadingIndicator();
      aiMessageElement = renderAIMessageBubble("", "loading", null);
    }

    // Update the bubble content with the growing text
    // We render it as Markdown on each update
    const bubbleContent = aiMessageElement.querySelector(".message-bubble");
    if (bubbleContent) {
      bubbleContent.innerHTML = renderMarkdown(aiFullText);
    }

    // Auto-scroll to the bottom as text streams in
    scrollToBottom();
  }

  // Called when the stream is completely finished
  function onDone(mode, confidence) {
    // Update the badge above the AI bubble
    const badge = aiMessageElement ? aiMessageElement.querySelector(".mode-badge") : null;
    if (badge) {
      updateModeBadge(badge, mode, confidence);
    }

    // Store the completed message in our messages array
    chatMessages.push({ role: "ai", text: aiFullText, mode: mode, confidence: confidence });

    // Re-enable the input
    isWaitingForAI = false;
    elements.btnSend.disabled = false;
    elements.chatInput.focus(); // Return focus to the input field
  }

  // Called if anything goes wrong
  function onError(errorMessage) {
    hideLoadingIndicator();
    renderErrorMessage(errorMessage);
    isWaitingForAI = false;
    elements.btnSend.disabled = false;
  }

  // Get the current access token for authenticated requests
  const accessToken = currentSession ? currentSession.access_token : null;

  // Call the streaming API (defined in api.js)
  await streamChatMessage(
    messageText,
    recentHistory,
    accessToken,
    onChunk,
    onDone,
    onError
  );
}


// ── renderUserMessage ─────────────────────────────────────
//
// WHAT IT DOES:
//   Creates and inserts a user message bubble into the chat.
//
// HOW IT WORKS:
//   We use document.createElement() to build DOM elements
//   programmatically, then append them to the chat container.
//
function renderUserMessage(text) {
  // Create the outer row container
  const messageRow = document.createElement("div");
  messageRow.className = "message-row user"; // CSS class controls alignment

  // Create the bubble element
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  // User messages are treated as plain text, not Markdown
  // (Same behavior as original React app)
  bubble.textContent = text;

  messageRow.appendChild(bubble);
  elements.chatMessages.appendChild(messageRow);

  scrollToBottom();
}


// ── renderAIMessageBubble ─────────────────────────────────
//
// WHAT IT DOES:
//   Creates an AI message bubble with a mode badge above it.
//   Returns the message row element so it can be updated later
//   as streaming chunks arrive.
//
// PARAMETERS:
//   - text       : Initial text (empty "" during streaming)
//   - mode       : "loading", "rag", or "fallback"
//   - confidence : retained internally (not displayed to user)
//
function renderAIMessageBubble(text, mode, confidence) {
  // Create the outer row
  const messageRow = document.createElement("div");
  messageRow.className = "message-row ai";

  // Create the mode badge
  const badge = document.createElement("span");
  badge.className = "mode-badge fall"; // Default to "fall" (fallback/loading)
  badge.textContent = "Thinking…";

  // Create the message bubble
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.innerHTML = renderMarkdown(text); // Render even if empty initially

  messageRow.appendChild(badge);
  messageRow.appendChild(bubble);
  elements.chatMessages.appendChild(messageRow);

  scrollToBottom();

  return messageRow; // Return so caller can update it during streaming
}


// ── updateModeBadge ───────────────────────────────────────
// Updates the badge icon and label once the stream completes.
// NOTE: confidence is received but intentionally not shown to the user.
function updateModeBadge(badge, mode, confidence) {
  // Inline SVG icons — Lucide stroke style, 9px
  const iconDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
  const iconAI  = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

  if (mode === "rag") {
    badge.className = "mode-badge rag";
    badge.innerHTML = iconDoc + " From Documents";
  } else {
    badge.className = "mode-badge fall";
    badge.innerHTML = iconAI + " AI Response";
  }
}


// ── renderErrorMessage ────────────────────────────────────
// Creates a red error message bubble in the chat.
function renderErrorMessage(errorText) {
  const messageRow = document.createElement("div");
  messageRow.className = "message-row error";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = errorText;

  messageRow.appendChild(bubble);
  elements.chatMessages.appendChild(messageRow);
  scrollToBottom();
}


// ── showLoadingIndicator ──────────────────────────────────
// Adds the three-dot loading animation to the chat area.
function showLoadingIndicator() {
  // Check if it's already shown
  if (document.getElementById("loading-indicator")) return;

  const loadingRow = document.createElement("div");
  loadingRow.className = "message-row ai";
  loadingRow.id = "loading-indicator"; // ID so we can find and remove it later

  loadingRow.innerHTML = `
    <div class="loading-bubble">
      <div class="loading-dot"></div>
      <div class="loading-dot"></div>
      <div class="loading-dot"></div>
    </div>
  `;

  elements.chatMessages.appendChild(loadingRow);
  scrollToBottom();
}


// ── hideLoadingIndicator ──────────────────────────────────
// Removes the loading dots from the chat.
function hideLoadingIndicator() {
  const loadingElement = document.getElementById("loading-indicator");
  if (loadingElement) {
    loadingElement.remove(); // Remove the element from the DOM entirely
  }
}


// ── scrollToBottom ────────────────────────────────────────
//
// WHAT IT DOES:
//   Scrolls the chat messages area to the bottom so the
//   latest message is always visible.
//
// WHY "smooth"?
//   smooth behavior creates a CSS scroll animation.
//   It feels more natural than instantly jumping to the bottom.
//
function scrollToBottom() {
  elements.chatMessages.scrollTo({
    top: elements.chatMessages.scrollHeight, // scrollHeight is the total height of all content
    behavior: "smooth",
  });
}


// ── updateEmptyState ──────────────────────────────────────
// Shows or hides the "Start a conversation" placeholder
// based on whether there are any messages.
function updateEmptyState() {
  if (chatMessages.length > 0) {
    // There are messages — hide the placeholder
    if (elements.chatEmpty) {
      elements.chatEmpty.style.display = "none";
    }
  } else {
    // No messages — show the placeholder
    if (elements.chatEmpty) {
      elements.chatEmpty.style.display = "";
    }
  }
}


// ── showKBPanel ───────────────────────────────────────────
//
// WHAT IT DOES:
//   Updates the entire sidebar UI to show the logged-in state:
//   - Hides the auth form
//   - Shows the user's email and logout button
//   - Shows the file upload (knowledge base) panel
//   - Hides the "Public Mode" badge in the header
//   - Updates the input placeholder and hint text
//
function showKBPanel() {
  // Hide auth form, show KB panel
  elements.authPanel.style.display = "none";
  elements.kbPanel.style.display   = "flex";

  // Show the logged-in user's email (truncated by CSS)
  if (currentUser) {
    elements.userEmail.textContent = currentUser.email;
  }

  // Attach the logout handler to the logout button
  // We use onclick (not addEventListener) to avoid stacking multiple listeners
  elements.btnLogout.onclick = function () {
    handleLogoutClick();
  };

  // Hide "🔓 Public Mode" badge in the header
  if (elements.publicBadge) {
    elements.publicBadge.style.display = "none";
  }

  // Update placeholder and hint for logged-in mode
  elements.chatInput.placeholder    = "Ask a question about your documents… (Shift+Enter for newline)";
  elements.inputHint.textContent    = "Logged in · Private documents · Auto-deleted on logout";
  elements.chatEmptyText.textContent = "Start chatting! Upload a document to explore its content.";
}


// ── showAuthPanel ─────────────────────────────────────────
//
// WHAT IT DOES:
//   Updates the sidebar UI to show the logged-out state:
//   - Shows the auth form (email + password)
//   - Hides the KB panel
//   - Shows the "Public Mode" badge in the header
//   - Updates input placeholder and hint for guest mode
//
function showAuthPanel() {
  // Show auth form, hide KB panel
  elements.authPanel.style.display = "flex";
  elements.kbPanel.style.display   = "none";

  // Show "Public" badge in the header
  if (elements.publicBadge) {
    elements.publicBadge.style.display = "";
  }

  // Update placeholder and hint for guest mode
  elements.chatInput.placeholder    = "Ask anything…";
  elements.inputHint.textContent    = "Public mode · responses use general AI knowledge";
  elements.chatEmptyText.textContent = "Public mode — chat freely, or sign in to enable document context";
}


// ── handleLogoutClick ─────────────────────────────────────
//
// WHAT IT DOES:
//   Called when the user clicks the Logout button.
//   If they have an active session, shows the summary modal.
//   If they have no messages, just completes the logout directly.
//
async function handleLogoutClick() {
  if (!currentSession) return; // Already logged out

  if (chatMessages.length > 0) {
    // Has messages — show the summary modal before logging out
    await openLogoutModal(chatMessages, currentSession.access_token, {
      modalOverlay:     elements.modalOverlay,
      summaryContainer: elements.summaryContainer,
      btnFinalizeLogout: elements.btnFinalizeLogout,
      btnCopySummary:   elements.btnCopySummary,
      btnDownload:      elements.btnDownload,
      onLogoutComplete: function () {
        resetChatUI();
      },
    });
  } else {
    // No messages — skip the modal, logout directly
    const { clearUserDocuments } = await import("./api.js");
    const { signOutUser }         = await import("./auth.js");
    await clearUserDocuments(currentSession.access_token);
    await signOutUser();
  }
}


// ── resetChatUI ───────────────────────────────────────────
//
// WHAT IT DOES:
//   Clears all chat messages from both the array and the DOM.
//   Called after the user logs out.
//
function resetChatUI() {
  chatMessages = [];

  // Remove all message bubbles from the chat area (except the empty state div)
  const allMessageRows = elements.chatMessages.querySelectorAll(".message-row");
  allMessageRows.forEach(function (row) {
    row.remove();
  });

  updateEmptyState(); // Show the "Start a conversation" placeholder again
}


// ── toggleSidebar ─────────────────────────────────────────
//
// WHAT IT DOES:
//   Toggles the sidebar between expanded and collapsed states.
//   Adds/removes the "collapsed" CSS class — the CSS handles
//   the smooth animation.
//
function toggleSidebar() {
  elements.sidebar.classList.toggle("collapsed");

  // Update the toggle button icon (« when expanded, » when collapsed)
  const isNowCollapsed = elements.sidebar.classList.contains("collapsed");
  elements.sidebarToggle.textContent  = isNowCollapsed ? "»" : "«";
  elements.sidebarToggle.title        = isNowCollapsed ? "Expand sidebar" : "Collapse sidebar";
  elements.sidebarToggle.setAttribute("aria-label", isNowCollapsed ? "Expand sidebar" : "Collapse sidebar");
}


// ── Auth UI helpers ───────────────────────────────────────

// Shows a styled message (error or success) below the auth inputs
function showAuthMessage(type, message) {
  elements.authMessage.textContent = message;
  elements.authMessage.className   = "auth-msg " + type; // "auth-msg error" or "auth-msg success"
  elements.authMessage.style.display = "block";
}

// Hides the auth message
function hideAuthMessage() {
  elements.authMessage.style.display = "none";
  elements.authMessage.textContent   = "";
}


// ── START THE APPLICATION ─────────────────────────────────
//
// This line starts everything. When the browser loads this script,
// it calls initApp(), which sets up the whole application.
//
// WHY NOT WRAP IN DOMContentLoaded?
//   Because chat.html loads this script as a module at the bottom
//   of the <body>, so the DOM is already ready when this runs.
//
initApp();
