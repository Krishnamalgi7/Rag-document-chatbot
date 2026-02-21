# 🧠 MyChatbot — RAG Chatbot with Supabase Auth

A full-stack AI chatbot that lets authenticated users upload PDFs and ask questions about them using Retrieval-Augmented Generation (RAG). Unauthenticated users can still chat using general AI knowledge (fallback mode).

---

## ✨ Features

| Feature | Details |
|---|---|
| **Public mode** | Anyone can chat — answered by Groq LLM directly |
| **Auth mode** | Login with Supabase email/password |
| **PDF upload** | Upload PDFs to your private vector knowledge base |
| **RAG search** | Questions answered from your own documents |
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
- `pdfplumber` — PDF text extraction
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
│   │   ├── config.py       # Env vars (DATABASE_URL, GROQ_API_KEY, SUPABASE_*)
│   │   ├── database.py     # SQLAlchemy engine
│   │   ├── main.py         # FastAPI routes + JWT auth helper
│   │   └── rag.py          # Embeddings, chunking, vector search, Groq calls
│   ├── .env                # Secret keys (not committed)
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.jsx         # Main React component
    │   └── App.css         # Styles
    ├── .env                # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
    └── package.json
```

---

## ⚙️ Setup

### Prerequisites
- Python 3.11+
- Node.js 18+
- Supabase project with `pgvector` enabled
- Groq API key

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
DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
GROQ_API_KEY=<your-groq-key>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

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
| `POST` | `/upload-pdf` | Required | Upload PDF to user's knowledge base |
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
| 2 | Login → no PDF uploaded → ask question | `🤖 AI Response` (fallback) |
| 3 | Login → upload PDF → ask relevant question | `📄 From Documents` (RAG) |
| 4 | Login → ask unrelated question | `🤖 AI Response` (fallback) |
| 5 | Logout → check Supabase `documents` table | Rows for that `user_id` deleted |

---

## 🔒 Security Notes

- Documents are **isolated per `user_id`** — users can only search their own documents
- Documents are **permanently deleted on logout** — no data persists
- Supabase JWTs expire automatically — backend rejects expired tokens with HTTP 401
- `SUPABASE_ANON_KEY` is safe to expose in the frontend (it's the public publishable key)

---

## 🚀 Deployment

**Backend** — [Render](https://render.com)
1. Set all `.env` values as Render environment variables
2. Build command: `pip install -r requirements.txt`
3. Start command: `uvicorn app.main:app --host 0.0.0.0 --port 10000`

**Frontend** — [Vercel](https://vercel.com)
1. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel environment variables
2. Update `API_BASE` in `App.jsx` to your Render backend URL
3. Deploy — Vercel auto-detects Vite