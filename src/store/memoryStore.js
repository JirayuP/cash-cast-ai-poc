/**
 * In-Memory Transaction Store (สำหรับ Fast PoC โดยยังไม่ต้องเชื่อมต่อ PostgreSQL)
 */

const transactions = [];
let nextId = 1;

/**
 * บันทึกรายการธุรกรรมลงในหน่วยความจำ (In-Memory)
 * @param {object} params
 * @param {string} params.userId - LINE User ID
 * @param {string} params.channel - ช่องทางการบันทึก ('text' | 'image')
 * @param {object} params.extractedData - ข้อมูล JSON ที่สกัดได้จาก Gemini API
 * @param {string} [params.rawInput] - ข้อความต้นฉบับ หรือข้อความดิบจาก OCR
 */
function addTransaction({ userId, channel, extractedData, rawInput = '' }) {
  const record = {
    id: nextId++,
    userId: userId || 'anonymous',
    channel, // 'text' | 'image'
    type: extractedData.type,
    title: extractedData.title,
    amount: Number(extractedData.amount) || 0,
    category: extractedData.category,
    date: extractedData.date,
    items: Array.isArray(extractedData.items) ? extractedData.items : [],
    rawInput,
    createdAt: new Date().toISOString(),
  };

  transactions.unshift(record); // เก็บรายการล่าสุดไว้บนสุด
  return record;
}

/**
 * ดึงรายการธุรกรรมทั้งหมด (หรือกรองตาม userId)
 * @param {string} [userId]
 */
function getTransactions(userId) {
  if (!userId) return transactions;
  return transactions.filter((t) => t.userId === userId);
}

/**
 * คำนวณสรุปยอดรายรับ-รายจ่ายในหน่วยความจำ
 * @param {string} [userId]
 */
function getSummary(userId) {
  const list = getTransactions(userId);
  const totalIncome = list
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = list
    .filter((t) => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);

  return {
    count: list.length,
    totalIncome,
    totalExpense,
    netCashflow: totalIncome - totalExpense,
    recentTransactions: list.slice(0, 10),
  };
}

module.exports = {
  addTransaction,
  getTransactions,
  getSummary,
};
