/**
 * สคริปต์สำหรับทดสอบ Pipeline (Text -> Gemini JSON Schema และ Image -> Python Tesseract OCR -> Gemini)
 * รันด้วยคำสั่ง:
 *   npm run test:pipeline
 *   node test-pipeline.js path/to/slip_or_receipt.jpg
 */

const fs = require('fs');
const {
  extractTransactionFromText,
  extractTransactionFromOcr,
} = require('./src/services/geminiService');
const { runTesseractOcr } = require('./src/services/ocrService');

async function main() {
  const imageArg = process.argv[2];

  console.log('====================================================');
  console.log('🧪 เริ่มการทดสอบ Cash Cast AI Pipeline (Fast PoC)');
  console.log('====================================================\n');

  if (imageArg) {
    if (!fs.existsSync(imageArg)) {
      console.error(`❌ ไม่พบไฟล์รูปภาพ: ${imageArg}`);
      process.exit(1);
    }
    console.log(`📸 ทดสอบสกัดข้อมูลจากรูปภาพ: ${imageArg}`);
    const rawOcr = await runTesseractOcr(imageArg);
    console.log('\n--- [1] ข้อความดิบจาก Python Tesseract OCR (tha+eng) ---');
    console.log(rawOcr || '(ไม่พบข้อความ)');

    console.log('\n--- [2] ผลลัพธ์ JSON จาก Gemini API ---');
    const jsonResult = await extractTransactionFromOcr(rawOcr);
    console.log(JSON.stringify(jsonResult, null, 2));
    return;
  }

  const sampleTexts = [
    'ข้าวมันไก่ 50 บาท',
    'เงินเดือนเข้า 15,000',
    'ซื้อของ 7-Eleven นมสด 38 บาท ขนมปัง 25 บาท น้ำดื่ม 7 บาท รวม 70 บาท',
  ];

  for (const sample of sampleTexts) {
    console.log(`💬 ทดสอบข้อความ: "${sample}"`);
    try {
      const result = await extractTransactionFromText(sample);
      console.log('✅ JSON Output:');
      console.log(JSON.stringify(result, null, 2));
      console.log('----------------------------------------------------');
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      console.log('----------------------------------------------------');
    }
  }
}

main();
