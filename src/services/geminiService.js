const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const config = require('../config/env');

// กำหนด JSON Schema บังคับโครงสร้างผลลัพธ์จาก Gemini API
const transactionResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    type: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['expense', 'income'],
      description: 'ประเภทรายการ: expense (รายจ่าย) หรือ income (รายรับ)',
    },
    title: {
      type: SchemaType.STRING,
      description: 'ชื่อรายการธุรกรรม หรือชื่อร้านค้า เช่น ข้าวมันไก่, 7-Eleven, เงินเดือน, โอนเงิน',
    },
    amount: {
      type: SchemaType.NUMBER,
      description: 'จำนวนเงินรวมสุทธิ (ตัวเลขเท่านั้น)',
    },
    category: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['อาหาร', 'เดินทาง', 'ช้อปปิ้ง', 'สาธารณูปโภค', 'เงินเดือน', 'อื่นๆ'],
      description: 'หมวดหมู่ของรายการธุรกรรม',
    },
    date: {
      type: SchemaType.STRING,
      description: 'วันที่ทำรายการในรูปแบบ YYYY-MM-DD (ถ้าไม่ระบุให้ใช้วันที่ปัจจุบัน)',
    },
    items: {
      type: SchemaType.ARRAY,
      description: 'รายการสินค้าย่อยจากใบเสร็จ (ถ้าไม่มีรายการย่อยให้ส่งอาเรย์ว่าง [])',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: {
            type: SchemaType.STRING,
            description: 'ชื่อสินค้าหรือรายการย่อย',
          },
          price: {
            type: SchemaType.NUMBER,
            description: 'ราคาของสินค้าหรือรายการย่อย',
          },
        },
        required: ['name', 'price'],
      },
    },
  },
  required: ['type', 'title', 'amount', 'category', 'date', 'items'],
};

/**
 * คืนค่าวันที่ปัจจุบันตามเวลาประเทศไทย (YYYY-MM-DD)
 */
function getTodayDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * เรียกใช้โมเดล Gemini พร้อมระบบ Auto-Fallback หากโมเดลหลักเกิด 503 / 404
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function generateStructuredJson(prompt) {
  if (!config.gemini.apiKey || config.gemini.apiKey === 'your_gemini_api_key_here') {
    throw new Error('ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env');
  }

  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const candidateModels = [
    ...new Set([config.gemini.model, ...(config.gemini.fallbackModels || [])]),
  ].filter(Boolean);

  let lastError = null;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: transactionResponseSchema,
        },
      });

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      return JSON.parse(responseText);
    } catch (err) {
      lastError = err;
      console.warn(
        `[Gemini Warning] โมเดล ${modelName} ไม่สามารถใช้งานได้ชั่วคราว (${
          err.status || err.message
        }) กำลังสลับไปใช้โมเดลสำรอง...`
      );
    }
  }

  throw lastError;
}

/**
 * วิเคราะห์ข้อความแชทจากผู้ใช้ (เช่น "ข้าวมันไก่ 50 บาท" หรือ "เงินเดือนเข้า 15,000")
 * @param {string} userText
 * @returns {Promise<object>} ข้อมูลธุรกรรมตาม JSON Schema
 */
