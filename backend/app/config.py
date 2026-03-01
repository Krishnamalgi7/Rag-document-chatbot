import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend/ regardless of where uvicorn is launched from
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_env_path)

# Required config (all FREE!)
DATABASE_URL      = os.getenv("DATABASE_URL")
GROQ_API_KEY      = os.getenv("GROQ_API_KEY")       # FREE API!
SUPABASE_URL      = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

# OCR Configuration (FREE - runs locally)
TESSERACT_PATH = os.getenv("TESSERACT_PATH")  # Optional: custom Tesseract path on Windows

# NO VISION API KEYS NEEDED!
# This FREE version uses Tesseract OCR for all image processing
# 100% local, 0% API costs!

# Validation
if not DATABASE_URL:
    raise ValueError(f"❌ DATABASE_URL is not set. Looked in: {_env_path}")
if not GROQ_API_KEY:
    raise ValueError(f"❌ GROQ_API_KEY is not set. Looked in: {_env_path}")
if not SUPABASE_URL:
    raise ValueError(f"❌ SUPABASE_URL is not set. Looked in: {_env_path}")
if not SUPABASE_ANON_KEY:
    raise ValueError(f"❌ SUPABASE_ANON_KEY is not set. Looked in: {_env_path}")

print("✅ Configuration loaded successfully")
print("Kindly Wait to completely run backend")