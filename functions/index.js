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
  headerMenu:    '#7E57C2',
  headerSelect:  '#3F51B5',
  headerConfirm: '#FF9800',
  headerReview:  '#F44336',
  headerResult:  '#2196F3', // 藍 - 員工收到的審核結果
  submit:        '#4CAF50',
  cancel:        '#9E9E9E',
  reject:        '#E53935',
  disabled:      '#BDBDBD',
};

// ===== Quick Reply =====
const MAIN_QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: '📝 請假', text: '請假' } },
    { type: 'action', action: { type: 'message', label: '🏥 體檢', text: '體檢' } },
    { type: 'action', action: { type: 'message', label: '💪 體能', text: '體能' } },
    { type: 'action', action: { type: 'message', label: '📋 主選單', text: '選單' } },
  ],
};

// ===== 星期幾(中文) =====
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
function formatDateWithWeekday(dateStr) {
  const d = new Date(dateStr);
  return `${dateStr} (${WEEKDAYS[d.getDay()]})`;
}

// ===== 訊息工具 =====
async function replyText(client, replyToken, text, withMenu = true) {
  const msg = { type: 'text', text };
  if (withMenu) msg.quickReply = MAIN_QUICK_REPLY;
  await client.replyMessage({ replyToken, messages: [msg] });
}

async function replyMessages(client, replyToken, messages) {
  await client.replyMessage({ replyToken, messages });
}

function attachMenuQR(messages) {
  if (messages.length > 0) {
    messages[messages.length - 1].quickReply = MAIN_QUICK_REPLY;
  }
  return messages;
}

// ===== 主動推播 =====
async function pushMessages(client, toUserId, messages) {
  try {
    await client.pushMessage({ to: toUserId, messages });
    return true;
  } catch (err) {
    console.error(`Push to ${toUserId} failed:`, err.message);
    return false;
  }
}

// ===== 算審核人 =====
async function getApprovers(employeeData, employeeName) {
  if (employeeData.role === 'admin') return [];
  if (employeeData.role === 'manager') {
    const adminsSnap = await db.collection('employees').where('role', '==', 'admin').get();
    // 排除自己(保險:不能自己審自己)
    return adminsSnap.docs.map(d => d.id).filter(name => name !== employeeName);
  }
  // 一般員工:supervisor,且排除自己
  if (employeeData.supervisor && employeeData.supervisor !== employeeName) {
    return [employeeData.supervisor];
  }
  return [];
}

// ===== 從員工姓名查 lineUserId =====
async function getLineUserIdByName(employeeName) {
  const snap = await db.collection('employees').doc(employeeName).get();
  if (!snap.exists) return null;
  return snap.data().lineUserId || null;
}

