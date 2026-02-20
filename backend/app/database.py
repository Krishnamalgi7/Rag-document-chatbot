from sqlalchemy import create_engine
from app.config import DATABASE_URL

# Single shared engine — used directly via engine.connect() in rag.py
engine = create_engine(DATABASE_URL)