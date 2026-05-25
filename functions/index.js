const functions = require('firebase-functions');
const admin = require('firebase-admin');
const line = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();

const app = express();

// 延遲建立 LINE client（只在第一次收到 webhook 時建立）
let lineClient = null;
function getLineClient() {
  if (!lineClient) {
    lineClient = new line.Client({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
      channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    });
  }
  return lineClient;
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    
    if (!events) {
      return res.json({ ok: true });
    }
    
    const client = getLineClient();
    
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: 'Hello! 我是你的 HR Bot 🤖',
        });
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cloud Function 導出
exports.lineWebhook = functions
  .region('asia-east1')
  .https.onRequest(app);
