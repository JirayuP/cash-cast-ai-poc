const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const config = require('./config/env');
const {
  extractTransactionFromText,
  extractTransactionFromOcr,
} = require('./services/geminiService');
const { processLineImageAndExtract, runTesseractOcr } = require('./services/ocrService');
const { buildTransactionReplyMessages } = require('./services/flexMessageService');
const memoryStore = require('./store/memoryStore');

const app = express();
app.use(cors());

// เก็บ ID ของ Event/Message ที่ประมวลผลไปแล้ว เพื่อป้องกันการประมวลผลซ้ำเมื่อ LINE ส่ง Redelivery
const processedEventIds = new Set();

// ตั้งค่า LINE SDK Clients
const lineConfig = {
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
};

const messagingClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.line.channelAccessToken,
});

/**
 * 1. Webhook Endpoint (POST /webhook)
 * หมายเหตุ: ต้องวางไว้ก่อน express.json() เพื่อให้ line.middleware ตรวจสอบ x-line-signature จาก Raw Body ได้ถูกต้อง
 */
const lineMiddleware = line.middleware(lineConfig);

app.post(
  '/webhook',
  (req, res, next) => {
    console.log(`\n🔔 [Webhook Request] ได้รับคำขอ POST /webhook จาก LINE Platform`);
    lineMiddleware(req, res, (err) => {
      if (err) {
        console.error(
          '❌ [Signature Error] ตรวจสอบ x-line-signature ไม่ผ่าน! กรุณาตรวจสอบค่า LINE_CHANNEL_SECRET ในไฟล์ .env ให้ตรงกับแท็บ Basic settings ใน LINE Developers:',
          err.message
        );
        return res.status(401).json({ status: 'error', message: 'Invalid signature' });
      }
      next();
    });
  },
  (req, res) => {
    const events = req.body.events || [];
    console.log(`✅ [Webhook Verified] จำนวน Events ที่ได้รับ: ${events.length}`);

    // ตอบกลับ HTTP 200 OK ให้ LINE Platform ทันที เพื่อไม่ให้ LINE มองว่า Timeout แล้วส่งข้อความเก่าซ้ำ (Redelivery)
    res.status(200).json({ status: 'ok' });

    // ประมวลผลแต่ละ Event แบบ Asynchronous ในเบื้องหลัง
    Promise.all(events.map((event) => handleLineEvent(event))).catch((err) => {
      console.error('[Background Webhook Error]:', err.message);
    });
  }
);

/**
 * ส่งข้อความตอบกลับทาง LINE โดยใช้ replyMessage ก่อน
 * หาก replyToken หมดอายุ (เช่น OCR หรือ AI ใช้เวลานานเกิน 30 วินาที) จะสลับไปใช้ pushMessage อัตโนมัติ (ตามบทที่ 2 หัวข้อ 2.1.9)
 * @param {string} replyToken
 * @param {string} userId
 * @param {Array<object>} messages
 */
async function sendReplyOrPush(replyToken, userId, messages) {
  try {
    return await messagingClient.replyMessage({
      replyToken,
      messages,
    });
  } catch (err) {
    const isInvalidReplyToken =
      err?.status === 400 ||
      String(err?.body || err?.message || '').includes('Invalid reply token');

    if (isInvalidReplyToken && userId && userId !== 'unknown_user') {
      console.warn(
        `⚠️ [LINE Notice] replyToken หมดอายุระหว่างรอประมวลผล กำลังส่งผ่าน pushMessage ไปยัง ${userId} แทน...`
      );
      return await messagingClient.pushMessage({
        to: userId,
        messages,
      });
    }
    throw err;
  }
}

/**
 * ฟังก์ชันประมวลผลแต่ละ Event ที่รับจาก LINE Official Account
 * @param {object} event
 */
