const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { messagingApi } = require('@line/bot-sdk');
const express = require('express');

admin.initializeApp();
const db = admin.firestore();

const app = express();

// ===== LINE client =====
let lineClient = null;
function getLineClient() {
  if (!lineClient) {
    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    });
  }
  return lineClient;
}

// ===== 假別清單 =====
const LEAVE_TYPES = [
  { name: '事假',   emoji: '💼', color: '#9E9E9E' },
  { name: '病假',   emoji: '🤒', color: '#90A4AE' },
  { name: '特休',   emoji: '🌴', color: '#4CAF50' },
  { name: '婚假',   emoji: '💍', color: '#EC407A' },
  { name: '喪假',   emoji: '🕊️',  color: '#546E7A' },
  { name: '陪產假', emoji: '👶', color: '#42A5F5' },
  { name: '產假',   emoji: '🤱', color: '#FF7043' },
];

function findLeaveType(name) {
  return LEAVE_TYPES.find(t => t.name === name);
}

// ===== 配色 =====
const COLOR = {
  headerMenu:    '#7E57C2', // 紫 - 主選單
  headerSelect:  '#3F51B5', // 深藍 - 選假別
  headerConfirm: '#FF9800', // 橘黃 - 確認
  headerReview:  '#F44336', // 紅 - 主管審核(2b 用)
  submit:        '#4CAF50',
  cancel:        '#9E9E9E',
  reject:        '#E53935',
  disabled:      '#BDBDBD', // 灰 - 敬請期待
};

// ===== Quick Reply 主選單按鈕(附在所有非流程訊息底下) =====
const MAIN_QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: '📝 請假', text: '請假' } },
    { type: 'action', action: { type: 'message', label: '🏥 體檢', text: '體檢' } },
    { type: 'action', action: { type: 'message', label: '💪 體能', text: '體能' } },
    { type: 'action', action: { type: 'message', label: '📋 主選單', text: '選單' } },
  ],
};

// ===== 訊息工具 =====
async function replyText(client, replyToken, text, withMenu = true) {
  const msg = { type: 'text', text };
  if (withMenu) msg.quickReply = MAIN_QUICK_REPLY;
  await client.replyMessage({ replyToken, messages: [msg] });
}

async function replyMessages(client, replyToken, messages) {
  await client.replyMessage({ replyToken, messages });
}

// 把 Quick Reply 加到最後一則訊息
function attachMenuQR(messages) {
  if (messages.length > 0) {
    messages[messages.length - 1].quickReply = MAIN_QUICK_REPLY;
  }
  return messages;
}

// ===== 算審核人 =====
async function getApprovers(employeeData) {
  if (employeeData.role === 'admin') return [];
  if (employeeData.role === 'manager') {
    const adminsSnap = await db.collection('employees').where('role', '==', 'admin').get();
    return adminsSnap.docs.map(d => d.id);
  }
  return employeeData.supervisor ? [employeeData.supervisor] : [];
}

// ===== 卡片:主選單 =====
function buildMainMenuFlex(employeeName) {
  return {
    type: 'flex',
    altText: 'HR Bot 主選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLOR.headerMenu,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `👋 您好,${employeeName}`, weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: 'HR Bot 服務選單', size: 'sm', color: '#FFFFFFCC', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: COLOR.submit,
            action: { type: 'message', label: '📝 請假申請', text: '請假' },
          },
          {
            type: 'button',
            style: 'primary',
            color: COLOR.disabled,
            action: { type: 'message', label: '🏥 體檢(敬請期待)', text: '體檢' },
          },
          {
            type: 'button',
            style: 'primary',
            color: COLOR.disabled,
            action: { type: 'message', label: '💪 體能(敬請期待)', text: '體能' },
          },
        ],
      },
    },
  };
}

// ===== 卡片:選假別 =====
function buildLeaveTypeFlex() {
  return {
    type: 'flex',
    altText: '請選擇假別',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLOR.headerSelect,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📝 請假申請', weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: '請選擇假別', size: 'sm', color: '#FFFFFFCC', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: LEAVE_TYPES.map(t => ({
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: t.color,
          action: {
            type: 'postback',
            label: `${t.emoji} ${t.name}`,
            data: `action=leaveType&value=${t.name}`,
            displayText: `${t.emoji} ${t.name}`,
          },
        })),
      },
    },
  };
}

// ===== 日期選擇器 =====
function buildDatePickerMessage(text, postbackData) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'datetimepicker', label: '📅 選日期', data: postbackData, mode: 'date' },
        },
        {
          type: 'action',
          action: { type: 'postback', label: '❌ 取消', data: 'action=cancel' },
        },
      ],
    },
  };
}

