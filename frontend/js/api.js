/* =========================================================
   api.js — ALL BACKEND COMMUNICATION
   =========================================================
   PURPOSE:
     This file contains every function that talks to the
     FastAPI backend server. All fetch() calls live here.

   WHY SEPARATE FROM OTHER FILES?
     Keeping API calls in one place follows the "Single
     Responsibility Principle". If the backend URL or
     request format changes, you only update THIS file.

   FUNCTIONS IN THIS FILE:
     1. streamChatMessage(...)  — Sends a message and reads the AI's
                                  streaming response chunk by chunk
     2. fetchSessionSummary(...)— Gets a summary of the session before logout
     3. uploadDocumentToServer(...)— Uploads a PDF/image file
     4. clearUserDocuments(...)  — Deletes user's documents on logout

   HOW FETCH() WORKS (for beginners):
     fetch() is a built-in browser function that sends HTTP
     requests. It returns a Promise — meaning it doesn't block
     the page. You use "await" to wait for the response.

     Example:
       const response = await fetch("http://localhost:8000/chat");
       const data = await response.json();

   INTERVIEW TIP:
     "I used the Fetch API for all HTTP requests. It's built
      into modern browsers so no libraries are needed."
   ========================================================= */

import { API_BASE } from "./config.js";


// ── streamChatMessage ─────────────────────────────────────
//
// WHAT IT DOES:
//   Sends the user's message to the backend's /rag-chat/stream
//   endpoint and reads the AI's response as a STREAM — meaning
//   we receive the response word by word as it's generated,
//   instead of waiting for the entire response to finish.
//
// WHY STREAMING?
//   Streaming makes the AI feel much faster and more interactive.
//   The user sees words appearing in real time (like ChatGPT),
//   rather than staring at a blank screen for 5-10 seconds.
//
// HOW STREAMING WORKS (step by step):
//   1. We send a POST request to /rag-chat/stream
//   2. The backend starts generating the AI response and sends
//      it back in small "chunks" (pieces of text)
//   3. We use a "ReadableStream reader" to read these chunks
//      as they arrive
//   4. For each chunk, we call the onChunk callback to update the UI
//   5. When the stream is done, we call onDone
//   6. If anything goes wrong, we call onError
//
// PARAMETERS:
//   - message      : The user's typed message (string)
//   - chatHistory  : Last few messages for context (array)
//   - accessToken  : Supabase auth token (string or null)
//   - onChunk      : Function called with each text piece as it arrives
//   - onDone       : Function called when the full response is received
//   - onError      : Function called if something goes wrong
//
// WHAT HAPPENS IF REMOVED:
//   The chat would stop working entirely — there would be no
//   way to send messages to the AI.
//
export async function streamChatMessage(
  message,
  chatHistory,
  accessToken,
  onChunk,
  onDone,
  onError
) {
  try {
    // Build the request headers
    // Content-Type tells the server we're sending JSON data
    const requestHeaders = {
      "Content-Type": "application/json",
    };

    // If the user is logged in, attach their auth token
    // The backend uses this to identify the user and search their documents
    // Without this header, the backend treats the user as "public" (no documents)
    if (accessToken) {
      requestHeaders["Authorization"] = "Bearer " + accessToken;
    }

    // Build the request body — this is the data we send to the backend
    // chat_history gives the AI context of previous messages in this session
    const requestBody = {
      message: message,
      chat_history: chatHistory,
    };

    // Send the HTTP POST request to the backend
    // "await" pauses here until the server sends back the response HEADERS
    // (not the full body — the body arrives as a stream)
    const response = await fetch(API_BASE + "/rag-chat/stream", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody), // Convert JS object to JSON string
    });

    // Check if the server returned an error status (like 400, 500)
    if (!response.ok) {
      // Try to read the error details from the response body
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || "Server error " + response.status);
    }

    // Read the response mode and confidence from custom HTTP headers
    // The backend sets X-Mode to "rag" (used your document) or "fallback" (general AI)
    // X-Confidence is "High", "Medium", "Low", or "Very Low"
    const responseMode       = response.headers.get("X-Mode")       || "fallback";
    const responseConfidence = response.headers.get("X-Confidence") || "N/A";

    // ── THE STREAMING PART ────────────────────────────────
    // response.body is a ReadableStream — a stream of raw bytes
    // getReader() gives us an object we can use to read from the stream
    const streamReader = response.body.getReader();

    // TextDecoder converts raw bytes (Uint8Array) into a readable string
    const textDecoder = new TextDecoder();

    // We'll accumulate the full response text here
    let fullResponseText = "";

    // Keep reading until the stream is done
    // This is a "while true" loop that breaks when the stream ends
    while (true) {
      // reader.read() waits for the next chunk of data from the server
      // "done" is true when the stream has ended
      // "value" is a Uint8Array (raw bytes) of the chunk
      const { done, value } = await streamReader.read();

      // If the stream is finished, exit the loop
      if (done) break;

      // Convert the raw bytes to a text string
      // { stream: true } tells the decoder this might be a partial character
      // (important for multi-byte characters like emoji or Chinese text)
      const textChunk = textDecoder.decode(value, { stream: true });

      // Add this chunk to our accumulated full text
      fullResponseText = fullResponseText + textChunk;

      // Call the callback with this text chunk so the UI can display it
      // This is what makes the text appear word-by-word in the chat
      onChunk(textChunk);
    }

    // Stream finished — call onDone with mode, confidence, and full text
    onDone(responseMode, responseConfidence, fullResponseText);

  } catch (error) {
    // Something went wrong — call onError with a user-friendly message
    if (error.message.includes("Failed to fetch")) {
      // "Failed to fetch" means the backend server is not reachable
      onError("Cannot reach the server. Is the backend running?");
    } else {
      onError(error.message);
    }
  }
}


