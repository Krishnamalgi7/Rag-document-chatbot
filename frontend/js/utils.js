/* =========================================================
   utils.js — REUSABLE HELPER FUNCTIONS
   =========================================================
   PURPOSE:
     This file contains small, general-purpose functions
     that are used by multiple other JS files.

     Instead of writing the same logic in chat.js AND modal.js,
     we write it once here and import it where needed.

   FUNCTIONS IN THIS FILE:
     1. autoGrow(textarea)     — Makes textarea expand as you type
     2. renderMarkdown(text)   — Converts Markdown text to HTML
     3. showElement(el)        — Shows a hidden DOM element
     4. hideElement(el)        — Hides a DOM element

   INTERVIEW TIP:
     "Utility functions follow the DRY principle (Don't Repeat
      Yourself). I put reusable logic in utils.js so it can
      be imported by any other module."
   ========================================================= */

// ── autoGrow ─────────────────────────────────────────────
//
// WHAT IT DOES:
//   Makes the textarea in the chat input automatically grow
//   taller as the user types more lines. Without this, the
//   textarea would stay one line tall and the text would
//   just scroll inside it, which is bad UX.
//
// WHY IT WORKS THE WAY IT DOES:
//   Step 1: Set height to "auto" — this shrinks the textarea
//           to its minimum size. This is needed so that when
//           the user deletes lines, the textarea can shrink back.
//   Step 2: Read el.scrollHeight — this is the ACTUAL content
//           height (how tall the textarea needs to be to fit
//           all the text without scrolling).
//   Step 3: Set height = scrollHeight, but cap it at 160px.
//           This prevents the input from growing too tall.
//
// WHAT HAPPENS IF REMOVED:
//   The textarea stays a fixed 1-line height. Users typing
//   multi-line messages would have to scroll inside the tiny box.
//
export function autoGrow(textarea) {
  // Step 1: Reset to minimum height so scrollHeight is accurate
  textarea.style.height = "auto";

  // Step 2 & 3: Grow to content height, max 160px
  const maxHeight = 160; // pixels — about 6 lines of text
  textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
}


// ── renderMarkdown ────────────────────────────────────────
//
// WHAT IT DOES:
//   Converts Markdown-formatted text (like "**bold**" and
//   "# Heading") into real HTML (like "<strong>bold</strong>"
//   and "<h1>Heading</h1>") so the browser can display it
//   with proper formatting.
//
// WHY WE NEED THIS:
//   The AI backend sends responses as Markdown text. Without
//   converting it, the user would see literal asterisks and
//   hash symbols instead of formatted text.
//
// HOW IT WORKS:
//   We use the "marked" library (loaded from CDN in chat.html).
//   marked.parse() is the function that does the conversion.
//   It returns an HTML string that we set as innerHTML.
//
// WHAT IS marked.js?
//   A well-known JavaScript library that parses Markdown.
//   It replaces react-markdown from the old React version.
//   We loaded it via <script> tag in chat.html, so it's
//   available globally as window.marked.
//
// WHAT HAPPENS IF REMOVED:
//   AI responses would show raw Markdown syntax like "**word**"
//   instead of rendered bold text.
//
// SECURITY NOTE:
//   marked.parse() does NOT sanitize HTML. Since our AI
//   responses come from our own trusted backend, this is
//   acceptable. For user-generated content, you'd add
//   DOMPurify for sanitization.
//
export function renderMarkdown(markdownText) {
  // If marked library isn't loaded yet, just return plain text
  if (typeof window.marked === "undefined") {
    return markdownText;
  }

  // Convert the Markdown string to an HTML string
  // marked.parse() returns a string like "<p>Hello <strong>world</strong></p>"
  return window.marked.parse(markdownText);
}


// ── showElement ───────────────────────────────────────────
//
// WHAT IT DOES:
//   Makes a hidden DOM element visible by removing the
//   "display: none" inline style.
//
// WHY A HELPER FUNCTION?
//   Because we show/hide many elements across chat.js,
//   modal.js, and auth.js. Having a named function makes
//   the code read like plain English:
//     showElement(loadingSpinner)  ← easy to understand
//     spinner.style.display = ""  ← less clear
//
export function showElement(element) {
  // Setting display to "" (empty string) removes the inline style,
  // which lets the CSS class's display property take over.
  element.style.display = "";
}


// ── hideElement ───────────────────────────────────────────
//
// WHAT IT DOES:
//   Hides a DOM element by setting display to "none".
//   The element still exists in the HTML — it's just invisible.
//
// DIFFERENCE FROM removing the element:
//   hideElement keeps the element in the DOM (it can be
//   shown again later). Removing it from the DOM would
//   require re-creating it entirely.
//
export function hideElement(element) {
  element.style.display = "none";
}
