const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config/env');
const {
  extractTransactionFromOcr,
  extractTransactionFromImageFile,
} = require('./geminiService');

const execFileAsync = promisify(execFile);

/**
 * ดาวน์โหลดรูปภาพจาก LINE Messaging API ลงไฟล์ชั่วคราว (Temp File)
 * @param {import('@line/bot-sdk').messagingApi.MessagingApiBlobClient} blobClient
 * @param {string} messageId
 * @returns {Promise<string>} Path ของไฟล์ชั่วคราว
 */
async function downloadLineImageToTemp(blobClient, messageId) {
  await fs.promises.mkdir(config.ocr.tempDir, { recursive: true });
  const tempFileName = `line_img_${messageId}_${Date.now()}.jpg`;
  const tempFilePath = path.join(config.ocr.tempDir, tempFileName);

  const readableStream = await blobClient.getMessageContent(messageId);
  const writableStream = fs.createWriteStream(tempFilePath);
  await pipeline(readableStream, writableStream);

  return tempFilePath;
}

/**
 * ค้นหาคำสั่ง Python ที่ใช้งานได้จริงทั้งบน Linux (Docker / Railway) และ Windows
 */
function getPythonCandidates() {
  const candidates = [];
  if (fs.existsSync('/opt/venv/bin/python')) {
    candidates.push('/opt/venv/bin/python');
  }
  if (config.ocr.pythonPath) {
    candidates.push(config.ocr.pythonPath);
  }
  candidates.push('python3', 'python');
  return [...new Set(candidates)];
}

/**
 * เรียกใช้ Python Script (pytesseract) ผ่าน child_process เพื่อสกัดข้อความจากภาพ (tha+eng)
 * @param {string} imagePath - Path ของไฟล์รูปภาพ
 * @returns {Promise<string>} ข้อความดิบที่อ่านได้จาก Tesseract OCR
 */
async function runTesseractOcr(imagePath) {
  const envVars = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  };

  // ส่ง TESSERACT_CMD เฉพาะเมื่อไฟล์มีอยู่จริงใน OS นั้นๆ (ป้องกันค่า Windows Path ไปทับค่า Linux บน Railway)
  if (config.ocr.tesseractCmd && fs.existsSync(config.ocr.tesseractCmd)) {
    envVars.TESSERACT_CMD = config.ocr.tesseractCmd;
  } else {
    delete envVars.TESSERACT_CMD;
  }

  const pythonCandidates = getPythonCandidates();
  let lastError = null;

  for (const pyCmd of pythonCandidates) {
    try {
      const { stdout, stderr } = await execFileAsync(
        pyCmd,
        [config.ocr.scriptPath, imagePath, 'tha+eng'],
        {
          env: envVars,
          encoding: 'utf-8',
          timeout: 25000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      if (stderr && stderr.trim()) {
        console.warn('[OCR Warning]:', stderr.trim());
      }

      return (stdout || '').trim();
    } catch (error) {
      lastError = error;
      // หากเกิด ENOENT (ไม่พบคำสั่ง python ชื่อนั้น) ให้ลองคำสั่งถัดไป เช่น python3
      if (error.code === 'ENOENT') {
        continue;
      }
      break;
    }
  }

  const errDetail = lastError?.stderr || lastError?.message || 'Unknown OCR error';
  throw new Error(`การรัน Tesseract OCR ล้มเหลว: ${errDetail}`);
}

/**
 * Pipeline สำหรับรูปภาพจาก LINE:
 * 1. ดาวน์โหลดรูปภาพลง Temp File
 * 2. เรียก Python Tesseract OCR (tha+eng) -> ส่งข้อความดิบให้ Gemini API
 *    (หากสภาพแวดล้อม Cloud ไม่มี Python/Tesseract จะสลับไปใช้ Gemini Vision อ่านภาพโดยตรงอัตโนมัติ)
 * 3. ลบ Temp File ทันทีหลังอ่านเสร็จ (ใน finally block)
 *
 * @param {import('@line/bot-sdk').messagingApi.MessagingApiBlobClient} blobClient
 * @param {string} messageId
 * @returns {Promise<{ extractedData: object, rawOcrText: string }>}
 */
async function processLineImageAndExtract(blobClient, messageId) {
  let tempFilePath = null;
  try {
    tempFilePath = await downloadLineImageToTemp(blobClient, messageId);
    console.log(`[OCR] บันทึกไฟล์ชั่วคราวที่: ${tempFilePath}`);

    let rawOcrText = '';
    try {
      rawOcrText = await runTesseractOcr(tempFilePath);
      console.log(`[OCR] ข้อความที่สกัดได้ (${rawOcrText.length} ตัวอักษร):\n${rawOcrText}`);
    } catch (ocrErr) {
      console.warn(
        `[OCR Fallback] ไม่สามารถรัน Tesseract OCR ได้ (${ocrErr.message}) กำลังสลับไปใช้ Gemini Vision วิเคราะห์ภาพโดยตรง...`
      );
    }

    if (rawOcrText && rawOcrText.trim().length > 0) {
      const extractedData = await extractTransactionFromOcr(rawOcrText);
      return { extractedData, rawOcrText };
    }

    // Fallback: ใช้ Gemini Vision อ่านจากไฟล์ภาพชั่วคราวโดยตรงก่อนลบทิ้ง
    const extractedData = await extractTransactionFromImageFile(tempFilePath);
    return { extractedData, rawOcrText: '[Extracted via Gemini Vision Fallback]' };
  } finally {
    // ลบไฟล์ชั่วคราวทันทีหลังประมวลผลเสร็จตามเงื่อนไข PoC
    if (tempFilePath) {
      try {
        await fs.promises.unlink(tempFilePath);
        console.log(`[OCR] ลบไฟล์ชั่วคราวเรียบร้อย: ${tempFilePath}`);
      } catch (unlinkErr) {
        console.warn(`[OCR] ไม่สามารถลบไฟล์ชั่วคราว ${tempFilePath}:`, unlinkErr.message);
      }
    }
  }
}

module.exports = {
  downloadLineImageToTemp,
  runTesseractOcr,
  processLineImageAndExtract,
};