// ── fetchSessionSummary ───────────────────────────────────
//
// WHAT IT DOES:
//   Sends the current chat messages to the backend and asks
//   it to generate a professional summary of the session.
//   This is called when the user clicks "Logout".
//
// WHY?
//   Users might want to remember what they discussed. The summary
//   gives them a chance to copy or download their conversation
//   highlights before their data is deleted.
//
// PARAMETERS:
//   - messages     : Array of all chat messages in this session
//   - accessToken  : Required — only logged-in users can get summaries
//
// RETURNS:
//   The summary text (string) from the backend, or throws an error.
//
// WHAT HAPPENS IF REMOVED:
//   The logout modal would have no summary to display. Users would
//   lose their conversation history without any review.
//
export async function fetchSessionSummary(messages, accessToken) {
  // This endpoint requires authentication — throw if no token
  if (!accessToken) {
    throw new Error("Authentication required for session summary.");
  }

  const response = await fetch(API_BASE + "/api/session/summary", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + accessToken,
    },
    body: JSON.stringify({ messages: messages }), // Send the message history
  });

  // If the server returned an error, throw it
  if (!response.ok) {
    throw new Error("Failed to generate summary. Status: " + response.status);
  }

  // Parse the JSON response and return just the summary text
  const data = await response.json();
  return data.summary;
}


// ── uploadDocumentToServer ────────────────────────────────
//
// WHAT CHANGED IN v4 (async upload):
//   Previously: this function waited for the ENTIRE processing pipeline
//     (OCR, embedding, DB save) to complete before returning.
//     The server held the connection open for up to 60 seconds.
//
//   Now: The backend returns HTTP 202 in ~200ms with a job_id.
//     This function returns that initial { job_id, status: "queued" }
//     object. The caller (upload.js) then starts polling the status
//     endpoint every 2 seconds using pollUploadStatus().
//
// WHAT STAYS THE SAME:
//   The file is still sent as multipart/form-data.
//   The Authorization header is still required.
//   The endpoint path is still /upload-document.
//   The backend still validates the file type before returning.
//
// PARAMETERS:
//   - file         : The File object from a file input or drag-drop
//   - accessToken  : Required — document upload needs authentication
//
// RETURNS:
//   { job_id, status: "queued", filename }  (from the 202 response)
//   Throws an error if validation fails (400) or server is unreachable.
//
export async function uploadDocumentToServer(file, accessToken) {
  // Create a FormData object — think of it as a form with a file attached
  const formData = new FormData();
  formData.append("file", file); // "file" must match the backend's parameter name

  // Note: NO "Content-Type" header — FormData sets it automatically
  const response = await fetch(API_BASE + "/upload-document", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
    },
    body: formData,
  });

  // Parse the response body regardless of status (error body has useful info)
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // 400 = bad file type, 401 = not logged in, 500 = server error
    throw new Error(data.detail || "Server error " + response.status);
  }

  // On success: data = { job_id: "...", status: "queued", filename: "..." }
  // The caller must poll /upload-document/status/{job_id} for progress.
  return data;
}


