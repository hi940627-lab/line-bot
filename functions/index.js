const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { messagingApi } = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();

const app = express();

// 延遲建立 LINE client
let lineClient = null;
function getLineClient() {
  if (!lineClient) {
    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    });
  }
  return lineClient;
}

// Webhook endpoint
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const events = req.body.events;

    if (!events) {
      return res.json({ ok: true });
    }

    const client = getLineClient();

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: 'Hello! 我是你的 HR Bot 🤖',
          }],
        });
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cloud Function v2 寫法
exports.lineWebhook = onRequest({
  region: 'asia-east1',
}, app);
