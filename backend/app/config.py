import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the backend folder regardless of where uvicorn is launched from
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_env_path)

DATABASE_URL = os.getenv("DATABASE_URL")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Fail fast at startup if required env vars are missing
if not DATABASE_URL:
    raise ValueError(f"❌ DATABASE_URL is not set. Looked in: {_env_path}")

if not GROQ_API_KEY:
    raise ValueError(f"❌ GROQ_API_KEY is not set. Looked in: {_env_path}")