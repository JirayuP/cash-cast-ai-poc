const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config/env');

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
 * เรียกใช้ Python Script (pytesseract) ผ่าน child_process เพื่อสกัดข้อความจากภาพ (tha+eng)
 * @param {string} imagePath - Path ของไฟล์รูปภาพ
 * @returns {Promise<string>} ข้อความดิบที่อ่านได้จาก Tesseract OCR
 */
async function runTesseractOcr(imagePath) {
  const envVars = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  };

  if (config.ocr.tesseractCmd) {
    envVars.TESSERACT_CMD = config.ocr.tesseractCmd;
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      config.ocr.pythonPath,
      [config.ocr.scriptPath, imagePath, 'tha+eng'],
      {
        env: envVars,
        encoding: 'utf-8',
        timeout: 30000, // Timeout 30 วินาที
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    if (stderr && stderr.trim()) {
      console.warn('[OCR Warning]:', stderr.trim());
    }

    return (stdout || '').trim();
  } catch (error) {
    const errDetail = error.stderr || error.message;
    throw new Error(`การรัน Tesseract OCR ล้มเหลว: ${errDetail}`);
  }
}

/**
 * Pipeline สำหรับรูปภาพจาก LINE:
 * 1. ดาวน์โหลดรูปภาพลง Temp File
 * 2. เรียก Python Tesseract OCR (tha+eng)
 * 3. ลบ Temp File ทันทีหลังอ่านเสร็จ (ใน finally block)
 *
 * @param {import('@line/bot-sdk').messagingApi.MessagingApiBlobClient} blobClient
 * @param {string} messageId
 * @returns {Promise<string>} ข้อความที่สกัดได้จากรูปภาพ
 */
async function processLineImageOcr(blobClient, messageId) {
  let tempFilePath = null;
  try {
    tempFilePath = await downloadLineImageToTemp(blobClient, messageId);
    console.log(`[OCR] บันทึกไฟล์ชั่วคราวที่: ${tempFilePath}`);

    const ocrText = await runTesseractOcr(tempFilePath);
    console.log(`[OCR] ข้อความที่สกัดได้ (${ocrText.length} ตัวอักษร):\n${ocrText}`);

    return ocrText;
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
  processLineImageOcr,
};
