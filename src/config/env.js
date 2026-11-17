const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: Number(process.env.PORT) || 5000,
  line: {
    channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim(),
    channelSecret: (process.env.LINE_CHANNEL_SECRET || '').trim(),
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    model: (process.env.GEMINI_MODEL || 'gemini-3-flash-preview').trim(),
    fallbackModels: ['gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'],
  },
  ocr: {
    pythonPath: process.env.PYTHON_PATH || 'python',
    tesseractCmd: process.env.TESSERACT_CMD || '',
    scriptPath: path.resolve(__dirname, '../../python/ocr.py'),
    tempDir: path.resolve(__dirname, '../../temp'),
  },
  liffUrl: process.env.LIFF_URL || 'https://liff.line.me',
};

module.exports = config;
