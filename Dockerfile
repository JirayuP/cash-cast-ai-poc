FROM node:22-bookworm-slim

# ติดตั้ง Python 3, Tesseract OCR (ภาษาไทย + อังกฤษ) และไลบรารีสำหรับ OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-tha \
    tesseract-ocr-eng \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# สร้าง Python Virtual Environment และติดตั้งไลบรารี OCR
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir pytesseract Pillow opencv-python-headless numpy

# ติดตั้ง Node.js Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# คัดลอกซอร์สโค้ดและไฟล์โมเดลภาษาไทย (tessdata_best)
COPY . .

# ตั้งค่า Environment Variables สำหรับรันบน Railway Cloud
ENV NODE_ENV=production
ENV PORT=5000
ENV PYTHON_PATH=/opt/venv/bin/python
ENV TESSERACT_CMD=/usr/bin/tesseract
ENV ENABLE_TUNNEL=false

EXPOSE 5000

CMD ["node", "src/index.js"]
