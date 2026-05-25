const functions = require('firebase-functions');
const admin = require('firebase-admin');
const line = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();

const app = express();

// LINE bot 設定
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;

if (!channelAccessToken || !channelSecret) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET is not set');
}

const lineClient = new line.Client({
  channelAccessToken: channelAccessToken,
  channelSecret: channelSecret,
});

// Webhook endpoint
app.post('/webhook', line.middleware({
  channelSecret: channelSecret,
}), async (req, res) => {
  try {
    const events = req.body.events;
    
    if (!events) {
      return res.json({ ok: true });
    }
    
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
exports.lineWebhook = functions
  .region('asia-east1')
  .https.onRequest(app);