// ===== 卡片:主選單 =====
function buildMainMenuFlex(employeeName) {
  return {
    type: 'flex',
    altText: 'HR Bot 主選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: COLOR.headerMenu, paddingAll: '16px',
        contents: [
          { type: 'text', text: `👋 您好,${employeeName}`, weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: 'HR Bot 服務選單', size: 'sm', color: '#FFFFFFCC', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'button', style: 'primary', color: COLOR.submit,
            action: { type: 'message', label: '📝 請假申請', text: '請假' } },
          { type: 'button', style: 'primary', color: COLOR.disabled,
            action: { type: 'message', label: '🏥 體檢(敬請期待)', text: '體檢' } },
          { type: 'button', style: 'primary', color: COLOR.disabled,
            action: { type: 'message', label: '💪 體能(敬請期待)', text: '體能' } },
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
        type: 'box', layout: 'vertical',
        backgroundColor: COLOR.headerSelect, paddingAll: '16px',
        contents: [
          { type: 'text', text: '📝 請假申請', weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: '請選擇假別', size: 'sm', color: '#FFFFFFCC', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: LEAVE_TYPES.map(t => ({
          type: 'button', style: 'primary', height: 'sm', color: t.color,
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
        { type: 'action', action: { type: 'datetimepicker', label: '📅 選日期', data: postbackData, mode: 'date' } },
        { type: 'action', action: { type: 'postback', label: '❌ 取消', data: 'action=cancel' } },
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
        type: 'box', layout: 'vertical',
        backgroundColor: COLOR.headerConfirm, paddingAll: '16px',
        contents: [
          { type: 'text', text: '📋 確認假單', weight: 'bold', size: 'lg', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📅 假別', size: 'xs', color: '#888888' },
            { type: 'text', text: `${t.emoji} ${data.type}`, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '⏰ 日期', size: 'xs', color: '#888888' },
            { type: 'text', text: formatDateWithWeekday(data.startDate), size: 'md', weight: 'bold', wrap: true },
            { type: 'text', text: `~ ${formatDateWithWeekday(data.endDate)}`, size: 'md', weight: 'bold', wrap: true },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📆 天數', size: 'xs', color: '#888888' },
            { type: 'text', text: `${data.days} 天`, size: 'md', weight: 'bold' },
          ]},
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: COLOR.cancel,
            action: { type: 'postback', label: '❌ 取消', data: 'action=cancel' } },
          { type: 'button', style: 'primary', color: COLOR.submit,
            action: { type: 'postback', label: '✅ 送出', data: 'action=submit' } },
        ],
      },
    },
  };
}

// ===== 卡片:主管審核 =====
function buildReviewFlex(requestId, requestData) {
  const t = findLeaveType(requestData.type);
  return {
    type: 'flex',
    altText: `新假單待審核:${requestData.employeeName} - ${requestData.type} ${requestData.days}天`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: COLOR.headerReview, paddingAll: '16px',
        contents: [
          { type: 'text', text: '🔔 新假單待審核', weight: 'bold', size: 'lg', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '👤 申請人', size: 'xs', color: '#888888' },
            { type: 'text', text: requestData.employeeName, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📅 假別', size: 'xs', color: '#888888' },
            { type: 'text', text: `${t.emoji} ${requestData.type}`, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '⏰ 日期', size: 'xs', color: '#888888' },
            { type: 'text', text: formatDateWithWeekday(requestData.startDate), size: 'md', weight: 'bold', wrap: true },
            { type: 'text', text: `~ ${formatDateWithWeekday(requestData.endDate)}`, size: 'md', weight: 'bold', wrap: true },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📆 天數', size: 'xs', color: '#888888' },
            { type: 'text', text: `${requestData.days} 天`, size: 'md', weight: 'bold' },
          ]},
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: COLOR.reject,
            action: { type: 'postback', label: '❌ 駁回', data: `action=reject&id=${requestId}` } },
          { type: 'button', style: 'primary', color: COLOR.submit,
            action: { type: 'postback', label: '✅ 核准', data: `action=approve&id=${requestId}` } },
        ],
      },
    },
  };
}

// ===== 卡片:員工收到的審核結果 =====
function buildResultFlex(requestData, approved, reviewerName) {
  const t = findLeaveType(requestData.type);
  const statusEmoji = approved ? '✅' : '❌';
  const statusText = approved ? '已核准' : '已駁回';
  const headerColor = approved ? COLOR.submit : COLOR.reject;
  const altPrefix = approved ? '✅' : '❌';

  return {
    type: 'flex',
    altText: `${altPrefix} 您的${requestData.type}${statusText}(${requestData.startDate}~${requestData.endDate})`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: headerColor, paddingAll: '16px',
        contents: [
          { type: 'text', text: `${statusEmoji} 假單${statusText}`, weight: 'bold', size: 'lg', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📅 假別', size: 'xs', color: '#888888' },
            { type: 'text', text: `${t.emoji} ${requestData.type}`, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '⏰ 日期', size: 'xs', color: '#888888' },
            { type: 'text', text: formatDateWithWeekday(requestData.startDate), size: 'md', weight: 'bold', wrap: true },
            { type: 'text', text: `~ ${formatDateWithWeekday(requestData.endDate)}`, size: 'md', weight: 'bold', wrap: true },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📆 天數', size: 'xs', color: '#888888' },
            { type: 'text', text: `${requestData.days} 天`, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '👤 審核人', size: 'xs', color: '#888888' },
            { type: 'text', text: reviewerName, size: 'md', weight: 'bold' },
          ]},
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
  await replyMessages(client, replyToken, [buildLeaveTypeFlex()]);
}

async function cancelFlow(client, replyToken, bindingRef) {
  await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });
  await replyText(client, replyToken, '已取消 ❌');
}

