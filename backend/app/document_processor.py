"""
Multi-modal Document Processor - FREE VERSION (No Vision API)
Handles PDFs, Images, Scanned Documents, Tables - 100% FREE with OCR
"""

import io
import logging
from pathlib import Path
from typing import List, Dict, Any, Tuple
from dataclasses import dataclass

# PDF Processing
import pdfplumber
import fitz  # PyMuPDF
from pdf2image import convert_from_bytes

# Image Processing
from PIL import Image
import cv2
import numpy as np
import pytesseract

# Table Extraction
import pandas as pd
import camelot

from app.config import TESSERACT_PATH

if TESSERACT_PATH:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH

logger = logging.getLogger(__name__)


@dataclass
class ProcessedContent:
    """Container for processed document content"""
    text: str
    tables: List[pd.DataFrame]
    images: List[Dict[str, Any]]
    metadata: Dict[str, Any]


class DocumentProcessor:
    """
    FREE Multi-format document processor with OCR and table extraction.
    NO VISION API REQUIRED - Uses OCR for all image content.
    Perfect for students and free projects!
    """

    SUPPORTED_FORMATS = {
        'pdf': ['.pdf'],
        'image': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'],
    }

    def __init__(self):
        """Initialize processor - NO API KEYS NEEDED!"""
        logger.info("✅ DocumentProcessor initialized (FREE VERSION - OCR only)")
        logger.info("💰 No API costs - Everything runs locally!")

    def process_file(self, file_bytes: bytes, filename: str) -> ProcessedContent:
        """
        Main entry point - routes to appropriate processor based on file type
        """
        ext = Path(filename).suffix.lower()

        if ext in self.SUPPORTED_FORMATS['pdf']:
            return self.process_pdf(file_bytes, filename)
        elif ext in self.SUPPORTED_FORMATS['image']:
            return self.process_image(file_bytes, filename)
        else:
            raise ValueError(f"Unsupported file format: {ext}")

    def process_pdf(self, pdf_bytes: bytes, filename: str) -> ProcessedContent:
        """
        Process PDF with intelligent content detection (100% FREE):
        1. Try text extraction
        2. Detect and extract tables
        3. Apply OCR to images/scanned pages
        """
        logger.info(f"Processing PDF: {filename}")

        text_content = []
        tables = []
        images = []
        metadata = {"filename": filename, "type": "pdf"}

        # Step 1: Text extraction with pdfplumber
        try:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                total_pages = len(pdf.pages)
                metadata["total_pages"] = total_pages

                for page_num, page in enumerate(pdf.pages, 1):
                    # Extract text
                    page_text = page.extract_text()

                    # Check if page is mostly empty (likely scanned)
                    if not page_text or len(page_text.strip()) < 50:
                        logger.info(f"Page {page_num} appears scanned - applying FREE OCR")
                        # Convert page to image and OCR
                        images_from_pdf = convert_from_bytes(
                            pdf_bytes,
                            first_page=page_num,
                            last_page=page_num,
                            dpi=300,
                            poppler_path=r"C:\Users\ASUS\poppler\Library\bin"
                        )
                        if images_from_pdf:
                            ocr_text = self._ocr_image(images_from_pdf[0])
                            text_content.append(f"[Page {page_num} - OCR]\n{ocr_text}")
                    else:
                        text_content.append(f"[Page {page_num}]\n{page_text}")

                    # Extract tables from this page (FREE!)
                    page_tables = page.extract_tables()
                    if page_tables:
                        for table_idx, table in enumerate(page_tables):
                            try:
                                df = pd.DataFrame(table[1:], columns=table[0])
                                tables.append(df)
                                # Add table summary to text
                                table_text = f"\n[Table {len(tables)} from Page {page_num}]\n{df.to_string()}\n"
                                text_content.append(table_text)
                                logger.info(f"✅ Extracted table {len(tables)} (FREE)")
                            except Exception as e:
                                logger.warning(f"Failed to process table on page {page_num}: {e}")

        except Exception as e:
            logger.error(f"pdfplumber failed: {e}")
            # Fallback to full OCR
            return self._process_pdf_with_ocr(pdf_bytes, filename)

        # Step 2: Extract embedded images and apply OCR
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            for page_num in range(len(doc)):
                page = doc[page_num]
                image_list = page.get_images()

                for img_index, img in enumerate(image_list):
                    try:
                        xref = img[0]
                        base_image = doc.extract_image(xref)
                        image_bytes = base_image["image"]

                        # Apply FREE OCR to image
                        img_pil = Image.open(io.BytesIO(image_bytes))
                        ocr_text = self._ocr_image(img_pil)

                        if ocr_text.strip():
                            images.append({
                                "page": page_num + 1,
                                "type": "embedded_image",
                                "text": ocr_text
                            })
                            text_content.append(f"\n[Image {len(images)} OCR from Page {page_num + 1}]\n{ocr_text}\n")
                            logger.info(f"✅ OCR extracted from image {len(images)} (FREE)")
                    except Exception as e:
                        logger.warning(f"Failed to OCR image on page {page_num + 1}: {e}")

            doc.close()
        except Exception as e:
            logger.warning(f"Image extraction failed: {e}")

        # Step 3: Advanced table extraction with Camelot (FREE!)
        if len(tables) == 0:
            try:
                import tempfile
                with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                    tmp.write(pdf_bytes)
                    tmp_path = tmp.name

                camelot_tables = camelot.read_pdf(tmp_path, pages='all', flavor='lattice')
                for table in camelot_tables:
                    df = table.df
                    tables.append(df)
                    table_text = f"\n[Table {len(tables)} - Camelot]\n{df.to_string()}\n"
                    text_content.append(table_text)
                    logger.info(f"✅ Camelot extracted table {len(tables)} (FREE)")

                Path(tmp_path).unlink()
            except Exception as e:
                logger.warning(f"Camelot table extraction failed: {e}")

        full_text = "\n\n".join(text_content)
        metadata["text_length"] = len(full_text)
        metadata["tables_found"] = len(tables)
        metadata["images_found"] = len(images)
        metadata["processing_cost"] = "FREE - No API costs!"

        return ProcessedContent(
            text=full_text,
            tables=tables,
            images=images,
            metadata=metadata
        )

    def _process_pdf_with_ocr(self, pdf_bytes: bytes, filename: str) -> ProcessedContent:
        """
        Fallback: Full OCR processing for scanned PDFs (100% FREE with Tesseract)
        """
        logger.info("Applying full FREE OCR to PDF")

        text_content = []
        images = convert_from_bytes(pdf_bytes, dpi=300, poppler_path=r"C:\Users\ASUS\poppler\Library\bin")

        for page_num, img in enumerate(images, 1):
            ocr_text = self._ocr_image(img)
            text_content.append(f"[Page {page_num} - Full OCR]\n{ocr_text}")
            logger.info(f"✅ Page {page_num} OCR complete (FREE)")

        full_text = "\n\n".join(text_content)

        return ProcessedContent(
            text=full_text,
            tables=[],
            images=[],
            metadata={
                "filename": filename,
                "type": "pdf_scanned",
                "total_pages": len(images),
                "processing": "full_ocr",
                "processing_cost": "FREE - Tesseract OCR"
            }
        )

    def process_image(self, image_bytes: bytes, filename: str) -> ProcessedContent:
        """
        Process standalone image files (100% FREE with OCR)
        """
        logger.info(f"Processing image: {filename}")

        img = Image.open(io.BytesIO(image_bytes))

        # Apply FREE OCR for any text in the image
        ocr_text = self._ocr_image(img)

        if ocr_text.strip():
            text_content = f"[OCR Text from Image]\n{ocr_text}"
            logger.info(f"✅ Image OCR complete (FREE)")
        else:
            text_content = "[No text detected in image]"
            logger.info("⚠️ No text found in image")

        return ProcessedContent(
            text=text_content,
            tables=[],
            images=[{"type": "standalone", "ocr_text": ocr_text}],
            metadata={
                "filename": filename,
                "type": "image",
                "size": img.size,
                "processing_cost": "FREE - Tesseract OCR"
            }
        )

    def _ocr_image(self, img: Image.Image) -> str:
        """
        Apply FREE OCR to extract text from image using Tesseract
        Includes image preprocessing for better accuracy
        """
        try:
            # Convert to grayscale
            img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)

            # Apply preprocessing for better OCR
            # 1. Denoising
            img_cv = cv2.fastNlMeansDenoising(img_cv)

            # 2. Thresholding
            _, img_cv = cv2.threshold(img_cv, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

            # OCR with Tesseract (100% FREE!)
            text = pytesseract.image_to_string(Image.fromarray(img_cv), lang='eng')

            return text.strip()
        except Exception as e:
            logger.error(f"OCR failed: {e}")
            return ""

    @staticmethod
    def is_supported_format(filename: str) -> Tuple[bool, str]:
        """Check if file format is supported and return category"""
        ext = Path(filename).suffix.lower()

        for category, extensions in DocumentProcessor.SUPPORTED_FORMATS.items():
            if ext in extensions:
                return True, category

        return False, ""