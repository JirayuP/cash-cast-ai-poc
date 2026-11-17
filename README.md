# Cash Cast AI — Proof of Concept (MVP)

ระบบต้นแบบ (Fast PoC) สำหรับพิสูจน์แนวคิด (Validate Pipeline) การรับข้อมูลจาก **LINE Official Account** ทั้งประเภท **ข้อความ (Text)** และ **รูปภาพสลิป/ใบเสร็จ (Image)** นำมาสกัดข้อมูลด้วย **Python Tesseract OCR (`tha+eng`)** และวิเคราะห์/จัดหมวดหมู่อัตโนมัติด้วย **Google Gemini API (Structured JSON Schema)** แล้วตอบกลับไปยังแชท LINE ทันทีด้วย **Flex Message + JSON Output**

---

## 1. สถาปัตยกรรมและ Tech Stack (PoC)
* **Backend Gateway:** Node.js + Express.js + `@line/bot-sdk`
* **OCR Engine:** Python (`pytesseract` + `opencv-python` + `Pillow`) รองรับภาษาไทยและอังกฤษ (`tha+eng`) เรียกผ่าน `child_process` จาก Node.js
* **AI Extraction & Categorization:** Google Gemini API (`@google/generative-ai`) บังคับตอบกลับตาม `responseSchema` (JSON Schema)
* **Storage (Fast PoC):**
  * บันทึกรายการธุรกรรมแบบ **In-Memory** (`src/store/memoryStore.js`)
  * รูปภาพที่ดาวน์โหลดจาก LINE จะถูกเก็บในโฟลเดอร์ `temp/` ชั่วคราว และ **ลบทิ้งทันที (`fs.unlink`)** ใน `finally` block หลังอ่าน OCR เสร็จ

---

## 2. โครงสร้างโปรเจกต์
```text
cash-cast-ai-poc/
├── .env.example                 # ตัวอย่างไฟล์ตั้งค่าตัวแปรสภาพแวดล้อม
├── package.json                 # Dependencies ฝั่ง Node.js
├── requirements.txt             # Dependencies ฝั่ง Python OCR
├── python/
│   └── ocr.py                   # สคริปต์ Python สำหรับทำ Image Preprocessing + Tesseract OCR (tha+eng)
├── src/
│   ├── index.js                 # Express Server, POST /webhook และ REST API ทดสอบ
│   ├── config/
│   │   └── env.js               # โหลดค่าตั้งค่าจาก .env
│   ├── services/
│   │   ├── geminiService.js     # ส่งข้อความ/OCR ให้ Gemini API และบังคับ JSON Schema
│   │   ├── ocrService.js        # ดาวน์โหลดรูปจาก LINE -> เรียก ocr.py -> ลบไฟล์ Temp ทันที
│   │   └── flexMessageService.js# สร้าง Flex Message (ตามรูปที่ 1.5 ในเล่มโครงงาน) + JSON Preview
│   └── store/
│       └── memoryStore.js       # In-Memory Store สำหรับเก็บรายการระหว่างรันทดสอบ
├── temp/                        # โฟลเดอร์พักไฟล์รูปภาพชั่วคราว (ถูกลบอัตโนมัติหลังอ่านเสร็จ)
└── test-pipeline.js             # สคริปต์ทดสอบ Pipeline แบบ CLI โดยไม่ต้องเปิด ngrok
```

---

## 3. การติดตั้งและเตรียมสภาพแวดล้อม

### 3.1 ติดตั้งโปรแกรม Tesseract OCR บน Windows
1. ติดตั้งผ่าน Winget:
   ```powershell
   winget install UB-Mannheim.TesseractOCR
   ```
   หรือดาวน์โหลดตัวติดตั้งจาก [Tesseract at UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki)
2. **สำคัญ:** ระหว่างติดตั้ง ในหัวข้อ *Additional script/language data* ให้ติ๊กเลือก **Thai (`tha`)** ด้วย (หรือดาวน์โหลดไฟล์ [`tha.traineddata`](https://github.com/tesseract-ocr/tessdata/raw/main/tha.traineddata) ไปวางไว้ใน `C:\Program Files\Tesseract-OCR\tessdata\`)

### 3.2 ติดตั้งไลบรารี Node.js และ Python
```powershell
cd C:\Users\jiray\.gemini\antigravity\scratch\cash-cast-ai-poc

# 1. ติดตั้งแพ็กเกจ Node.js
npm install

# 2. ติดตั้งแพ็กเกจ Python
pip install -r requirements.txt
```

### 3.3 ตั้งค่าไฟล์ `.env`
คัดลอกไฟล์ `.env.example` เป็น `.env` แล้วใส่ค่า API Keys ของคุณ:
```powershell
Copy-Item .env.example .env
```
แก้ไขค่าใน `.env`:
```env
LINE_CHANNEL_ACCESS_TOKEN=ใส่_Channel_Access_Token_จาก_LINE_Developers
LINE_CHANNEL_SECRET=ใส่_Channel_Secret_จาก_LINE_Developers
GEMINI_API_KEY=ใส่_API_Key_จาก_Google_AI_Studio
GEMINI_MODEL=gemini-2.5-flash
PYTHON_PATH=python
TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
PORT=5000
```

---

## 4. วิธีรันและทดสอบระบบ

### วิธีที่ 1: เชื่อมต่อกับ LINE Official Account จริง
1. รันเซิร์ฟเวอร์ Backend:
   ```powershell
   npm run dev
   ```
2. เปิด Tunnel ด้วย `ngrok` (หรือ Cloudflare Tunnel) ไปที่พอร์ต `5000`:
   ```powershell
   ngrok http 5000
   ```
3. นำ HTTPS URL ที่ได้ (เช่น `https://xxxx.ngrok-free.app/webhook`) ไปใส่ใน **LINE Developers Console -> Messaging API -> Webhook URL** แล้วกด **Verify** และเปิด **Use webhook**
4. ทดลองส่งข้อความในแชท LINE OA:
   * พิมพ์: `ข้าวมันไก่ 50 บาท` หรือ `เงินเดือนเข้า 15,000`
   * ส่งรูปภาพ: **สลิปโอนเงินธนาคาร** หรือ **ใบเสร็จ 7-Eleven**
   * พิมพ์: `สรุป` เพื่อดูยอดรวมรายรับ-รายจ่ายที่บันทึกไว้ใน In-Memory Store

### วิธีที่ 2: ทดสอบ Pipeline ผ่าน CLI หรือ REST API ในเครื่องทันที
* รันสคริปต์ทดสอบข้อความ:
  ```powershell
  npm run test:pipeline
  ```
* รันสคริปต์ทดสอบรูปภาพสลิป/ใบเสร็จ:
  ```powershell
  node test-pipeline.js C:\path\to\receipt.jpg
  ```
* ดูรายการธุรกรรมทั้งหมดใน In-Memory Store ผ่าน Browser:
  เปิด `http://localhost:5000/api/transactions`
