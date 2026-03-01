# 🤖 Arch AI Chatbot — Enterprise-Grade Multi-Modal RAG Platform

A state-of-the-art, full-stack AI platform that empowers authenticated users to analyze non-structured data (PDFs, Scans, Images) using advanced Retrieval-Augmented Generation (RAG). Built securely with Supabase Auth, it features seamless multi-modal ingestion, automated data-table extraction, and dynamic session handovers.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Multi-Modal Engine** | Ingest text-based PDFs, scanned documents, and images (PNG, JPG, WEBP, etc.) |
| **Real-Time Streaming** | Token-by-token generative output for ultra-low latency conversational UX over `/rag-chat/stream` |
| **Context-Aware Memory** | Dynamic injection of chat history ensuring continuous, non-atomic dialogue context |
| **Semantic Intelligence** | Query expansion, hybrid search, and algorithmic re-ranking for optimal vector yields |
| **Confidence Scoring** | Real-time mathematical distance metrics translating to visual UI confidence badges |
| **Local OCR Pipeline** | Integrated Tesseract engine for highly accurate, offline text extraction from image sources |
| **Advanced Table Extraction** | Programmatic extraction of tabular data formats via Camelot and pdfplumber |
| **Public Sandbox** | Direct interactions with the flagship Groq LLM cluster for unauthenticated knowledge queries |
| **Secure Authentication** | Fortified sign-in flows via Supabase matching modern security standards |
| **Ephemeral Sessions** | Zero-retention policy; all personalized vector data is cryptographically destroyed on logout |
| **Session Handover** | Intelligent, markdown-formatted, and smartly-truncated executive summaries upon termination |
| **Dynamic Fallback Logic** | Seamless transitions between Context-RAG algorithms and General Intelligence |

---

## 🏗️ Tech Stack

**Frontend**
- React + Vite
- `@supabase/supabase-js` — auth client
- Vanilla CSS (dark theme)

**Backend**
- FastAPI (Python) — High-performance async architecture
- `sentence-transformers` — `all-MiniLM-L6-v2` semantic dimensionality engine
- `pgvector` — High-speed vector similarity calculations via PostgreSQL
- `Groq` — Lightning-fast LLM inference (`llama-3.3-70b-versatile`)
- `PyMuPDF` & `pdfplumber` — Advanced text and metadata extraction routines
- `pytesseract` & `opencv` — Optimized Optical Character Recognition
- `camelot-py` — Precision table extraction matrix
- `httpx` — Secure JWT validation middleware
- `SQLAlchemy` — Robust standard ORM layer

**Database**
- Supabase PostgreSQL + `pgvector` extension

---

## 📁 Project Structure

```
ArchAI/
├── backend/
│   ├── app/
│   │   ├── config.py             # Env vars (DATABASE_URL, GROQ_API_KEY, SUPABASE_*)
│   │   ├── database.py           # SQLAlchemy engine
│   │   ├── document_processor.py # Multi-Modal (PDF, Image, OCR, Tables) Handler
│   │   ├── main.py               # FastAPI routes + JWT auth helper
│   │   └── rag.py                # Embeddings, chunking, vector search, Groq calls
│   ├── .env                      # Secret keys (not committed)
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.jsx               # Main React component
    │   └── App.css               # Styles
    ├── .env                      # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
    └── package.json
```

---

## ⚙️ Setup

### Prerequisites
- Python 3.11+
- Node.js 18+
- Supabase project with `pgvector` enabled
- Groq API key
- **Poppler** (Required for PDF-to-Image conversion)
  - *Windows:* Download from [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases/), extract to `C:\poppler`, and add `C:\poppler\Library\bin` to your system PATH.
- **Tesseract OCR** (Required for Image/Scan reading)
  - *Windows:* Install from [UB-Mannheim](https://github.com/UB-Mannheim/tesseract/wiki), ensure it's in your PATH or configured in `config.py`.

### 1. Database Migration
Run once in **Supabase → SQL Editor**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id        BIGSERIAL PRIMARY KEY,
  content   TEXT,
  embedding VECTOR(384),
  user_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
```

### 2. Backend Setup
```powershell
cd backend
python -m venv ../venv
..\venv\Scripts\pip install -r requirements.txt
```

Create `backend/.env`:
```
DATABASE_URL=postgresql://postgres.yourprojectid:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
GROQ_API_KEY=<your-groq-key>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```
*(Note: Use your Supabase **Connection Pooler URL (IPv4)** to ensure network compatibility).*

Start backend:
```powershell
cd backend
..\venv\Scripts\uvicorn.exe app.main:app --reload
```

### 3. Frontend Setup
```powershell
cd frontend
npm install
```

Create `frontend/.env`:
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Start frontend:
```powershell
cd frontend
npm run dev
```

Open **http://localhost:5173**

---

## 🔌 API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | System health check and capability readout |
| `POST` | `/rag-chat/stream` | Optional | Dual-mode algorithmic routing with Streaming SSE (Public → LLM, Authed → Vector RAG) |
| `POST` | `/api/session/summary` | Required | Generates a comprehensive executive summary of the chat history |
| `POST` | `/upload-document`| Required | Multi-format upload handler with automated OCR analysis pipeline |
| `DELETE` | `/clear-user-documents` | Required | Triggers vector-space teardown and data destruction (called securely on logout) |

### JWT Verification
The backend verifies Supabase tokens by calling:
```
GET https://<project>.supabase.co/auth/v1/user
Authorization: Bearer <access_token>
apikey: <anon_key>
```
No custom JWT library required — Supabase validates the token and returns the `user.id`.

---

## 🧪 Test Cases

| # | Scenario | Expected |
|---|---|---|
| 1 | Unauthenticated Sandbox | Query without context | General LLM Knowledge Retrieval |
| 2 | Authenticated Sandbox | Login → query without context | General LLM Knowledge Retrieval |
| 3 | Multi-Modal Pipeline | Upload visual data (Image/Scan) | Semantic verification via OCR-RAG |
| 4 | Fallback Trigger | Query un-related context | Automated fallback to LLM base intelligence |
| 5 | Session Handover & Teardown | Click Logout | Modal displays summary → Data purged from `documents` |

---

## 🔒 Security & Privacy Architecture

- **Cryptographic Isolation**: System utilizes the `user_id` primitive as a hard partition in vector-space, preventing contextual crossover.
- **Ephemeral Storage**: Upload instances are strictly session-bound. The system forcefully triggers total algorithmic deletion of user tensors on logout.
- **Token Validation**: The proxy server validates Supabase JWTs per-request. Expired tokens receive instantaneous 401 rejections.
- **Role-Based Variables**: `SUPABASE_ANON_KEY` operates as a public publishable key, eliminating credential exposure risks on the client layer.