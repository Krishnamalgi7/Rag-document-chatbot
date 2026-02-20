import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

// Vite proxy routes these to http://127.0.0.1:8000 — no CORS needed
const API_BASE = "";

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

export default function App() {
  // Chat state
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);

  // PDF upload state
  const [selectedFile, setSelectedFile]     = useState(null);
  const [uploading, setUploading]           = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState(null); // {type, text}
  const [isDragging, setIsDragging]         = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);
  const fileInputRef   = useRef(null);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ── Send chat message ────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/rag-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  // ── PDF upload ───────────────────────────────────────────────────────────
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
    if (!selectedFile || uploading) return;

    setUploading(true);
    setUploadFeedback(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch(`${API_BASE}/upload-pdf`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.detail || `Server error ${res.status}`);
      }

      setUploadFeedback({
        type: "success",
        text: data.message || "✅ PDF uploaded successfully!",
      });
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

  // Drag-and-drop handlers
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback(() => setIsDragging(false), []);
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileSelect(file);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🧠</div>
          <div><h1>MyChatbot</h1></div>
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
                <span className="file-size">
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </span>
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
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="drop-zone-placeholder">
              <span className="drop-icon">📂</span>
              <span className="drop-text">
                {isDragging ? "Drop PDF here" : "Click or drag PDF here"}
              </span>
              <span className="drop-hint">PDF files only</span>
            </div>
          )}
        </div>

        <button
          className="btn-upload"
          onClick={uploadPDF}
          disabled={!selectedFile || uploading}
        >
          {uploading ? (
            <span className="upload-spinner">Uploading…</span>
          ) : (
            "⬆ Upload PDF"
          )}
        </button>

        {uploadFeedback && (
          <div className={`upload-feedback ${uploadFeedback.type}`}>
            {uploadFeedback.text}
          </div>
        )}

        <p className="sidebar-hint">
          PDF text is extracted, chunked, and stored in the vector DB.
          Ask questions to trigger <strong>RAG mode</strong>.
        </p>
      </aside>

      {/* ── Chat Main ───────────────────────────────────────────── */}
      <main className="chat-main">

        <header className="chat-header">
          <div className="chat-header-dot" />
          <h2>RAG Assistant</h2>
        </header>

        <div className="chat-messages">
          {messages.length === 0 && !loading ? (
            <div className="chat-empty">
              <div className="chat-empty-icon">💬</div>
              <h3>Start a conversation</h3>
              <p>
                Upload a PDF on the left, then ask questions about its content.
                The assistant will use your documents when relevant, or fall
                back to general AI knowledge.
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
                  <div className="message-bubble">{msg.text}</div>
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
              placeholder="Ask a question about your PDF… (Shift+Enter for newline)"
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
            >
              ↑
            </button>
          </div>
          <p className="input-hint">
            Stateless · No history stored · PDFs persist in vector DB
          </p>
        </div>

      </main>
    </div>
  );
}