async function handleLineEvent(event) {
  if (event.type !== 'message') {
    return null;
  }

  // ป้องกันการประมวลผลข้อความเดิมซ้ำ (กรณี LINE ส่ง Redelivery หรือ Retry)
  const dedupeKey = event.message?.id || event.webhookEventId;
  if (dedupeKey) {
    if (processedEventIds.has(dedupeKey)) {
      console.warn(`⚠️ [Dedupe] ข้ามการประมวลผลข้อความซ้ำ (messageId: ${dedupeKey})`);
      return null;
    }
    processedEventIds.add(dedupeKey);
    // จำกัดขนาด Set ไม่ให้เกิน 1,000 รายการในหน่วยความจำ
    if (processedEventIds.size > 1000) {
      const oldest = processedEventIds.values().next().value;
      processedEventIds.delete(oldest);
    }
  }

  const userId = event.source?.userId || 'unknown_user';
  const replyToken = event.replyToken;

  // แสดง Loading Animation ในแชท LINE ระหว่างรอ OCR / Gemini ประมวลผล
  if (event.source?.type === 'user' && event.source?.userId) {
    messagingClient
      .showLoadingAnimation({
        chatId: event.source.userId,
        loadingSeconds: 20,
      })
      .catch(() => {});
  }

  try {
    // =========================================================================
    // กรณีที่ 1: รับข้อมูลประเภท "ข้อความ" (event.message.type === 'text')
    // =========================================================================
    if (event.message.type === 'text') {
      const userText = event.message.text.trim();
      console.log(`\n[LINE Text] จาก ${userId}: "${userText}"`);

      // คำสั่งพิเศษสำหรับดูสรุปยอด In-Memory ในแชท
      if (['สรุป', 'ประวัติ', 'summary'].includes(userText.toLowerCase())) {
        const summary = memoryStore.getSummary(userId);
        return await sendReplyOrPush(replyToken, userId, [
          {
            type: 'text',
            text: [
              `📊 สรุปรายการในหน่วยความจำ (In-Memory PoC)`,
              `- จำนวนรายการ: ${summary.count} รายการ`,
              `- รายรับรวม: +฿${summary.totalIncome.toLocaleString('th-TH')}`,
              `- รายจ่ายรวม: -฿${summary.totalExpense.toLocaleString('th-TH')}`,
              `- กระแสเงินสดสุทธิ: ฿${summary.netCashflow.toLocaleString('th-TH')}`,
            ].join('\n'),
          },
        ]);
      }

      // ส่งข้อความให้ Gemini API วิเคราะห์และแปลงเป็น JSON Schema
      const extractedData = await extractTransactionFromText(userText);
      console.log('[Gemini Extracted - Text]:', JSON.stringify(extractedData, null, 2));

      // บันทึกใน In-Memory Store
      memoryStore.addTransaction({
        userId,
        channel: 'text',
        extractedData,
        rawInput: userText,
      });

      // ตอบกลับผลลัพธ์ไปยังแชท LINE ทันที (พร้อมระบบสำรอง pushMessage)
      const replyMessages = buildTransactionReplyMessages(extractedData, 'text');
      return await sendReplyOrPush(replyToken, userId, replyMessages);
    }

    // =========================================================================
    // กรณีที่ 2: รับข้อมูลประเภท "รูปภาพสลิป/ใบเสร็จ" (event.message.type === 'image')
    // =========================================================================
    if (event.message.type === 'image') {
      const messageId = event.message.id;
      console.log(`\n[LINE Image] จาก ${userId}, messageId: ${messageId}`);

      // 1. ดาวน์โหลดรูปลง Temp -> 2. รัน Python Tesseract OCR (พร้อม Fallback Gemini Vision) -> 3. ลบไฟล์ Temp ทันที
      const { extractedData, rawOcrText } = await processLineImageAndExtract(blobClient, messageId);
      console.log('[Gemini Extracted - Image]:', JSON.stringify(extractedData, null, 2));

      // 4. บันทึกใน In-Memory Store
      memoryStore.addTransaction({
        userId,
        channel: 'image',
        extractedData,
        rawInput: rawOcrText,
      });

      // 5. ตอบกลับผลลัพธ์ไปยังแชท LINE ทันที (พร้อมระบบสำรอง pushMessage)
      const replyMessages = buildTransactionReplyMessages(extractedData, 'image', rawOcrText);
      return await sendReplyOrPush(replyToken, userId, replyMessages);
    }

    // กรณีส่งข้อมูลประเภทอื่นที่ยังไม่รองรับใน PoC รอบนี้
    return await sendReplyOrPush(replyToken, userId, [
      {
        type: 'text',
        text: '💡 ระบบ Cash Cast AI (PoC) รองรับการส่ง "ข้อความ" (เช่น ข้าวมันไก่ 50 บาท) และ "รูปภาพสลิป/ใบเสร็จ" ครับ',
      },
    ]);
  } catch (error) {
    console.error(`[Event Processing Error] (${event.message.type}):`, error.message);
    try {
      return await sendReplyOrPush(replyToken, userId, [
        {
          type: 'text',
          text: `❌ เกิดข้อผิดพลาดในการประมวลผล:\n${error.message}`,
        },
      ]);
    } catch (sendErr) {
      console.error('[Failed to send error notification to LINE]:', sendErr.message);
      return null;
    }
  }
}