// ── pollUploadStatus ──────────────────────────────────────
//
// WHAT IT DOES:
//   Makes a single GET request to /upload-document/status/{job_id}
//   and returns the current job state.
//
//   Called by upload.js every 2 seconds after Phase 1 (upload) completes.
//
// WHY "poll" instead of WebSocket or Server-Sent Events?
//   Polling is the simplest approach and perfectly adequate here.
//   A single job takes 5–60 seconds. Polling every 2 seconds means
//   at most 30 HTTP requests per job — completely negligible load.
//   WebSockets add complexity (connection management, reconnects) with
//   no meaningful benefit for a single-file upload flow.
//
// PARAMETERS:
//   - jobId        : The job ID returned by uploadDocumentToServer()
//   - accessToken  : JWT token — the status endpoint requires auth
//
// RETURNS:
//   {
//     job_id   : string,
//     status   : "queued"|"extracting"|"ocr"|"chunking"|"embedding"|"saving"|"ready"|"error",
//     progress : number (0–100),
//     message  : string (human-readable step description),
//     timings  : object (per-stage seconds),
//     result   : object|null  (final data, only when status = "ready"),
//     error    : string|null  (only when status = "error")
//   }
//
// WHAT HAPPENS IF REMOVED:
//   The frontend would have no way to track processing progress.
//   The upload would appear to complete instantly (Phase 1 only) with
//   no indication that background work is still running.
//
export async function pollUploadStatus(jobId, accessToken) {
  const response = await fetch(
    API_BASE + "/upload-document/status/" + jobId,
    {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + accessToken,
      },
    }
  );

  // Parse the response body
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // 404 = job expired, 403 = wrong user
    throw new Error(data.detail || "Status check failed: " + response.status);
  }

  return data;
}


// ── clearUserDocuments ────────────────────────────────────
//
// WHAT IT DOES:
//   Sends a DELETE request to the backend, which permanently
//   removes all documents and text chunks belonging to the
//   currently logged-in user from the database.
//
// WHEN IS THIS CALLED?
//   Immediately before the user is signed out of Supabase.
//   The app promises users "🔐 Files stay private and are
//   securely deleted on logout" — this function fulfills that promise.
//
// WHY DELETE ON LOGOUT?
//   Privacy protection. If documents weren't deleted, they would
//   stay in the database even after the user logs out. If someone
//   else logged in on the same computer, they could potentially
//   access them.
//
// PARAMETERS:
//   - accessToken  : Required to identify which user's docs to delete
//
// WHAT HAPPENS IF REMOVED:
//   User documents would accumulate in the database forever.
//   The privacy guarantee would be broken.
//
export async function clearUserDocuments(accessToken) {
  if (!accessToken) return; // Nothing to clear if not logged in

  try {
    const response = await fetch(API_BASE + "/clear-user-documents", {
      method: "DELETE",
      headers: {
        "Authorization": "Bearer " + accessToken,
      },
    });

    // We don't throw on failure here — if this fails, we still
    // want the user to be signed out. Silently log the error.
    if (!response.ok) {
      console.error("[api] Failed to clear documents. Status:", response.status);
    }
  } catch (networkError) {
    // If the backend is unreachable, don't block the logout
    console.error("[api] Could not reach server to clear documents:", networkError);
  }
}