// ===== 通知審核人 =====
async function notifyApprovers(client, requestId, requestData, approverNames) {
  const failedNames = [];
  let sentCount = 0;

  for (const approverName of approverNames) {
    const lineUserId = await getLineUserIdByName(approverName);
    if (!lineUserId) {
      failedNames.push(approverName);
      continue;
    }
    const ok = await pushMessages(client, lineUserId, [
      buildReviewFlex(requestId, requestData),
    ]);
    if (ok) sentCount++;
    else failedNames.push(approverName);
  }

  return { sentCount, failedNames };
}

// ===== 送出假單 =====
async function submitLeave(client, replyToken, bindingRef, employeeName, data) {
  const empSnap = await db.collection('employees').doc(employeeName).get();
  const empData = empSnap.data();
  const approvers = await getApprovers(empData, employeeName);
  const isAdmin = empData.role === 'admin';

  // 檢查審核人都綁定了
  if (!isAdmin) {
    if (approvers.length === 0) {
      await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });
      await replyText(
        client, replyToken,
        '❌ 無法送出\n\n找不到您的審核人,請聯絡 HR'
      );
      return;
    }
    const unboundNames = [];
    for (const name of approvers) {
      const lineUserId = await getLineUserIdByName(name);
      if (!lineUserId) unboundNames.push(name);
    }
    if (unboundNames.length > 0) {
      await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });
      await replyText(
        client, replyToken,
        `❌ 無法送出\n\n您的審核人尚未綁定 LINE Bot:\n${unboundNames.join('、')}\n\n請聯絡 HR 協助`
      );
      return;
    }
  }

  // 寫入假單
  const status = isAdmin ? 'approved' : 'pending';
  const newDocRef = await db.collection('leaveRequests').add({
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

  if (isAdmin) {
    await replyText(client, replyToken, '假單已自動核准 ✅(管理員不需審核)');
    return;
  }

  // 推播給審核人
  const requestData = {
    employeeName,
    type: data.type,
    startDate: data.startDate,
    endDate: data.endDate,
    days: data.days,
  };
  const { sentCount } = await notifyApprovers(client, newDocRef.id, requestData, approvers);

  const approverText = approvers.length === 1
    ? approvers[0]
    : `${approvers.join('、')}(誰先審核以誰為準)`;

  await replyText(
    client, replyToken,
    `假單已送出 ⏳\n\n審核人:${approverText}\n已通知 ${sentCount}/${approvers.length} 位`
  );
}

// ===== 處理核准/駁回 =====
async function handleReviewPostback(client, event, action, requestId) {
  const userId = event.source.userId;

  const bindingSnap = await db.collection('lineBindings').doc(userId).get();
  if (!bindingSnap.exists) {
    await replyText(client, event.replyToken, '請先綁定帳號', false);
    return;
  }
  const reviewerName = bindingSnap.data().employeeName;

  const requestRef = db.collection('leaveRequests').doc(requestId);
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(requestRef);
      if (!snap.exists) {
        return { ok: false, reason: 'notfound' };
      }
      const data = snap.data();

      if (data.status !== 'pending') {
        return { ok: false, reason: 'alreadyDecided', data };
      }

      if (!data.approvers.includes(reviewerName)) {
        return { ok: false, reason: 'notApprover', data };
      }

      // 不能自己審自己(保險)
      if (data.employeeName === reviewerName) {
        return { ok: false, reason: 'selfReview', data };
      }

      tx.update(requestRef, {
        status: newStatus,
        decidedBy: reviewerName,
        decidedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, data };
    });

    if (!result.ok) {
      if (result.reason === 'notfound') {
        await replyText(client, event.replyToken, '⚠️ 找不到該假單');
      } else if (result.reason === 'alreadyDecided') {
        const statusText = result.data.status === 'approved' ? '已被核准' : '已被駁回';
        await replyText(client, event.replyToken,
          `⚠️ 此假單${statusText}\n審核人:${result.data.decidedBy}`);
      } else if (result.reason === 'notApprover') {
        await replyText(client, event.replyToken, '⚠️ 您不是此假單的審核人');
      } else if (result.reason === 'selfReview') {
        await replyText(client, event.replyToken, '⚠️ 不能審核自己的假單');
      }
      return;
    }

    // 成功 → 回覆審核者
    const t = findLeaveType(result.data.type);
    const actionText = action === 'approve' ? '已核准 ✅' : '已駁回 ❌';
    await replyText(
      client, event.replyToken,
      `${actionText}\n\n申請人:${result.data.employeeName}\n假別:${t.emoji} ${result.data.type}\n日期:${formatDateWithWeekday(result.data.startDate)} ~ ${formatDateWithWeekday(result.data.endDate)}`
    );

    // Push 通知員工結果(原 2c)
    const employeeLineId = await getLineUserIdByName(result.data.employeeName);
    if (employeeLineId) {
      await pushMessages(client, employeeLineId, [
        buildResultFlex(result.data, action === 'approve', reviewerName),
      ]);
    }
  } catch (err) {
    console.error('Review transaction error:', err);
    await replyText(client, event.replyToken, '❌ 審核失敗,請稍後再試');
  }
}

