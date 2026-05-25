const functions = require('firebase-functions');
const admin = require('firebase-admin');
const line = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();

const app = express();

// LINE bot 設定（待會要改這裡）
const lineClient = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// Webhook endpoint
app.post('/webhook', line.middleware({
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}), async (req, res) => {
  try {
    const events = req.body.events;
    
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        // 有人傳文字訊息時
        await lineClient.replyMessage(event.replyToken, {
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
exports.lineWebhook = functions.https.onRequest(app);
