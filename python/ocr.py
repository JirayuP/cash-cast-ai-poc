#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cash Cast AI - Tesseract OCR Engine (Python Worker)
สกัดข้อความภาษาไทยและอังกฤษ (tha+eng) จากภาพสลิปธนาคารและใบเสร็จรับเงิน
พร้อมขั้นตอน Image Preprocessing (Grayscale, Denoising, Thresholding) ตามบทที่ 2 หัวข้อ 2.1.3
"""

import os
import sys
import shutil
import cv2
import numpy as np
from PIL import Image
import pytesseract

# บังคับให้ stdout / stderr ใช้ UTF-8 เสมอ (ป้องกันปัญหาภาษาไทยเพี้ยนบน Windows เมื่อเรียกผ่าน Node.js child_process)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def configure_tesseract_binary() -> None:
    """ตรวจสอบและตั้งค่า Path ของโปรแกรม Tesseract OCR และโฟลเดอร์ tessdata (tha+eng)"""
    # ตั้งค่า TESSDATA_PREFIX ให้ชี้ไปยังโฟลเดอร์ tessdata ของโปรเจกต์ที่มีไฟล์ tha.traineddata
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    local_tessdata = os.path.join(project_root, "tessdata")
    if os.path.isdir(local_tessdata) and os.path.exists(
        os.path.join(local_tessdata, "tha.traineddata")
    ):
        os.environ["TESSDATA_PREFIX"] = local_tessdata

    env_cmd = os.environ.get("TESSERACT_CMD", "").strip()
    if env_cmd and os.path.exists(env_cmd):
        pytesseract.pytesseract.tesseract_cmd = env_cmd
        return

    # ถ้ามี tesseract อยู่ใน PATH ของระบบแล้ว
    if shutil.which("tesseract"):
        return

    # ค้นหาใน Path มาตรฐานของ Windows
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidate_paths = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.join(local_app_data, "Programs", "Tesseract-OCR", "tesseract.exe"),
        os.path.join(local_app_data, "Tesseract-OCR", "tesseract.exe"),
    ]
    for path in candidate_paths:
        if path and os.path.exists(path):
            pytesseract.pytesseract.tesseract_cmd = path
            return


def preprocess_image(image_path: str):
    """
    อ่านภาพและทำ Image Preprocessing ด้วย OpenCV:
    1. ขยายขนาดภาพหากภาพเล็กเกินไป
    2. แปลงภาพเป็น Grayscale
    3. ลดสัญญาณรบกวน (Denoising)
    4. ปรับความคมชัดและแปลงเป็นภาพขาว-ดำ (Otsu Thresholding)
    """
    # ใช้ np.fromfile เพื่อรองรับ Path ที่มีภาษาไทยหรืออักขระพิเศษบน Windows
    file_bytes = np.fromfile(image_path, dtype=np.uint8)
    img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

    if img is None:
        raise ValueError(f"ไม่สามารถเปิดไฟล์รูปภาพได้: {image_path}")

    height, width = img.shape[:2]
    # หากรูปมีความกว้างน้อยกว่า 1000px ให้ขยาย 2 เท่าเพื่อให้ Tesseract อ่านสระ/วรรณยุกต์ไทยได้แม่นยำขึ้น
    if width < 1000:
        img = cv2.resize(img, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)

    # 1. แปลงเป็น Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 2. ลดสัญญาณรบกวนโดยยังคงขอบตัวอักษรคมชัด
    denoised = cv2.bilateralFilter(gray, 9, 75, 75)

    # 3. ทำ Otsu's Thresholding สำหรับใบเสร็จทั่วไป
    _, thresh = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return gray, thresh


def extract_text(image_path: str, lang: str = "tha+eng") -> str:
    """รัน Tesseract OCR บนภาพที่ผ่านการทำ Preprocessing"""
    configure_tesseract_binary()

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"ไม่พบไฟล์รูปภาพ: {image_path}")

    gray_img, thresh_img = preprocess_image(image_path)

    # ตั้งค่า Tesseract: --oem 3 (LSTM Engine), --psm 6 (Assume a single uniform block of text)
    custom_config = r"--oem 3 --psm 6"

    # สกัดข้อความจากภาพ Grayscale และภาพ Threshold
    text_gray = pytesseract.image_to_string(
        Image.fromarray(gray_img), lang=lang, config=custom_config
    ).strip()

    text_thresh = pytesseract.image_to_string(
        Image.fromarray(thresh_img), lang=lang, config=custom_config
    ).strip()

    # สลิปธนาคารบางธนาคารมีพื้นหลังลวดลายซึ่ง Grayscale หรือ Threshold อาจอ่านได้ดีกว่ากัน
    # เลือกผลลัพธ์ที่ได้รายละเอียดตัวอักษรมากกว่า หรือรวมข้อมูลให้ Gemini วิเคราะห์ต่อ
    if len(text_thresh) > len(text_gray) * 1.15:
        return text_thresh
    elif len(text_gray) > 0 and len(text_thresh) > 0 and text_gray != text_thresh:
        return f"{text_gray}\n---\n{text_thresh}"
    return text_gray or text_thresh


def main():
    if len(sys.argv) < 2:
        print("Usage: python ocr.py <image_path> [lang]", file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) >= 3 else "tha+eng"

    try:
        extracted_text = extract_text(image_path, lang=lang)
        print(extracted_text)
        sys.exit(0)
    except Exception as exc:
        print(f"OCR_ERROR: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