async function extractTransactionFromText(userText) {
  const today = getTodayDateString();

  const prompt = `
คุณคือระบบ AI อัจฉริยะของ "Cash Cast AI" สำหรับวิเคราะห์และจัดหมวดหมู่รายรับ-รายจ่ายส่วนบุคคลจากข้อความภาษาไทย
วันที่ปัจจุบันคือ: ${today}

คำสั่ง:
1. วิเคราะห์ข้อความของผู้ใช้ต่อไปนี้ แล้วสกัดข้อมูลเป็น JSON ตาม Schema ที่กำหนด
2. แยกประเภท (type) ให้ถูกต้องว่าเป็น "expense" (รายจ่าย) หรือ "income" (รายรับ)
3. จัดหมวดหมู่ (category) ให้ตรงกับหนึ่งในตัวเลือก: "อาหาร", "เดินทาง", "ช้อปปิ้ง", "สาธารณูปโภค", "เงินเดือน", "อื่นๆ"
4. หากผู้ใช้ไม่ได้ระบุวันที่ ให้ใช้วันที่ปัจจุบัน (${today}) หากระบุเป็นปี พ.ศ. (เช่น 2569) ให้แปลงหรือระบุในรูปแบบ YYYY-MM-DD
5. หากเป็นข้อความเดี่ยวทั่วไป ให้ items เป็น [] แต่หากมีการแจกแจงหลายรายการย่อย ให้ใส่ใน items ด้วย

ข้อความจากผู้ใช้:
"""
${userText}
"""
`.trim();

  return await generateStructuredJson(prompt);
}

/**
 * วิเคราะห์ข้อความดิบที่ได้จาก Tesseract OCR (ภาพสลิปโอนเงินธนาคาร หรือ ใบเสร็จร้านค้า เช่น 7-Eleven)
 * @param {string} rawOcrText
 * @returns {Promise<object>} ข้อมูลธุรกรรมตาม JSON Schema
 */
async function extractTransactionFromOcr(rawOcrText) {
  const today = getTodayDateString();

  const prompt = `
คุณคือระบบ AI อัจฉริยะของ "Cash Cast AI" ทำหน้าที่วิเคราะห์ข้อความดิบที่ได้จาก Tesseract OCR (ภาษาไทย+อังกฤษ) จากรูปภาพ "สลิปโอนเงินธนาคาร" หรือ "ใบเสร็จรับเงิน (เช่น 7-Eleven, ร้านค้า, คาเฟ่)"
วันที่ปัจจุบันคือ: ${today}

คำสั่ง:
1. ข้อความจาก OCR อาจมีตัวอักษรเพี้ยนหรือมีสัญลักษณ์แปลกปลอม ให้คุณทำความเข้าใจบริบทและแก้ไขคำผิดให้ถูกต้อง
2. หากเป็น "ใบเสร็จร้านค้า (เช่น 7-Eleven)":
   - type: "expense"
   - title: ชื่อร้านค้า (เช่น "7-Eleven" หรือชื่อร้านที่ปรากฏ)
   - amount: ยอดรวมสุทธิ (Total / รวมเงิน)
   - category: เลือกตามประเภทสินค้าหลัก เช่น "อาหาร", "ช้อปปิ้ง", "อื่นๆ"
   - items: สกัดรายการสินค้าแต่ละชิ้นและราคาใส่ในอาเรย์ items (เช่น [{"name": "นมสด 1 ลิตร", "price": 38}, ...])
3. หากเป็น "สลิปธนาคาร / โอนเงิน":
   - type: "expense" (โอนเงินออก/จ่ายบิล/สแกนจ่าย) หรือ "income" (รับเงินโอนเข้า)
   - title: สรุปรายการโอนเงินหรือชื่อผู้รับ/ร้านค้า (เช่น "โอนเงินไปยัง ...", "ชำระค่าบริการ ...")
   - amount: จำนวนเงินที่โอนสำเร็จ
   - category: จัดหมวดหมู่ตามชื่อผู้รับหรือบันทึกช่วยจำ ("อาหาร", "เดินทาง", "ช้อปปิ้ง", "สาธารณูปโภค", "เงินเดือน", "อื่นๆ")
   - items: []
4. date: สกัดวันที่จากสลิปหรือใบเสร็จในรูปแบบ YYYY-MM-DD (หากไม่พบหรืออ่านไม่ออก ให้ใช้วันที่ปัจจุบัน ${today})

ข้อความดิบจาก Tesseract OCR:
"""
${rawOcrText}
"""
`.trim();

  return await generateStructuredJson(prompt);
}

module.exports = {
  extractTransactionFromText,
  extractTransactionFromOcr,
  getTodayDateString,
};
