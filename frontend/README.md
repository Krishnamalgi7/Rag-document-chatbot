# Arch Knowledge — Frontend Documentation

> **A plain HTML + CSS + Vanilla JavaScript frontend for the Arch Knowledge chatbot.**
> No React. No build step. No npm. Just open `chat.html` in a browser.

---

## Table of Contents

1. [Folder Structure](#1-folder-structure)
2. [Purpose of Every HTML File](#2-purpose-of-every-html-file)
3. [Purpose of Every CSS File](#3-purpose-of-every-css-file)
4. [Purpose of Every JS File](#4-purpose-of-every-js-file)
5. [Complete Application Flow](#5-complete-application-flow)
6. [Authentication Flow](#6-authentication-flow)
7. [Chat Flow](#7-chat-flow)
8. [File Upload Flow](#8-file-upload-flow)
9. [Backend API Flow](#9-backend-api-flow)
10. [How Frontend Communicates With Backend](#10-how-frontend-communicates-with-backend)
11. [How Streaming Responses Work](#11-how-streaming-responses-work)
12. [How to Run the Project](#12-how-to-run-the-project)
13. [Common Interview Questions & Answers](#13-common-interview-questions--answers)

---

## 1. Folder Structure

```
frontend/
│
├── index.html          ← Entry point. Redirects to chat.html.
├── chat.html           ← The main application page (full UI).
│
├── css/
│   ├── style.css       ← Global: CSS variables, fonts, reset, scrollbar.
│   └── chat.css        ← Components: sidebar, messages, modal, responsive.
│
├── js/
│   ├── config.js       ← Configuration: Supabase URL/key + API base URL.
│   ├── utils.js        ← Helpers: autoGrow, renderMarkdown, showElement.
│   ├── api.js          ← All fetch() calls to the FastAPI backend.
│   ├── auth.js         ← Supabase auth: login, signup, logout, session.
│   ├── upload.js       ← File drag-drop, validation, upload to backend.
│   ├── modal.js        ← Session summary modal logic.
│   └── chat.js         ← Main controller: coordinates all modules.
│
└── assets/             ← (empty — for future icons/images)
```

---

## 2. Purpose of Every HTML File

### `index.html`
- **What it is:** The entry point page served when visiting the root URL (e.g., `http://localhost:8080`).
- **What it does:** Immediately redirects the user to `chat.html` using both a `<meta http-equiv="refresh">` tag (works without JavaScript) and `window.location.replace("chat.html")` (JavaScript redirect).
- **Why it exists:** Web servers usually look for `index.html` first. Having it redirect to `chat.html` ensures visitors always land on the right page.

### `chat.html`
- **What it is:** The main (and only real) page of the application.
- **What it does:** Defines the complete HTML structure of the UI:
  - `<aside class="sidebar">` — Contains the logo, auth form (before login), and knowledge base panel (after login).
  - `<main class="chat-main">` — Contains the chat header, scrollable messages area, and text input area.
  - `<div id="modal-overlay">` — The session summary modal (hidden by default).
- **How JavaScript connects:** Every interactive element has an `id` attribute (e.g., `id="btn-send"`). JavaScript files use `document.getElementById("btn-send")` to find and manipulate these elements.
- **External libraries loaded:** `marked.js` (Markdown parser) and `@supabase/supabase-js` (auth SDK) are loaded from CDN via `<script>` tags.

---

## 3. Purpose of Every CSS File

### `css/style.css`
- **What it does:** Defines the "design system" — a set of CSS custom properties (variables) that all other styles reference.
- **Key contents:**
  - `@import` — Loads Google Fonts (DM Sans + Outfit).
  - `:root { ... }` — Defines 40+ CSS variables for colors, shadows, radii, transitions.
  - `*, *::before, *::after { box-sizing: border-box; }` — Universal reset.
  - `body { ... }` — Base font, background color, and radial gradient decorations.
  - `::-webkit-scrollbar { ... }` — Custom purple scrollbar.
- **Why separate from `chat.css`:** If you want to retheme the entire app, you only change this one file. All component styles in `chat.css` automatically pick up the new values.

### `css/chat.css`
- **What it does:** Styles every visible component in the application.
- **Key sections (in order):**
  1. `.app` — The outermost flex container (sidebar + chat side by side).
  2. `.sidebar` — Sidebar layout, collapse animation, toggle button, logo.
  3. `.auth-panel` — Login/signup form, inputs, morph animation.
  4. `.user-info`, `.btn-logout` — Logged-in user display.
  5. `.kb-panel`, `.drop-zone` — Knowledge base panel and file upload area.
  6. `.chat-main`, `.chat-header` — Main area and header.
  7. `.chat-messages`, `.message-row`, `.message-bubble` — Chat bubbles.
  8. `.loading-bubble`, `.loading-dot` — Three-dot loading animation.
  9. `.chat-input-area`, `.chat-textarea`, `.btn-send` — Input area.
  10. Markdown styles — Headings, code, tables inside `.message-bubble`.
  11. `.modal-overlay`, `.modal-content` — Session summary modal.
  12. `@media` queries — Responsive behavior for mobile/tablet.
- **How JavaScript connects:** JS adds/removes CSS classes (e.g., `sidebar.classList.add("collapsed")`) and sets `element.style.display` to show/hide elements.

---

## 4. Purpose of Every JS File

### `js/config.js`
- **What it does:** Exports three constants:
  - `SUPABASE_URL` — The URL of your Supabase project.
  - `SUPABASE_ANON_KEY` — The public key that identifies your app to Supabase.
  - `API_BASE` — The base URL of your FastAPI backend.
- **Why it exists:** Centralizes all environment-specific values. To deploy to production, you only change this one file.

### `js/utils.js`
- **What it does:** Exports reusable helper functions used by multiple other files:
  - `autoGrow(textarea)` — Makes the chat textarea expand as the user types.
  - `renderMarkdown(text)` — Converts Markdown text to HTML using `marked.js`.
  - `showElement(el)` — Sets `display: ""` on a DOM element.
  - `hideElement(el)` — Sets `display: none` on a DOM element.
- **Why it exists:** Avoids repeating the same code in multiple files (DRY principle).

### `js/api.js`
- **What it does:** Contains all `fetch()` calls to the FastAPI backend:
  - `streamChatMessage(...)` — Streams the AI response word by word.
  - `fetchSessionSummary(messages, token)` — Gets a session summary before logout.
  - `uploadDocumentToServer(file, token)` — Uploads a PDF/image.
  - `clearUserDocuments(token)` — Deletes user's documents on logout.
- **Why it exists:** Keeps all backend communication in one place. If an endpoint URL changes, only this file needs updating.

### `js/auth.js`
- **What it does:** Wraps the Supabase JS SDK for authentication:
  - `initSupabase()` — Creates the Supabase client.
  - `loginUser(email, password)` — Signs in with Supabase.
  - `signupUser(email, password)` — Creates a new account.
  - `getCurrentSession()` — Restores a saved session from localStorage.
  - `onAuthChange(callback)` — Listens for login/logout events.
  - `signOutUser()` — Signs out and clears the session.
- **Why it exists:** Isolates all Supabase-specific code so the rest of the app doesn't need to know how auth works internally.

### `js/upload.js`
- **What it does:** Handles all file upload interactions:
  - `initUpload(elements)` — Attaches all drag-drop and click event listeners.
  - `handleFileSelection(file, elements)` — Validates the file type, updates the drop zone UI.
  - File upload with loading state, success/error feedback.
- **Key techniques:** `dragover`, `dragleave`, `drop` events for drag-and-drop. `FormData` for multipart file upload. Validation by checking file extension.

### `js/modal.js`
- **What it does:** Manages the logout confirmation modal:
  - `initModal(elements)` — Attaches all modal button event listeners.
  - `openLogoutModal(messages, token, elements)` — Fetches summary, shows modal.
  - Handles copy to clipboard (`navigator.clipboard.writeText()`).
  - Handles download as `.txt` file (Blob + Object URL trick).
  - `finalizeLogout(token, elements)` — Deletes documents, then signs out.

### `js/chat.js`
- **What it does:** The main application controller. Coordinates all other modules.
  - `initApp()` — Entry point. Called once when the page loads.
  - Checks existing Supabase session and shows correct UI.
  - Listens for auth state changes and updates the UI.
  - `sendMessage()` — Sends messages and handles streaming responses.
  - `renderUserMessage()`, `renderAIMessageBubble()` — Create DOM bubbles.
  - `showAuthPanel()`, `showKBPanel()` — Toggle sidebar UI.
  - `toggleSidebar()` — Expand/collapse the sidebar.

---

## 5. Complete Application Flow

```
Browser opens chat.html
        │
        ▼
HTML is parsed → DOM is ready
        │
        ▼
CDN scripts load:
  - marked.js (Markdown parser)
  - @supabase/supabase-js (auth SDK → window.supabase)
        │
        ▼
<script type="module" src="js/chat.js"> runs
        │
        ▼
initApp() is called
        │
        ├── initSupabase() → Creates Supabase client
        │
        ├── getCurrentSession()
        │     ├── Session found → showKBPanel() (user was already logged in)
        │     └── No session   → showAuthPanel() (guest mode)
        │
        ├── onAuthChange(callback) → Registered (fires on future login/logout)
        │
        ├── sidebarToggle event listener
        ├── setupAuthForm() → Login/signup button listeners
        ├── setupChatInput() → Send button + Enter key + autoGrow
        ├── initUpload() → Drag-drop + file picker + upload button
        └── initModal()  → Modal button event listeners

[User interacts with the page]
        │
        ├── Types in chat input → autoGrow + enable send button
        ├── Clicks send / presses Enter → sendMessage()
        ├── Clicks Login / Sign Up → handleAuthSubmit()
        ├── Drops a file → handleFileSelection() → updateDropZoneWithFile()
        ├── Clicks Upload → handleUpload()
        ├── Clicks Logout → handleLogoutClick() → openLogoutModal()
        └── Clicks Finalize Logout → finalizeLogout() → signOutUser()
```

---

## 6. Authentication Flow

Supabase handles all authentication. The frontend only calls Supabase's functions.

```
SIGNUP FLOW:
═══════════
User fills email + password → clicks "Sign Up"
        │
        ▼
signupUser(email, password) in auth.js
        │
        ▼
supabase.auth.signUp() → POST to Supabase servers
        │
        ├── Success → Show "Check your email to confirm signup"
        │            Switch to login mode
        └── Error   → Show error message (e.g., "User already exists")

User clicks confirmation link in email → Can now log in


LOGIN FLOW:
═══════════
User fills email + password → clicks "Login"
        │
        ▼
loginUser(email, password) in auth.js
        │
        ▼
supabase.auth.signInWithPassword() → POST to Supabase servers
        │
        ├── Success → Supabase saves session in localStorage
        │            onAuthChange fires with new session
        │            showKBPanel() updates the sidebar UI
        └── Error   → Show error (e.g., "Invalid login credentials")


SESSION RESTORATION (page refresh):
════════════════════════════════════
User refreshes the page
        │
        ▼
initApp() calls getCurrentSession()
        │
        ▼
supabase.auth.getSession() reads from localStorage
        │
        ├── Session found (not expired) → showKBPanel() (auto-login, no password needed)
        └── No session → showAuthPanel() (guest mode)


LOGOUT FLOW:
═════════════
User clicks "Logout"
        │
        ▼
handleLogoutClick() in chat.js
        │
        ├── Has chat messages → openLogoutModal() (summary + confirmation)
        └── No messages      → clearUserDocuments() + signOutUser() directly
```

> **What is a JWT Token?**
> After login, Supabase gives the user an `access_token` — a JSON Web Token (JWT). It's a long encrypted string that proves the user is authenticated. We send it with API requests: `Authorization: "Bearer <token>"`. The backend verifies this with Supabase before processing sensitive requests.

---

## 7. Chat Flow

```
User types a message in the textarea
        │
        ▼
"input" event → autoGrow() resizes textarea
              → send button enabled if text exists
        │
        ▼
User presses Enter (or clicks send button ↑)
        │
        ▼
sendMessage() in chat.js
        │
        ├── Validate: empty? or waiting? → return
        ├── renderUserMessage(text) → Create user bubble in DOM
        ├── Clear textarea
        ├── showLoadingIndicator() → 3 bouncing dots
        │
        ▼
streamChatMessage() → fetch("POST /rag-chat/stream")
        │
        ▼
[FIRST CHUNK ARRIVES]
        ├── hideLoadingIndicator()
        └── renderAIMessageBubble() → Create empty AI bubble
        │
        ▼
[EACH SUBSEQUENT CHUNK]
        └── Append to accumulated text
            → renderMarkdown(fullText) → update bubble innerHTML
            → scrollToBottom()
        │
        ▼
[STREAM ENDS — onDone fires]
        ├── updateModeBadge() → "📄 From Documents" or "🤖 AI Response"
        └── Re-enable send button
```

---

## 8. File Upload Flow

```
Drop zone is shown after user logs in
        │
        ├── CLICK → fileInput.click() → OS file picker
        └── DRAG → dragover / dragleave / drop events
        │
        ▼
handleFileSelection(file, elements)
        ├── Check extension in ALLOWED_EXTENSIONS
        │     ├── Invalid → show error ❌
        │     └── Valid → continue
        ├── Store file in selectedFile variable
        └── updateDropZoneWithFile() → show filename + size + ✕ button
        │
        ▼
User clicks "⬆ Upload Document"
        │
        ▼
handleUpload() → uploadDocumentToServer(file, token)
        │
        ▼
FormData.append("file", file)
fetch("POST /upload-document", { body: formData })
        │
        ├── SUCCESS → show ✅ message, clear selection
        └── ERROR   → show ❌ message
```

---

## 9. Backend API Flow

| Endpoint | Method | Auth Required | Purpose |
|---|---|---|---|
| `/rag-chat/stream` | POST | Optional | Stream AI response |
| `/api/session/summary` | POST | Yes | Generate session summary before logout |
| `/upload-document` | POST | Yes | Upload PDF/image for RAG |
| `/clear-user-documents` | DELETE | Yes | Delete all user documents on logout |

**How the backend decides:**
- **No auth token** → Public mode → General AI knowledge only
- **Valid token + user has documents** → RAG mode (`X-Mode: rag`)
- **Valid token + no matching documents** → Fallback mode (`X-Mode: fallback`)

---

## 10. How Frontend Communicates With Backend

All communication uses the **Fetch API** — built into the browser. No libraries needed.

### JSON Request:
```javascript
const response = await fetch(API_BASE + "/api/session/summary", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + accessToken
    },
    body: JSON.stringify({ messages: chatMessages })
});
const data = await response.json();
```

### File Upload (FormData):
```javascript
const formData = new FormData();
formData.append("file", selectedFile);
// Do NOT set Content-Type — FormData sets it automatically

const response = await fetch(API_BASE + "/upload-document", {
    method: "POST",
    headers: { "Authorization": "Bearer " + accessToken },
    body: formData
});
```

### Streaming Response:
```javascript
const response = await fetch(API_BASE + "/rag-chat/stream", { ... });
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const textChunk = decoder.decode(value, { stream: true });
    updateChatBubble(textChunk);
}
```

---

## 11. How Streaming Responses Work

### Without streaming (normal API):
```
Browser  ──── Request ────►  Server
Browser  ◄── Full response ── Server  (after 5-10 seconds)
```

### With streaming:
```
Browser  ──── Request ────►  Server
Browser  ◄─── "The" ──────── Server  (instant)
Browser  ◄─── " quick" ───── Server
Browser  ◄─── " brown" ───── Server
Browser  ◄─── " fox…" ────── Server
Browser  ◄─── [DONE] ──────── Server
```

**How it works technically:**

1. **Backend:** Uses FastAPI's `StreamingResponse` with a Python generator that `yield`s tokens as the LLM generates them.

2. **Frontend:** `response.body.getReader()` returns a `ReadableStream` reader. Each `await reader.read()` pauses until the next chunk of bytes arrives. `{ done: false, value: <Uint8Array> }` on data, `{ done: true }` at end.

3. **TextDecoder:** Converts raw bytes (`Uint8Array`) to readable string. The `{ stream: true }` option handles multi-byte characters that might be split across chunks.

4. **UI update:** After each chunk, the AI bubble's `innerHTML` is updated with `marked.parse(fullText)`, making text appear word-by-word.

5. **Custom headers:** `X-Mode` and `X-Confidence` from response headers determine which badge to show above the AI bubble.

---

## 12. How to Run the Project

### Step 1: Start the backend
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
Backend available at: `http://127.0.0.1:8000`

### Step 2: Serve the frontend (pick one option)

**Option A — Python (no install needed):**
```bash
cd frontend
python -m http.server 8080
```

**Option B — VS Code Live Server:**
Right-click `chat.html` → "Open with Live Server"

**Option C — Node.js:**
```bash
npx serve frontend -p 8080
```

### Step 3: Open in browser
Visit `http://localhost:8080` → auto-redirects to `chat.html`

> **Why not just double-click `chat.html`?**
> ES Modules (`import`/`export`) and CDN scripts require HTTP headers that the `file://` protocol doesn't provide. You need a local HTTP server.

---

## 13. Common Interview Questions & Answers

---

**Q1: You converted from React to Vanilla JavaScript. What were the main challenges?**

> **A:** The biggest challenge was replacing React's automatic re-rendering. In React, calling `setState()` triggers a re-render and the UI updates automatically. In vanilla JS, I manually update the DOM after every data change — for example, calling `renderUserMessage()` to create and append a `<div>` element after each message. I also had to handle Supabase auth state changes using `onAuthStateChange()` (an event listener) instead of React's `useEffect`. Overall the logic is simpler — just functions and DOM manipulation with no virtual DOM involved.

---

**Q2: How does the Fetch API work? Why use it instead of axios?**

> **A:** `fetch()` is a built-in browser function for HTTP requests. It returns a Promise, so we use `async/await` to wait for the response. I chose it because it requires zero installation — it's native to all modern browsers. The key difference from axios: `fetch()` does NOT automatically throw errors on 4xx/5xx status codes. I manually check `if (!response.ok) { throw new Error(...) }` after every fetch call. axios does this automatically, but adding a library just for that convenience isn't worth it in a simple app.

---

**Q3: Explain how streaming responses work.**

> **A:** The backend sends the AI response as a stream — yielding small text chunks as they're generated, rather than waiting for the full answer. On the frontend, `response.body.getReader()` gives a `ReadableStream` reader. Inside a `while (true)` loop, `await reader.read()` pauses until the next chunk (raw bytes in `Uint8Array`) arrives. `TextDecoder.decode()` converts bytes to text. After each chunk, I update the AI bubble's `innerHTML` with the accumulated text run through `marked.parse()`. This makes text appear word-by-word in real time, like ChatGPT.

---

**Q4: What is a JWT token and how is it used here?**

> **A:** JWT (JSON Web Token) is an encrypted string that proves a user's identity. After login, Supabase gives back an `access_token`. I attach it to every protected API request in the Authorization header: `"Bearer <token>"`. The FastAPI backend verifies this by calling Supabase's auth API. If valid, the request is processed. If invalid or missing, the server returns 401 Unauthorized. The frontend checks `response.ok` and shows an error if authentication fails.

---

**Q5: How does drag-and-drop file upload work?**

> **A:** Three DOM events power drag-and-drop: `dragover` fires while a file is dragged over the zone (we call `e.preventDefault()` — without it, the browser would navigate to the file URL). `dragleave` fires when the file is dragged away (we remove the visual highlight). `drop` fires when the file is released — we access it via `event.dataTransfer.files[0]`. After validation, the file is uploaded using `FormData` — a built-in object that formats data as `multipart/form-data`. We do NOT manually set `Content-Type` because `FormData` sets it automatically with the correct boundary string.

---

**Q6: How do you handle loading states without a framework?**

> **A:** Three simple techniques: (1) `button.disabled = true` to prevent double-clicks. (2) `element.style.display = "none"` to hide/show elements. (3) `button.textContent = "Please wait…"` to update button labels. I always put the reset code in a `finally` block so the UI is restored even if an error occurs — `finally` always runs whether the `try` block succeeded or the `catch` block handled an error.

---

**Q7: How does the app stay logged in after a page refresh?**

> **A:** Supabase automatically saves the session (access token + refresh token) in `localStorage` when the user logs in. On page load, `initApp()` calls `supabase.auth.getSession()` which reads from `localStorage`. If a valid, non-expired session is found, the user is automatically logged in without typing their password again. If the access token has expired, Supabase uses the refresh token to silently get a new one. This is all handled internally by the Supabase SDK.

---

**Q8: Why use ES Modules instead of regular script tags?**

> **A:** ES Modules (`import`/`export`) let us split code across files with explicit dependencies. Without modules, all JavaScript would be in one giant file, or we'd share data through global variables which is hard to maintain. With modules, each file declares exactly what it needs (`import { streamChatMessage } from "./api.js"`). The browser handles loading automatically. The `type="module"` attribute on the `<script>` tag also automatically defers execution until the DOM is ready.

---

**Q9: What is Markdown and why do AI responses need conversion?**

> **A:** Markdown is a plain-text formatting language. `**bold**` means bold text, `## Heading` means a heading, backticks mark code. The AI returns responses in Markdown because it's compact and easy for LLMs to generate. But browsers can't display Markdown directly — users would see literal asterisks. We use `marked.js` (loaded from CDN) to convert the Markdown string to HTML with `marked.parse(text)`, then set it as `element.innerHTML` so the browser renders it with proper formatting.

---

**Q10: What is the difference between `innerHTML` and `textContent`?**

> **A:** `textContent` sets plain text — the browser doesn't interpret HTML tags. `element.textContent = "<b>Hello</b>"` displays literally `<b>Hello</b>` on screen. `innerHTML` sets HTML — the browser parses and renders it. `element.innerHTML = "<b>Hello</b>"` displays **Hello** in bold. In this app, user messages use `textContent` (plain text, safe from XSS attacks) while AI messages use `innerHTML` (Markdown-converted HTML from our trusted backend).

---

**Q11: How does the session summary download work?**

> **A:** The browser has no direct "save file" API, so I use the Blob + Object URL trick. First, create a `Blob` (an in-memory file object) with the text: `new Blob([summaryText], { type: "text/plain" })`. Then `URL.createObjectURL(blob)` generates a temporary URL like `blob:http://localhost/abc123`. I create a hidden `<a>` element with `href` pointing to this URL and `download` set to the filename. Programmatically clicking it triggers the browser's download. Finally, `URL.revokeObjectURL()` releases the memory.

---

*This documentation is designed to help developers — especially freshers — understand and confidently explain this codebase in technical interviews.*
