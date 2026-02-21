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
const API_BASE = "http://127.0.0.1:8000";

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

  // ── Chat state ──────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);

  // ── PDF upload state ────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile]     = useState(null);
  const [uploading, setUploading]           = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [isDragging, setIsDragging]         = useState(false);

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

  // ── Auth: logout ────────────────────────────────────────────────────────
  const handleLogout = async () => {
    // Step 1: Delete user's documents from the vector DB
    if (session?.access_token) {
      try {
        await fetch(`${API_BASE}/clear-user-documents`, {
          method:  "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        logger_info("Documents cleared for user on logout.");
      } catch {
        // Non-blocking — still sign out even if deletion fails
      }
    }
    // Step 2: Sign out from Supabase
    await supabase.auth.signOut();
    setMessages([]);
    setSelectedFile(null);
    setUploadFeedback(null);
  };

  function logger_info(msg) { console.info("[App]", msg); }

  // ── Send chat message ───────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);

    try {
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }

      const res = await fetch(`${API_BASE}/rag-chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "ai", text: data.response, mode: data.mode },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          text: err.message.includes("Failed to fetch")
            ? "Cannot reach the server. Is the backend running?"
            : err.message,
        },
      ]);
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

  // ── PDF upload ──────────────────────────────────────────────────────────
  const handleFileSelect = (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadFeedback({ type: "error", text: "❌ Only PDF files are accepted." });
      setTimeout(() => setUploadFeedback(null), 4000);
      return;
    }
    setSelectedFile(file);
    setUploadFeedback(null);
  };

  const uploadPDF = async () => {
    if (!selectedFile || uploading || !user) return;

    setUploading(true);
    setUploadFeedback(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch(`${API_BASE}/upload-pdf`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body:    formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.detail || `Server error ${res.status}`);
      }

      setUploadFeedback({ type: "success", text: data.message || "✅ PDF uploaded!" });
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
          <div className="sidebar-logo-icon">🧠</div>
          <div><h1>MyChatbot</h1></div>
        </div>

        {/* ── AUTH PANEL ── */}
        {!user ? (
          /* Not logged in — show login/signup form */
          <div className="auth-panel">
            <p className="sidebar-title">
              {authMode === "login" ? "Login to upload PDFs" : "Create an account"}
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
              onClick={() => { setAuthMode(m => m === "login" ? "signup" : "login"); setAuthError(""); }}
            >
              {authMode === "login" ? "No account? Sign up" : "Already have an account? Login"}
            </button>

            
            <p className="sidebar-hint">
              ⚠️ Current version only supports text-based PDFs. Files are private & deleted on logout.

            </p>
          </div>
        ) : (
          /* Logged in — show user info + PDF upload */
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
                accept=".pdf"
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
                  <span className="drop-text">{isDragging ? "Drop PDF here" : "Click or drag PDF here"}</span>
                  <span className="drop-hint">PDF files only</span>
                </div>
              )}
            </div>

            <button
              className="btn-upload"
              onClick={uploadPDF}
              disabled={!selectedFile || uploading}
            >
              {uploading ? <span className="upload-spinner">Uploading…</span> : "⬆ Upload PDF"}
            </button>

            {uploadFeedback && (
              <div className={`upload-feedback ${uploadFeedback.type}`}>
                {uploadFeedback.text}
              </div>
            )}

            <p className="sidebar-hint">
              PDFs stay private and are deleted when you log out.
            </p>
          </>
        )}
      </aside>

      {/* ── Chat Main ────────────────────────────────────────────── */}
      <main className="chat-main">
        <header className="chat-header">
          <div className="chat-header-dot" />
          <h2>Your Private AI Assistant — Powered by RAG</h2>
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
                  ? "Start chatting! Upload a PDF to explore its content."
                  : "Public Mode Active — Chat freely, or log in to unlock RAG search with your documents"
                }
              </p>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`message-row ${msg.role}`}>
                  {msg.role === "ai" && (
                    <span className={`mode-badge ${msg.mode === "rag" ? "rag" : "fall"}`}>
                      {msg.mode === "rag" ? "📄 From Documents" : "🤖 AI Response"}
                    </span>
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
                  ? "Ask a question about your PDF… (Shift+Enter for newline)"
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
    </div>
  );
}