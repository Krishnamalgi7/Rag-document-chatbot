import { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import "./App.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Supabase client ──────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── Backend URL ──────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

export default function App() {
  // ── Auth state ──────────────────────────────────────────────────────────
  const [user, setUser]         = useState(null);
  const [session, setSession]   = useState(null);
  const [authEmail, setAuthEmail]       = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode]         = useState("login"); // "login" | "signup"
  const [authLoading, setAuthLoading]   = useState(false);
  const [authError, setAuthError]       = useState("");
  const [isMorphing, setIsMorphing]     = useState(false);

  // ── Chat state ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);

  // ── Document upload state ───────────────────────────────────────────────
  const [selectedFile, setSelectedFile]     = useState(null);
  const [uploading, setUploading]           = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [isDragging, setIsDragging]         = useState(false);

  // ── Session Handover state ──────────────────────────────────────────────
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [sessionSummary, setSessionSummary]     = useState("");
  const [gettingSummary, setGettingSummary]     = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);
  const fileInputRef   = useRef(null);

  // ── Initialize Supabase auth session ───────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Auto-scroll ─────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ── Auth: login / signup ────────────────────────────────────────────────
  const handleAuthModeToggle = () => {
    setIsMorphing(true);
    setAuthError("");
    
    // Wait for morph-out animation to complete
    setTimeout(() => {
      setAuthMode(m => m === "login" ? "signup" : "login");
      setIsMorphing(false);
    }, 250); // Match the morphOut animation duration
  };

  const handleAuth = async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError("Email and password are required.");
      return;
    }
    setAuthLoading(true);
    setAuthError("");

    try {
      if (authMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email:    authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email:    authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        setAuthError("✅ Check your email to confirm signup, then log in.");
        setAuthMode("login");
        return;
      }
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // ── Auth: logout interception ───────────────────────────────────────────
  const handleLogout = async () => {
    // Intercept logout to fetch session summary and show modal
    if (session?.access_token) {
      setGettingSummary(true);
      setShowSummaryModal(true);
      try {
        const res = await fetch(`${API_BASE}/api/session/summary`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ messages }),
        });
        if (!res.ok) throw new Error("Failed to generate summary");
        const data = await res.json();
        setSessionSummary(data.summary);
      } catch (err) {
        console.error("Summary error:", err);
        setSessionSummary("Your session has ended, but we couldn't generate a summary at this time.");
      } finally {
        setGettingSummary(false);
      }
    } else {
      finalizeLogout();
    }
  };

  const finalizeLogout = async () => {
    if (session?.access_token) {
      try {
        await fetch(`${API_BASE}/clear-user-documents`, {
          method:  "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        console.info("[App]", "Documents cleared for user on logout.");
      } catch (err) {
        console.error("Failed to clear documents:", err);
      }
    }
    // Sign out from Supabase only after clearing documents
    await supabase.auth.signOut();
    setMessages([]);
    setSelectedFile(null);
    setUploadFeedback(null);
    setShowSummaryModal(false);
    setSessionSummary("");
  };

  const copySummary = () => {
    navigator.clipboard.writeText(sessionSummary);
  };

  const downloadSummary = () => {
    const blob = new Blob([sessionSummary], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ArchAI_Session_Summary.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  function logger_info(msg) { console.info("[App]", msg); }

  // ── Send chat message (STREAMING) ─────────────────────────────────────
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    // Add user message
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);

    // Placeholder AI message that we'll fill token by token
    const aiMsgIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: "ai", text: "", mode: "loading", confidence: null },
    ]);

    try {
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }

      const res = await fetch(`${API_BASE}/rag-chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: text,
          // Send last 6 messages as chat history for context
          chat_history: messages.slice(-6).map((m) => ({
            role: m.role === "ai" ? "assistant" : m.role,
            text: m.text,
            mode: m.mode,
          })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }

      // Read mode and confidence from response headers
      const mode       = res.headers.get("X-Mode")       || "fallback";
      const confidence = res.headers.get("X-Confidence") || "N/A";
      const sourceRaw  = res.headers.get("X-Source")     || "";
      // Re-add emojis on frontend (headers are ASCII-only)
      const source = sourceRaw === "From your document"
        ? "📄 Answered from your document"
        : "🤖 Answered from general AI knowledge";

      // Update the placeholder message with mode/confidence immediately
      setMessages((prev) =>
        prev.map((m, i) =>
          i === aiMsgIndex ? { ...m, mode, confidence } : m
        )
      );

      // Read stream token by token
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Append each token to the AI message
        setMessages((prev) =>
          prev.map((m, i) =>
            i === aiMsgIndex ? { ...m, text: m.text + chunk } : m
          )
        );
      }
    } catch (err) {
      // Replace placeholder with error
      setMessages((prev) =>
        prev.map((m, i) =>
          i === aiMsgIndex
            ? {
                role: "error",
                text: err.message.includes("Failed to fetch")
                  ? "Cannot reach the server. Is the backend running?"
                  : err.message,
              }
            : m
        )
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Document upload ─────────────────────────────────────────────────────
  const handleFileSelect = (file) => {
    if (!file) return;
    const allowedExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"];
    const isAllowed = allowedExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
    if (!isAllowed) {
      setUploadFeedback({ type: "error", text: "❌ Only PDF and Image files are accepted." });
      setTimeout(() => setUploadFeedback(null), 4000);
      return;
    }
    setSelectedFile(file);
    setUploadFeedback(null);
  };

  const uploadDocument = async () => {
    if (!selectedFile || uploading || !user) return;

    setUploading(true);
    setUploadFeedback(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch(`${API_BASE}/upload-document`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body:    formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.detail || `Server error ${res.status}`);
      }

      setUploadFeedback({ type: "success", text: data.message || "✅ Document uploaded!" });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTimeout(() => setUploadFeedback(null), 6000);
    } catch (err) {
      setUploadFeedback({
        type: "error",
        text: err.message.includes("Failed to fetch")
          ? "❌ Cannot reach the server."
          : `❌ ${err.message}`,
      });
      setTimeout(() => setUploadFeedback(null), 5000);
    } finally {
      setUploading(false);
    }
  };

  // Drag-and-drop
  const onDragOver  = useCallback((e) => { e.preventDefault(); setIsDragging(true); }, []);
  const onDragLeave = useCallback(() => setIsDragging(false), []);
  const onDrop      = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files[0]);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🤖</div>
          <div><h1>Arch AI</h1></div>
        </div>

        {/* ── AUTH PANEL ── */}
        {!user ? (
          /* Not logged in — show login/signup form */
          <div className={`auth-panel ${isMorphing ? 'morphing-out' : ''}`}>
            <p className="sidebar-title">
              {authMode === "login" ? "Login to upload Documents" : "Create an account"}
            </p>

            <input
              className="auth-input"
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAuth()}
            />
            <input
              className="auth-input"
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAuth()}
            />

            {authError && (
              <p className={`auth-msg ${authError.startsWith("✅") ? "success" : "error"}`}>
                {authError}
              </p>
            )}

            <button className="btn-auth" onClick={handleAuth} disabled={authLoading}>
              {authLoading ? "Please wait…" : authMode === "login" ? "Login" : "Sign Up"}
            </button>

            <button
              className="btn-auth-toggle"
              onClick={handleAuthModeToggle}
            >
              {authMode === "login" ? "No account? Sign up" : "Already have an account? Login"}
            </button>

            
            <p className="sidebar-hint">
              📂 System supports PDFs and images kindly authenticate to use these features or just chat freely   
              
            </p>
            <p className="sidebar-hint">
              🔐 Files stay private and are securely deleted on logout.
            </p>
          </div>
        ) : (
          /* Logged in — show user info + Document upload */
          <>
            <div className="user-info">
              <span className="user-email" title={user.email}>👤 {user.email}</span>
              <button className="btn-logout" onClick={handleLogout} title="Logout clears all your uploaded documents">
                Logout
              </button>
            </div>

            <p className="sidebar-title">Knowledge Base</p>

            {/* Drop zone */}
            <div
              className={`drop-zone ${isDragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => !selectedFile && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                style={{ display: "none" }}
                onChange={(e) => handleFileSelect(e.target.files[0])}
              />

              {selectedFile ? (
                <div className="file-selected">
                  <div className="file-icon">📄</div>
                  <div className="file-info">
                    <span className="file-name">{selectedFile.name}</span>
                    <span className="file-size">{(selectedFile.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <button
                    className="btn-remove-file"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                      setUploadFeedback(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    title="Remove"
                  >✕</button>
                </div>
              ) : (
                <div className="drop-zone-placeholder">
                  <span className="drop-icon">📂</span>
                  <span className="drop-text">{isDragging ? "Drop Document here" : "Click or drag Document here"}</span>
                  <span className="drop-hint">PDF or Image files</span>
                </div>
              )}
            </div>

            <button
              className="btn-upload"
              onClick={uploadDocument}
              disabled={!selectedFile || uploading}
            >
              {uploading ? <span className="upload-spinner">Uploading…</span> : "⬆ Upload Document"}
            </button>

            {uploadFeedback && (
              <div className={`upload-feedback ${uploadFeedback.type}`}>
                {uploadFeedback.text}
              </div>
            )}

         <p className="sidebar-hint"> 🔐 At logout, your documents are securely deleted to protect your privacy. </p>
          </>
        )}
      </aside>

      {/* ── Chat Main ────────────────────────────────────────────── */}
      <main className="chat-main">
        <header className="chat-header">
          <div className="chat-header-dot" />
          <h2>Ephemeral AI Assistant — Powered by RAG</h2>
          {!user && (
            <span className="public-badge">🔓 Public Mode</span>
          )}
        </header>

        <div className="chat-messages">
          {messages.length === 0 && !loading ? (
            <div className="chat-empty">
              <div className="chat-empty-icon">💬</div>
              <h3>Start a conversation</h3>
              <p>
                {user
                  ? "Start chatting! Upload a document to explore its content."
                  : "Public Mode Active — Chat freely, or log in to unlock RAG search with your documents"
                }
              </p>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`message-row ${msg.role}`}>
                  {msg.role === "ai" && msg.mode !== "loading" && (
                    <span className={`mode-badge ${msg.mode === "rag" ? "rag" : "fall"}`}>
                      {msg.mode === "rag"
                        ? `📄 From Documents${msg.confidence ? ` · ${msg.confidence} confidence` : ""}`
                        : "🤖 AI Response"}
                    </span>
                  )}
                  {msg.role === "ai" && msg.mode === "loading" && (
                    <span className="mode-badge fall">⏳ Thinking…</span>
                  )}
                  <div className="message-bubble">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="message-row ai">
                  <div className="loading-bubble">
                    <div className="loading-dot" />
                    <div className="loading-dot" />
                    <div className="loading-dot" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="chat-input-area">
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-textarea"
              rows={1}
              placeholder={
                user
                  ? "Ask a question about your documents… (Shift+Enter for newline)"
                  : "Ask anything… (Login to enable document search)"
              }
              value={input}
              onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              className="btn-send"
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              title="Send"
            >↑</button>
          </div>
          <p className="input-hint">
            {user
              ? "Logged in · Private documents · Auto-deleted on logout"
              : "Public mode · No documents · All responses use general AI knowledge"
            }
          </p>
        </div>
      </main>

      {/* ── Session Handover Modal ────────────────────────────────────── */}
      {showSummaryModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <header className="modal-header">
              <h2>End of Session Summary</h2>
              <button 
                className="btn-close-modal" 
                onClick={() => {
                  setShowSummaryModal(false);
                  setGettingSummary(false);
                }}
                disabled={gettingSummary}
                title="Cancel logout"
              >✕</button>
            </header>

            <div className="modal-body">
              {gettingSummary ? (
                <div className="summary-loading">
                  <div className="loading-spinner"></div>
                  <p>Analyzing chat history and generating your session summary...</p>
                </div>
              ) : (
                <div className="summary-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {sessionSummary}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            <footer className="modal-footer">
              <div className="modal-tools">
                <button 
                  className="btn-outline" 
                  onClick={copySummary} 
                  disabled={gettingSummary || !sessionSummary}
                >
                  📋 Copy Text
                </button>
                <button 
                  className="btn-outline" 
                  onClick={downloadSummary} 
                  disabled={gettingSummary || !sessionSummary}
                >
                  📥 Download .txt
                </button>
              </div>
              <div className="modal-actions">
                <button 
                  className="btn-cancel" 
                  onClick={() => setShowSummaryModal(false)}
                  disabled={gettingSummary}
                >
                  Cancel
                </button>
                <button 
                  className="btn-danger" 
                  onClick={finalizeLogout}
                  disabled={gettingSummary}
                >
                  Finalize Logout & Delete Data
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

    </div>
  );
}