// เปิดใช้งาน JSON Body Parser สำหรับ REST API อื่นๆ
app.use(express.json());

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Cash Cast AI - Fast PoC Backend',
    timestamp: new Date().toISOString(),
  });
});

/**
 * ดึงรายการธุรกรรมทั้งหมดจาก In-Memory Store
 */
app.get('/api/transactions', (req, res) => {
  const userId = req.query.userId;
  const summary = memoryStore.getSummary(userId);
  const data = memoryStore.getTransactions(userId);
  res.status(200).json({
    success: true,
    summary,
    data,
  });
});

/**
 * Endpoint สำหรับทดสอบ Pipeline ข้อความแบบ Local (ไม่ต้องผ่าน LINE Webhook)
 * POST /api/test/text  Body: { "text": "ข้าวมันไก่ 50 บาท" }
 */
app.post('/api/test/text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุฟิลด์ text' });
    }
    const extracted = await extractTransactionFromText(text);
    const saved = memoryStore.addTransaction({
      userId: 'local_tester',
      channel: 'text',
      extractedData: extracted,
      rawInput: text,
    });
    return res.status(200).json({
      success: true,
      extracted,
      saved,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Endpoint สำหรับทดสอบ Pipeline รูปภาพ OCR + Gemini แบบ Local
 * POST /api/test/image  Body: { "imagePath": "C:/path/to/receipt.jpg" }
 */
app.post('/api/test/image', async (req, res) => {
  try {
    const { imagePath } = req.body;
    if (!imagePath) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุฟิลด์ imagePath' });
    }
    const rawOcrText = await runTesseractOcr(imagePath);
    const extracted = await extractTransactionFromOcr(rawOcrText);
    const saved = memoryStore.addTransaction({
      userId: 'local_tester',
      channel: 'image',
      extractedData: extracted,
      rawInput: rawOcrText,
    });
    return res.status(200).json({
      success: true,
      rawOcrText,
      extracted,
      saved,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(config.port, '0.0.0.0', async () => {
  console.log('====================================================');
  console.log(`🚀 Cash Cast AI (PoC Server) running on port ${config.port}`);
  console.log(`📌 Local Webhook : http://127.0.0.1:${config.port}/webhook`);
  console.log(`📌 Health Check  : http://127.0.0.1:${config.port}/health`);
  console.log(`📌 Transactions  : http://127.0.0.1:${config.port}/api/transactions`);
  console.log('====================================================');

  // สร้าง Public HTTPS URL อัตโนมัติด้วย Cloudflare Tunnel (untun) สำหรับใส่ใน LINE Developers Console
  if (process.env.ENABLE_TUNNEL !== 'false') {
    try {
      console.log('⏳ กำลังสร้าง Public HTTPS Tunnel สำหรับ LINE Webhook...');
      const { startTunnel } = await import('untun');
      const tunnel = await startTunnel({
        port: config.port,
        hostname: '127.0.0.1',
        protocol: 'http',
        acceptCloudflareNotice: true,
        extraArgs: ['--protocol', 'http2'],
      });
      const publicUrl = await tunnel.getURL();
      if (publicUrl) {
        // รอให้ Cloudflare ลงทะเบียน Edge Connection (bkk) เสร็จสมบูรณ์
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const cleanUrl = publicUrl.replace(/\/$/, '');
        console.log('\n====================================================');
        console.log('✅ Tunnel พร้อมใช้งานแล้ว! คัดลอกลิงก์ใหม่ด้านล่างไปใส่ใน LINE:');
        console.log(`👉 ${cleanUrl}/webhook`);
        console.log('⚠️ หมายเหตุ: หากรีสตาร์ทเซิร์ฟเวอร์ ลิงก์ trycloudflare จะเปลี่ยนใหม่ทุกครั้ง');
        console.log('====================================================\n');
      }
    } catch (tunnelErr) {
      console.warn('⚠️ ไม่สามารถสร้าง HTTPS Tunnel อัตโนมัติได้:', tunnelErr.message);
    }
  }
});