// ===== 卡片:確認假單 =====
function buildConfirmFlex(data) {
  const t = findLeaveType(data.type);
  return {
    type: 'flex',
    altText: '確認假單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLOR.headerConfirm,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📋 確認假單', weight: 'bold', size: 'lg', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'vertical', spacing: 'xs', contents: [
              { type: 'text', text: '📅 假別', size: 'xs', color: '#888888' },
              { type: 'text', text: `${t.emoji} ${data.type}`, size: 'md', weight: 'bold' },
            ],
          },
          { type: 'separator' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs', contents: [
              { type: 'text', text: '⏰ 日期', size: 'xs', color: '#888888' },
              { type: 'text', text: `${data.startDate} ~ ${data.endDate}`, size: 'md', weight: 'bold' },
            ],
          },
          { type: 'separator' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs', contents: [
              { type: 'text', text: '📆 天數', size: 'xs', color: '#888888' },
              { type: 'text', text: `${data.days} 天`, size: 'md', weight: 'bold' },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button', style: 'primary', color: COLOR.cancel,
            action: { type: 'postback', label: '❌ 取消', data: 'action=cancel' },
          },
          {
            type: 'button', style: 'primary', color: COLOR.submit,
            action: { type: 'postback', label: '✅ 送出', data: 'action=submit' },
          },
        ],
      },
    },
  };
}

// ===== 算天數 =====
function calcDays(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  const diff = Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
  return diff > 0 ? diff : 1;
}

// ===== 啟動請假流程 =====
async function startLeaveFlow(client, replyToken, bindingRef) {
  await bindingRef.update({
    currentFlow: { type: 'leave', step: 'selectType', data: {} },
  });
  // 流程中不附 Quick Reply
  await replyMessages(client, replyToken, [buildLeaveTypeFlex()]);
}

// ===== 取消流程 =====
async function cancelFlow(client, replyToken, bindingRef) {
  await bindingRef.update({
    currentFlow: admin.firestore.FieldValue.delete(),
  });
  await replyText(client, replyToken, '已取消 ❌');
}

// ===== 送出假單 =====
async function submitLeave(client, replyToken, bindingRef, employeeName, data) {
  const empSnap = await db.collection('employees').doc(employeeName).get();
  const empData = empSnap.data();
  const approvers = await getApprovers(empData);

  const isAdmin = empData.role === 'admin';
  const status = isAdmin ? 'approved' : 'pending';

  await db.collection('leaveRequests').add({
    employeeName,
    type: data.type,
    startDate: data.startDate,
    endDate: data.endDate,
    days: data.days,
    status,
    approvers,
    decidedBy: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    decidedAt: isAdmin ? admin.firestore.FieldValue.serverTimestamp() : null,
  });

  await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });

  const msg = isAdmin
    ? '假單已自動核准 ✅(管理員不需審核)'
    : '假單已送出 ⏳ 正在等待審核';
  await replyText(client, replyToken, msg);
}

// ===== 處理 postback =====
async function handlePostback(client, event) {
  const userId = event.source.userId;
  const params = Object.fromEntries(new URLSearchParams(event.postback.data));

  const bindingRef = db.collection('lineBindings').doc(userId);
  const bindingSnap = await bindingRef.get();
  if (!bindingSnap.exists) {
    await replyText(client, event.replyToken, '請先輸入您的姓名綁定帳號', false);
    return;
  }
  const binding = bindingSnap.data();
  const employeeName = binding.employeeName;
  const flow = binding.currentFlow;

  // 取消
  if (params.action === 'cancel') {
    if (flow) return cancelFlow(client, event.replyToken, bindingRef);
    await replyText(client, event.replyToken, '沒有進行中的流程');
    return;
  }

  if (!flow || flow.type !== 'leave') {
    await replyText(client, event.replyToken, '沒有進行中的請假流程,請點主選單開始');
    return;
  }

  // 選假別
  if (params.action === 'leaveType' && flow.step === 'selectType') {
    const newData = { ...flow.data, type: params.value };
    await bindingRef.update({
      currentFlow: { type: 'leave', step: 'startDate', data: newData },
    });
    const t = findLeaveType(params.value);
    await replyMessages(client, event.replyToken, [
      buildDatePickerMessage(`已選:${t.emoji} ${params.value}\n\n請選擇開始日期`, 'action=startDate'),
    ]);
    return;
  }

  // 選開始日期
  if (params.action === 'startDate' && flow.step === 'startDate') {
    const startDate = event.postback.params.date;
    const newData = { ...flow.data, startDate };
    await bindingRef.update({
      currentFlow: { type: 'leave', step: 'endDate', data: newData },
    });
    await replyMessages(client, event.replyToken, [
      buildDatePickerMessage(`開始日期:${startDate}\n\n請選擇結束日期`, 'action=endDate'),
    ]);
    return;
  }

  // 選結束日期
  if (params.action === 'endDate' && flow.step === 'endDate') {
    const endDate = event.postback.params.date;
    const startDate = flow.data.startDate;

    if (new Date(endDate) < new Date(startDate)) {
      await replyMessages(client, event.replyToken, [
        buildDatePickerMessage(
          `⚠️ 結束日期不能早於開始日期(${startDate})\n請重新選擇`,
          'action=endDate'
        ),
      ]);
      return;
    }

    const days = calcDays(startDate, endDate);
    const newData = { ...flow.data, endDate, days };
    await bindingRef.update({
      currentFlow: { type: 'leave', step: 'confirm', data: newData },
    });
    await replyMessages(client, event.replyToken, [buildConfirmFlex(newData)]);
    return;
  }

  // 送出
  if (params.action === 'submit' && flow.step === 'confirm') {
    return submitLeave(client, event.replyToken, bindingRef, employeeName, flow.data);
  }
}

