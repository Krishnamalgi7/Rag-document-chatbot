# 🧠 MyChatbot — Multi-Modal RAG Chatbot with Supabase Auth

A full-stack, multi-modal AI chatbot that lets authenticated users upload PDFs and Images (PNG, JPG, etc.) and ask questions about them using Retrieval-Augmented Generation (RAG). Unauthenticated users can still chat using general AI knowledge (fallback mode).

---

## ✨ Features

| Feature | Details |
|---|---|
| **Multi-Modal Uploads** | Upload PDFs (including scanned PDFs) and Images for analysis |
| **Locally Hosted OCR** | 100% FREE text extraction from images/scans using Tesseract — no API costs! |
| **Table Extraction** | Automatically detects and reads tables from documents using Camelot/pdfplumber |
| **Public mode** | Anyone can chat — answered by Groq LLM directly |
| **Auth mode** | Login with Supabase email/password |
| **Per-user isolation** | Each user's documents are stored separately |
| **Auto-delete on logout** | All your documents are permanently deleted when you log out |
| **Smart fallback** | If no relevant docs found, falls back to general AI |

---

## 🏗️ Tech Stack

**Frontend**
- React + Vite
- `@supabase/supabase-js` — auth client
- Vanilla CSS (dark theme)

**Backend**
- FastAPI (Python)
- `sentence-transformers` — `all-MiniLM-L6-v2` (384-dim embeddings)
- `pgvector` — vector similarity search (cosine distance)
- `Groq` — LLM inference (`llama-3.1-8b-instant`)
- `pdfplumber` & `PyMuPDF (fitz)` — PDF text extraction
- `pytesseract` & `opencv` — FREE OCR for scanned PDFs and Images
- `camelot-py` — Advanced Table Extraction
- `httpx` — Supabase JWT verification
- `SQLAlchemy` — database access

**Database**
- Supabase PostgreSQL + `pgvector` extension

---

## 📁 Project Structure

```
Mychatbot/
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
| `GET` | `/` | None | Health check |
| `POST` | `/rag-chat` | Optional | Chat (public → fallback, authed → RAG) |
| `POST` | `/upload-document`| Required | Multi-format upload (PDFs, Images) + OCR |
| `DELETE` | `/clear-user-documents` | Required | Delete all user's documents (called on logout) |

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
| 1 | Not logged in → ask question | `🤖 AI Response` (fallback) |
| 2 | Login → no document uploaded → ask question | `🤖 AI Response` (fallback) |
| 3 | Login → upload Image with text → ask question | `📄 From Documents` (OCR RAG) |
| 4 | Login → ask unrelated question | `🤖 AI Response` (fallback) |
| 5 | Logout → check Supabase `documents` table | Rows for that `user_id` deleted |

---

## 🔒 Security Notes

- Documents are **isolated per `user_id`** — users can only search their own documents
- Documents are **permanently deleted on logout** — no data persists
- Supabase JWTs expire automatically — backend rejects expired tokens with HTTP 401
- `SUPABASE_ANON_KEY` is safe to expose in the frontend (it's the public publishable key)