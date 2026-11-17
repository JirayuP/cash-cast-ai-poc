const config = require('../config/env');

/**
 * สร้างข้อความสรุปและ Flex Message ตอบกลับไปยังแชท LINE ทันที
 * อ้างอิงดีไซน์จาก รูปที่ 1.5 (หน้าจอการบันทึกรายการผ่าน LINE Official Account) ในเอกสารโครงงาน
 *
 * @param {object} data - ข้อมูล JSON ที่สกัดได้จาก Gemini API
 * @param {'text' | 'image'} channel - ช่องทางที่รับข้อมูล
 * @param {string} [rawOcrText] - ข้อความดิบจาก OCR (กรณีรูปภาพ)
 * @returns {Array<object>} อาเรย์ของ LINE Message Objects สำหรับส่งใน replyMessage
 */
function buildTransactionReplyMessages(data, channel = 'text', rawOcrText = '') {
  const isVisionFallback =
    channel === 'image' && rawOcrText === '[Extracted via Gemini Vision Fallback]';
  const isIncome = data.type === 'income';
  const sign = isIncome ? '+' : '-';
  const amountColor = isIncome ? '#16A34A' : '#EA580C';
  const badgeColor = channel === 'image' ? '#2563EB' : '#16A34A';
  const headerTitle =
    channel === 'image'
      ? isVisionFallback
        ? '✨ อ่านสลิป/ใบเสร็จด้วย Gemini Vision สำเร็จ'
        : '📄 อ่านสลิป/ใบเสร็จด้วย Tesseract OCR สำเร็จ'
      : '✅ บันทึกรายการแล้ว';
  const channelLabel =
    channel === 'image'
      ? isVisionFallback
        ? 'รูปภาพ (Gemini Vision)'
        : 'รูปภาพ (Tesseract OCR)'
      : 'ข้อความ';
  const typeLabel = isIncome ? 'รายรับ' : 'รายจ่าย';
  const formattedAmount = `${sign}฿${Number(data.amount || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

  // สร้างรายการย่อย (กรณีใบเสร็จมีหลายรายการสินค้า เช่น 7-Eleven)
  const itemRows =
    Array.isArray(data.items) && data.items.length > 0
      ? [
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: `รายการย่อย (${data.items.length} รายการ)`,
            size: 'xs',
            color: '#6B7280',
            weight: 'bold',
            margin: 'md',
          },
          ...data.items.slice(0, 10).map((item) => ({
            type: 'box',
            layout: 'horizontal',
            margin: 'xs',
            contents: [
              {
                type: 'text',
                text: String(item.name || '-'),
                size: 'xs',
                color: '#374151',
                flex: 3,
                wrap: true,
              },
              {
                type: 'text',
                text: `฿${Number(item.price || 0).toLocaleString('th-TH')}`,
                size: 'xs',
                color: '#111827',
                align: 'end',
                flex: 1,
              },
            ],
          })),
        ]
      : [];

  const flexBubble = {
    type: 'flex',
    altText: `${headerTitle}: ${data.title} ${formattedAmount} (${data.category})`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: headerTitle,
            size: 'xs',
            weight: 'bold',
            color: badgeColor,
          },
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: String(data.title || 'ไม่ระบุรายการ'),
                size: 'lg',
                weight: 'bold',
                color: '#111827',
                flex: 3,
                wrap: true,
              },
              {
                type: 'text',
                text: formattedAmount,
                size: 'lg',
                weight: 'bold',
                color: amountColor,
                align: 'end',
                flex: 2,
              },
            ],
          },
          {
            type: 'text',
            text: `${data.date} · ${typeLabel} (${data.category}) · ${channelLabel}`,
            size: 'xs',
            color: '#6B7280',
            margin: 'xs',
            wrap: true,
          },
          ...itemRows,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1D4ED8',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'เปิดดูในแดชบอร์ด',
              uri: config.liffUrl || 'https://liff.line.me',
            },
          },
        ],
      },
    },
  };

  return [flexBubble];
}

module.exports = {
  buildTransactionReplyMessages,
};