// ===== follow 事件 =====
async function handleFollow(client, event) {
  await replyText(
    client,
    event.replyToken,
    '您好!我是 HR Bot 🤖\n\n請輸入您的「姓名」完成綁定,例如:王O明',
    false
  );
}

// ===== 文字訊息 =====
async function handleTextMessage(client, event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  const bindingRef = db.collection('lineBindings').doc(userId);
  const bindingSnap = await bindingRef.get();

  // === 未綁定 ===
  if (!bindingSnap.exists) {
    const employeeRef = db.collection('employees').doc(text);
    const employeeSnap = await employeeRef.get();

    if (!employeeSnap.exists) {
      await replyText(client, event.replyToken, '查無此員工 ❌\n請確認姓名是否正確(範例:王O明)', false);
      return;
    }
    if (employeeSnap.data().lineUserId) {
      await replyText(client, event.replyToken, '此員工姓名已被綁定 ⚠️\n如有問題請聯絡 HR', false);
      return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.update(employeeRef, { lineUserId: userId, boundAt: now });
    batch.set(bindingRef, { employeeName: text, boundAt: now });
    await batch.commit();

    // 綁定成功 → 跳主選單 + 文字提示
    await replyMessages(client, event.replyToken, attachMenuQR([
      { type: 'text', text: `綁定成功!您好,${text} 👋` },
      buildMainMenuFlex(text),
    ]));
    return;
  }

  // === 已綁定 ===
  const binding = bindingSnap.data();
  const employeeName = binding.employeeName;
  const flow = binding.currentFlow;

  // 取消
  if (text === '取消' && flow) {
    return cancelFlow(client, event.replyToken, bindingRef);
  }

  // 主選單關鍵字
  if (['選單', 'menu', 'Menu', 'MENU', '功能'].includes(text)) {
    await replyMessages(client, event.replyToken, attachMenuQR([
      buildMainMenuFlex(employeeName),
    ]));
    return;
  }

  // 體檢/體能 → 敬請期待
  if (text === '體檢') {
    await replyText(client, event.replyToken, '🏥 體檢功能開發中,敬請期待!');
    return;
  }
  if (text === '體能') {
    await replyText(client, event.replyToken, '💪 體能功能開發中,敬請期待!');
    return;
  }

  // 請假
  if (text === '請假' || text === '我要請假') {
    return startLeaveFlow(client, event.replyToken, bindingRef);
  }

  // 流程中傳了無關文字
  if (flow && flow.type === 'leave') {
    await replyText(
      client,
      event.replyToken,
      '請依照上方按鈕操作,或輸入「取消」結束目前流程',
      false
    );
    return;
  }

  // 預設 → 跳主選單
  await replyMessages(client, event.replyToken, attachMenuQR([
    { type: 'text', text: `您好 ${employeeName} 👋` },
    buildMainMenuFlex(employeeName),
  ]));
}

// ===== Webhook =====
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const events = req.body.events;
    if (!events) return res.json({ ok: true });

    const client = getLineClient();
    for (const event of events) {
      if (event.type === 'follow') {
        await handleFollow(client, event);
      } else if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(client, event);
      } else if (event.type === 'postback') {
        await handlePostback(client, event);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

exports.lineWebhook = onRequest({ region: 'asia-east1' }, app);
