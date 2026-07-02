# Kito AI — Ephemeral RAG Chatbot

Kito AI is a full-stack chatbot that lets you upload a document — a PDF, a scan, or a photo of a page — and ask questions about it in plain language. It answers using the content of your document when it's relevant, and falls back to general knowledge when it isn't. Nothing you upload sticks around: as soon as you log out, your documents and their embeddings are deleted from the database.

You can also use it without an account. Logged-out visitors get a normal chat experience powered by a general-purpose LLM; they just can't upload files or get answers grounded in a specific document.

This README covers what the project actually does, how the two halves (frontend and backend) fit together, and how to get it running locally.

---

## What it does

- **Ask questions about your own documents.** Upload a PDF or an image, wait a few seconds while it's processed, and start asking questions. Answers are grounded in the text that was extracted from your file.
- **Chat without an account.** No login required to talk to the model — you just won't get document-aware answers.
- **Streams responses token by token**, so replies appear as they're generated instead of arriving all at once.
- **Reads scanned documents and photos, not just clean PDFs.** Text-based PDFs are parsed directly; scanned pages and images go through OCR.
- **Pulls tables out of PDFs**, not just paragraphs, so numeric or tabular data isn't lost during extraction.
- **Tells you where an answer came from.** Each AI response is tagged as either "from your document" or "general AI knowledge," along with a rough confidence level when it's document-based.
- **Deletes your data when you log out.** A confirmation screen shows a short summary of the session, then permanently removes your uploaded content from the database.
- **Uploads run in the background.** You get an immediate response when you hit upload, and the UI polls for progress instead of holding the connection open while a large file is processed.

---

## How it's built

### Frontend

The frontend is plain HTML, CSS, and JavaScript — no build step, no framework, no bundler. Open `chat.html` in a browser (or serve it with any static file server) and it works.

- `chat.html` — the entire application shell: sidebar, chat window, input area, and the logout summary modal.
- `js/chat.js` — the main controller. Wires up the DOM, manages login/logout state, sends and renders messages.
- `js/auth.js` — handles sign-up, login, and session state through Supabase Auth.
- `js/upload.js` — drag-and-drop file handling, the upload request itself, and polling for processing status.
- `js/modal.js` — the end-of-session summary dialog, including copy-to-clipboard and download-as-text.
- `js/api.js` — every fetch call to the backend lives here.
- `js/utils.js` — small shared helpers (auto-growing textarea, Markdown rendering).
- `js/config.js` — the two things you're likely to change per environment: your Supabase project URL/key and the backend API base URL.
- `css/style.css` — design tokens: colors, spacing, radii, fonts. Change a value here and it propagates everywhere.
- `css/chat.css` — every component's actual styling, built on top of those tokens.

Markdown rendering in the chat uses `marked.js`, loaded from a CDN. Authentication uses the Supabase JS SDK, also loaded from a CDN as an ES module.

There's also a leftover `frontend/src/` folder with a Vite + React scaffold from an earlier version of the project. It isn't wired into `chat.html` and isn't part of the running app — the plain HTML/CSS/JS frontend described above is what's actually deployed.

### Backend

The backend is a FastAPI application.

- `app/main.py` — the API routes, request/response models, and the Supabase JWT verification used to identify logged-in users.
- `app/rag.py` — embeddings, chunking, vector search, re-ranking, and the calls out to the LLM.
- `app/document_processor.py` — turns an uploaded PDF or image into clean text: text extraction, OCR, and table extraction.
- `app/job_store.py` — an in-memory store that tracks the progress of background upload jobs so the frontend can poll for status.
- `app/database.py` — the SQLAlchemy engine, pointed at a Postgres database with the `pgvector` extension enabled.
- `app/config.py` — loads required environment variables and fails fast with a clear error if any are missing.

**Retrieval pipeline, in short:** when a document is uploaded, its text is split into overlapping chunks (~500 tokens each, 50 tokens of overlap) and embedded with `sentence-transformers/all-MiniLM-L6-v2` (384-dimensional vectors). Those vectors are stored in Postgres via `pgvector`, tagged with the uploading user's ID.

When a logged-in user sends a message, their query is expanded, the top candidate chunks are retrieved by vector similarity, and a cross-encoder re-ranks them before the best few are handed to the LLM as context. If nothing in the user's documents is close enough to be useful, the request quietly falls back to a general-knowledge answer instead of forcing a bad document match.

**Model provider:** chat completions run on Groq (`llama-3.3-70b-versatile`), which is why responses stream back quickly.

### Database

Postgres, via Supabase, with the `pgvector` extension enabled for similarity search. One table (`documents`) stores each chunk's text, its embedding, and the ID of the user it belongs to.

### Authentication

Supabase Auth handles sign-up and login on the frontend. The backend doesn't talk to Supabase's auth system to issue tokens — it only verifies the token it's handed on each request by calling Supabase's `/auth/v1/user` endpoint, and uses the returned user ID to scope document storage, retrieval, and deletion to that one user.

---

## Project layout

```
Rag-document-chatbot/
├── backend/
│   ├── app/
│   │   ├── main.py               FastAPI routes and auth verification
│   │   ├── rag.py                Chunking, embeddings, retrieval, LLM calls
│   │   ├── document_processor.py PDF/image text and table extraction, OCR
│   │   ├── job_store.py          Background upload job tracking
│   │   ├── database.py           SQLAlchemy engine setup
│   │   └── config.py             Environment variable loading
│   ├── requirements.txt
│   └── .env                      Not committed — see setup below
├── frontend/
│   ├── index.html                Redirects to chat.html
│   ├── chat.html                 The actual application
│   ├── css/
│   │   ├── style.css             Design tokens
│   │   └── chat.css              Component styles
│   ├── js/
│   │   ├── chat.js
│   │   ├── auth.js
│   │   ├── upload.js
│   │   ├── modal.js
│   │   ├── api.js
│   │   ├── utils.js
│   │   └── config.js             Supabase + backend URL configuration
│   └── src/                      Unused Vite/React scaffold from an earlier iteration
├── render.yaml                   Deployment config for Render
└── README.md
```

---

## Running it locally

### Prerequisites

- Python 3.11+
- A Supabase project with the `pgvector` extension enabled
- A Groq API key
- Tesseract OCR installed and on your system PATH (needed to read scanned documents and images)
- Poppler installed and on your system PATH (needed to convert PDF pages to images for OCR)

### 1. Set up the database

In the Supabase SQL editor, run once:

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

### 2. Configure the backend

Create `backend/.env`:

```
DATABASE_URL=your_postgres_connection_string
GROQ_API_KEY=your_groq_api_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
```

All four are required — the app checks for them at startup and will refuse to boot if any are missing.

### 3. Install and run the backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The API will be available at `http://127.0.0.1:8000`.

### 4. Configure the frontend

Open `frontend/js/config.js` and set your own Supabase project URL, Supabase anon key, and backend API base URL. The anon key is a public, client-safe key — but it should still point at your own Supabase project rather than reusing whatever is checked into the repository.

### 5. Serve the frontend

No build step is needed. Any static file server works:

```bash
cd frontend
python -m http.server 8080
```

Then visit `http://localhost:8080`.

---