// ===== 處理 postback =====
async function handlePostback(client, event) {
  const userId = event.source.userId;
  const params = Object.fromEntries(new URLSearchParams(event.postback.data));

  // 審核(獨立路由)
  if (params.action === 'approve' || params.action === 'reject') {
    return handleReviewPostback(client, event, params.action, params.id);
  }

  const bindingRef = db.collection('lineBindings').doc(userId);
  const bindingSnap = await bindingRef.get();
  if (!bindingSnap.exists) {
    await replyText(client, event.replyToken, '請先輸入您的姓名綁定帳號', false);
    return;
  }
  const binding = bindingSnap.data();
  const employeeName = binding.employeeName;
  const flow = binding.currentFlow;

  if (params.action === 'cancel') {
    if (flow) return cancelFlow(client, event.replyToken, bindingRef);
    await replyText(client, event.replyToken, '沒有進行中的流程');
    return;
  }

  if (!flow || flow.type !== 'leave') {
    await replyText(client, event.replyToken, '沒有進行中的請假流程,請點主選單開始');
    return;
  }

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

  if (params.action === 'startDate' && flow.step === 'startDate') {
    const startDate = event.postback.params.date;
    const newData = { ...flow.data, startDate };
    await bindingRef.update({
      currentFlow: { type: 'leave', step: 'endDate', data: newData },
    });
    await replyMessages(client, event.replyToken, [
      buildDatePickerMessage(
        `開始日期:${formatDateWithWeekday(startDate)}\n\n請選擇結束日期`,
        'action=endDate'
      ),
    ]);
    return;
  }

  if (params.action === 'endDate' && flow.step === 'endDate') {
    const endDate = event.postback.params.date;
    const startDate = flow.data.startDate;

    if (new Date(endDate) < new Date(startDate)) {
      await replyMessages(client, event.replyToken, [
        buildDatePickerMessage(
          `⚠️ 結束日期不能早於開始日期(${formatDateWithWeekday(startDate)})\n請重新選擇`,
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

  if (params.action === 'submit' && flow.step === 'confirm') {
    return submitLeave(client, event.replyToken, bindingRef, employeeName, flow.data);
  }
}

// ===== follow 事件 =====
async function handleFollow(client, event) {
  await replyText(
    client, event.replyToken,
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

    await replyMessages(client, event.replyToken, attachMenuQR([
      { type: 'text', text: `綁定成功!您好,${text} 👋` },
      buildMainMenuFlex(text),
    ]));
    return;
  }

  const binding = bindingSnap.data();
  const employeeName = binding.employeeName;
  const flow = binding.currentFlow;

  if (text === '取消' && flow) {
    return cancelFlow(client, event.replyToken, bindingRef);
  }

  if (['選單', 'menu', 'Menu', 'MENU', '功能'].includes(text)) {
    await replyMessages(client, event.replyToken, attachMenuQR([
      buildMainMenuFlex(employeeName),
    ]));
    return;
  }

  if (text === '體檢') {
    await replyText(client, event.replyToken, '🏥 體檢功能開發中,敬請期待!');
    return;
  }
  if (text === '體能') {
    await replyText(client, event.replyToken, '💪 體能功能開發中,敬請期待!');
    return;
  }

  if (text === '請假' || text === '我要請假') {
    return startLeaveFlow(client, event.replyToken, bindingRef);
  }

  if (flow && flow.type === 'leave') {
    await replyText(
      client, event.replyToken,
      '請依照上方按鈕操作,或輸入「取消」結束目前流程',
      false
    );
    return;
  }

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
