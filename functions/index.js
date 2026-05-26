const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { messagingApi } = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();
const db = admin.firestore();

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

// 回覆訊息小工具
async function reply(client, replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

// 處理加好友事件
async function handleFollow(client, event) {
  await reply(
    client,
    event.replyToken,
    '您好!我是 HR Bot 🤖\n\n請輸入您的「姓名」完成綁定,例如:王小明'
  );
}

// 處理文字訊息事件
async function handleTextMessage(client, event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  // 1. 檢查這個 LINE userId 是否已綁定
  const bindingRef = db.collection('lineBindings').doc(userId);
  const bindingSnap = await bindingRef.get();

  if (bindingSnap.exists) {
    const employeeName = bindingSnap.data().employeeName;
    await reply(
      client,
      event.replyToken,
      `您已綁定為 ${employeeName} ✅\n目前還沒有其他功能,敬請期待!`
    );
    return;
  }

  // 2. 未綁定 → 把訊息當成姓名查 employees
  const employeeRef = db.collection('employees').doc(text);
  const employeeSnap = await employeeRef.get();

  if (!employeeSnap.exists) {
    await reply(
      client,
      event.replyToken,
      '查無此員工 ❌\n請確認姓名是否正確(範例:王小明)'
    );
    return;
  }

  // 3. 該員工已被別人綁走
  const employeeData = employeeSnap.data();
  if (employeeData.lineUserId) {
    await reply(
      client,
      event.replyToken,
      '此員工姓名已被綁定 ⚠️\n如有問題請聯絡 HR'
    );
    return;
  }

  // 4. OK → 寫入雙向綁定
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.update(employeeRef, { lineUserId: userId, boundAt: now });
  batch.set(bindingRef, { employeeName: text, boundAt: now });
  await batch.commit();

  await reply(
    client,
    event.replyToken,
    `綁定成功!您好,${text} 👋\n之後請假等功能會陸續開放`
  );
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
      if (event.type === 'follow') {
        await handleFollow(client, event);
      } else if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(client, event);
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
