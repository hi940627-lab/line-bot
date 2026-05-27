const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
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

// ===== 假別清單 (中文顯示用) =====
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

// ===== 假別中→英對照 (寫入 leaves 用) =====
const LEAVE_TYPE_TO_KEY = {
  '事假':   'personal',
  '病假':   'sick',
  '特休':   'annual',
  '婚假':   'marriage',
  '喪假':   'bereavement',
  '陪產假': 'paternity',
  '產假':   'maternity',
};

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

// ===== 用姓名查員工 (回傳 { id, data } 或 null) =====
async function findEmployeeByName(employeeName) {
  const snap = await db.collection('employees').where('name', '==', employeeName).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() };
}

// ===== 用 empId 查員工 =====
async function getEmployeeById(empId) {
  const snap = await db.collection('employees').doc(empId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() };
}

// ===== 算審核人 (回傳 empId 陣列) =====
async function getApprovers(employeeData, employeeEmpId) {
  if (employeeData.role === 'admin') return [];
  if (employeeData.role === 'manager') {
    const adminsSnap = await db.collection('employees').where('role', '==', 'admin').get();
    // 排除自己(保險:不能自己審自己)
    return adminsSnap.docs.map(d => d.id).filter(id => id !== employeeEmpId);
  }
  // 一般員工:supervisor 是姓名,要查出對應的 empId
  if (employeeData.supervisor) {
    const sup = await findEmployeeByName(employeeData.supervisor);
    if (sup && sup.id !== employeeEmpId) return [sup.id];
  }
  return [];
}

// ===== 用 empId 取得綁定的 lineUserId =====
async function getLineUserIdByEmpId(empId) {
  const emp = await getEmployeeById(empId);
  if (!emp) return null;
  return emp.data.lineUserId || null;
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
  const t = findLeaveType(requestData.typeZh);
  return {
    type: 'flex',
    altText: `新假單待審核:${requestData.empName} - ${requestData.typeZh} ${requestData.days}天`,
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
            { type: 'text', text: requestData.empName, size: 'md', weight: 'bold' },
          ]},
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            { type: 'text', text: '📅 假別', size: 'xs', color: '#888888' },
            { type: 'text', text: `${t.emoji} ${requestData.typeZh}`, size: 'md', weight: 'bold' },
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

// ===== 卡片:員工收到的審核結果 (不顯示審核人) =====
function buildResultFlex(requestData, approved) {
  const t = findLeaveType(requestData.typeZh);
  const statusEmoji = approved ? '✅' : '❌';
  const statusText = approved ? '已核准' : '已駁回';
  const headerColor = approved ? COLOR.submit : COLOR.reject;
  const altPrefix = approved ? '✅' : '❌';

  return {
    type: 'flex',
    altText: `${altPrefix} 您的${requestData.typeZh}${statusText}(${requestData.startDate}~${requestData.endDate})`,
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
            { type: 'text', text: `${t.emoji} ${requestData.typeZh}`, size: 'md', weight: 'bold' },
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

// ===== 寫 auditLog (跟網頁同 schema) =====
async function writeAuditLog(action, target, targetName, operator, role) {
  try {
    await db.collection('auditLogs').add({
      action,             // approve / reject
      target,             // leaves
      targetName: targetName || '',
      operator: operator || '',
      operatorEmail: '',  // LINE Bot 沒 email
      role: role || 'unknown',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('auditLog write fail:', e.message);
  }
}

// ===== 通知審核人 =====
async function notifyApprovers(client, requestId, requestData, approverEmpIds) {
  const failed = [];
  let sentCount = 0;

  for (const approverEmpId of approverEmpIds) {
    const lineUserId = await getLineUserIdByEmpId(approverEmpId);
    if (!lineUserId) {
      failed.push(approverEmpId);
      continue;
    }
    const ok = await pushMessages(client, lineUserId, [
      buildReviewFlex(requestId, requestData),
    ]);
    if (ok) sentCount++;
    else failed.push(approverEmpId);
  }

  return { sentCount, failed };
}

// ===== 送出假單 =====
async function submitLeave(client, replyToken, bindingRef, binding, data) {
  const empId = binding.empId;
  const empName = binding.employeeName;

  const emp = await getEmployeeById(empId);
  if (!emp) {
    await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });
    await replyText(client, replyToken, '❌ 找不到您的員工資料,請聯絡 HR');
    return;
  }
  const empData = emp.data;
  const approvers = await getApprovers(empData, empId);
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
    for (const apEmpId of approvers) {
      const apEmp = await getEmployeeById(apEmpId);
      if (!apEmp || !apEmp.data.lineUserId) {
        unboundNames.push(apEmp ? apEmp.data.name : apEmpId);
      }
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

  // 寫入假單 (leaves collection, 對齊 HR 網頁 schema)
  const status = isAdmin ? 'approved' : 'pending';
  const typeKey = LEAVE_TYPE_TO_KEY[data.type] || data.type;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const leaveDoc = {
    empId,
    empName,
    type: typeKey,                // 英文 key,對齊網頁
    startDate: data.startDate,
    endDate: data.endDate,
    days: String(data.days),      // 網頁存字串("3 天"或"3"),保險用字串
    reason: '',                   // LINE Bot 沒事由
    status,
    approvers,                    // empId 陣列,網頁忽略,LINE Bot 內部用
    createdAt: now,
  };
  if (isAdmin) leaveDoc.updatedAt = now;

  const newDocRef = await db.collection('leaves').add(leaveDoc);

  await bindingRef.update({ currentFlow: admin.firestore.FieldValue.delete() });

  if (isAdmin) {
    // admin 自動核准,寫 auditLog
    await writeAuditLog('approve', 'leaves', empName, empName, 'admin');
    await replyText(client, replyToken, '假單已自動核准 ✅(管理員不需審核)');
    return;
  }

  // 推播給審核人
  const requestData = {
    empId,
    empName,
    typeZh: data.type,            // 中文(卡片顯示用)
    startDate: data.startDate,
    endDate: data.endDate,
    days: data.days,
  };
  const { sentCount } = await notifyApprovers(client, newDocRef.id, requestData, approvers);

  // 把 approver empId 轉成姓名顯示給員工
  const approverNames = [];
  for (const apEmpId of approvers) {
    const apEmp = await getEmployeeById(apEmpId);
    if (apEmp) approverNames.push(apEmp.data.name);
  }
  const approverText = approverNames.length === 1
    ? approverNames[0]
    : `${approverNames.join('、')}(誰先審核以誰為準)`;

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
  const binding = bindingSnap.data();
  const reviewerEmpId = binding.empId;
  const reviewerName = binding.employeeName;

  const requestRef = db.collection('leaves').doc(requestId);
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

      // approvers 是 empId 陣列
      if (!data.approvers || !data.approvers.includes(reviewerEmpId)) {
        return { ok: false, reason: 'notApprover', data };
      }

      // 不能自己審自己(保險)
      if (data.empId === reviewerEmpId) {
        return { ok: false, reason: 'selfReview', data };
      }

      tx.update(requestRef, {
        status: newStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, data };
    });

    if (!result.ok) {
      if (result.reason === 'notfound') {
        await replyText(client, event.replyToken, '⚠️ 找不到該假單');
      } else if (result.reason === 'alreadyDecided') {
        const statusText = result.data.status === 'approved' ? '已被核准' : '已被駁回';
        await replyText(client, event.replyToken, `⚠️ 此假單${statusText}`);
      } else if (result.reason === 'notApprover') {
        await replyText(client, event.replyToken, '⚠️ 您不是此假單的審核人');
      } else if (result.reason === 'selfReview') {
        await replyText(client, event.replyToken, '⚠️ 不能審核自己的假單');
      }
      return;
    }

    // 把 type 轉回中文顯示
    const typeZh = Object.keys(LEAVE_TYPE_TO_KEY).find(k => LEAVE_TYPE_TO_KEY[k] === result.data.type) || result.data.type;
    const t = findLeaveType(typeZh);
    const actionText = action === 'approve' ? '已核准 ✅' : '已駁回 ❌';

    // 寫 auditLog
    const reviewerEmp = await getEmployeeById(reviewerEmpId);
    const reviewerRole = reviewerEmp?.data?.role || 'manager';
    await writeAuditLog(action, 'leaves', result.data.empName, reviewerName, reviewerRole);

    // 回覆審核者
    await replyText(
      client, event.replyToken,
      `${actionText}\n\n申請人:${result.data.empName}\n假別:${t.emoji} ${typeZh}\n日期:${formatDateWithWeekday(result.data.startDate)} ~ ${formatDateWithWeekday(result.data.endDate)}`
    );

    // Push 通知員工結果 (不顯示審核人)
    const employeeLineId = await getLineUserIdByEmpId(result.data.empId);
    if (employeeLineId) {
      const resultData = {
        typeZh,
        startDate: result.data.startDate,
        endDate: result.data.endDate,
        days: result.data.days,
      };
      await pushMessages(client, employeeLineId, [
        buildResultFlex(resultData, action === 'approve'),
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
    return submitLeave(client, event.replyToken, bindingRef, binding, flow.data);
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
    // 用姓名 query employees,找新版亂碼 doc.id
    const emp = await findEmployeeByName(text);
    if (!emp) {
      await replyText(client, event.replyToken, '查無此員工 ❌\n請確認姓名是否正確(範例:王O明)', false);
      return;
    }
    if (emp.data.lineUserId) {
      await replyText(client, event.replyToken, '此員工姓名已被綁定 ⚠️\n如有問題請聯絡 HR', false);
      return;
    }

    // 雙向寫入:employees 加 lineUserId, lineBindings 加 empId
    const now = admin.firestore.FieldValue.serverTimestamp();
    const empRef = db.collection('employees').doc(emp.id);
    const batch = db.batch();
    batch.update(empRef, { lineUserId: userId, boundAt: now });
    batch.set(bindingRef, {
      employeeName: text,
      empId: emp.id,
      boundAt: now,
    });
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

// ════════════════════════════════════════════════════
//  registerUser — 員工自助綁定 (HR 網頁呼叫)
//
//  輸入: { employeeName: "梁O邦" }
//  email: 從 context.auth.token.email 拿,不接受前端傳
//
//  驗證:
//   1. 必須已 Google 登入
//   2. users/{email} 不能已存在
//   3. employees 找得到此姓名
//   4. lineBindings 找得到此姓名 (LINE 守門)
//   5. 該 lineBinding 沒被別的 email 綁走
//
//  通過後:
//   - 建 users/{email} = { empId, name, dept, createdAt }
//   - lineBindings.email 回寫
// ════════════════════════════════════════════════════
exports.registerUser = onCall({ region: 'asia-east1' }, async (request) => {
  // 1. 必須登入
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '請先登入');
  }
  const email = request.auth.token.email;
  if (!email) {
    throw new HttpsError('unauthenticated', '無法取得您的 email');
  }

  // 2. 拿輸入的姓名
  const employeeName = (request.data?.employeeName || '').trim();
  if (!employeeName) {
    throw new HttpsError('invalid-argument', '請輸入姓名');
  }

  // 3. users/{email} 不能已存在
  const userRef = db.collection('users').doc(email);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    throw new HttpsError('already-exists', '此帳號已經綁定過了');
  }

  // 4. 找 employees
  const empSnap = await db.collection('employees').where('name', '==', employeeName).limit(1).get();
  if (empSnap.empty) {
    throw new HttpsError('not-found', '查無此員工,請確認姓名是否正確');
  }
  const empDoc = empSnap.docs[0];
  const empData = empDoc.data();

  // 5. 找 lineBindings (LINE 守門)
  const bindSnap = await db.collection('lineBindings')
    .where('employeeName', '==', employeeName)
    .limit(1)
    .get();
  if (bindSnap.empty) {
    throw new HttpsError('failed-precondition', '請先在 LINE Bot 完成綁定後再回來');
  }
  const bindDoc = bindSnap.docs[0];
  const bindData = bindDoc.data();

  // 6. 該 lineBinding 沒被別的 email 領走
  if (bindData.email && bindData.email !== email) {
    throw new HttpsError('permission-denied', '此姓名已被其他帳號綁定,如有問題請聯絡 HR');
  }

  // 7. 通過 → batch 寫入
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(userRef, {
    empId: empDoc.id,
    name: empData.name,
    dept: empData.department || '',
    createdAt: now,
  });
  batch.update(bindDoc.ref, { email });
  await batch.commit();

  return {
    ok: true,
    empId: empDoc.id,
    name: empData.name,
    dept: empData.department || '',
  };
  });
  // ════════════════════════════════════════════════════
//  lineLogin — LIFF 登入 (HR 網頁呼叫)
//
//  輸入: { accessToken: "LIFF access token" }
//
//  流程:
//   1. 用 accessToken 打 LINE Verify API → 拿 lineUserId
//   2. 查 lineBindings/{lineUserId} 存在嗎? (LINE Bot 守門)
//   3. 產 Firebase custom token (uid = lineUserId)
//   4. 回 { customToken, empId, employeeName }
// ════════════════════════════════════════════════════
exports.lineLogin = onCall({ region: 'asia-east1' }, async (request) => {
  const accessToken = (request.data?.accessToken || '').trim();
  if (!accessToken) {
    throw new HttpsError('invalid-argument', '缺少 accessToken');
  }

  // 1. 驗證 access token → 拿 lineUserId
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
  if (!channelSecret) {
    throw new HttpsError('internal', 'LINE_LOGIN_CHANNEL_SECRET 未設定');
  }

  let lineUserId;
  try {
    const verifyRes = await fetch(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
    );
    const verifyData = await verifyRes.json();

    // client_id 要跟你的 LINE Login Channel ID 一致
    if (verifyData.client_id !== '2010216136') {
      throw new HttpsError('unauthenticated', 'access token 來源不符');
    }
    if (verifyData.expires_in <= 0) {
      throw new HttpsError('unauthenticated', 'access token 已過期');
    }

    // 用 token 拿 profile
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileData = await profileRes.json();
    lineUserId = profileData.userId;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', 'LINE API 呼叫失敗');
  }

  if (!lineUserId) {
    throw new HttpsError('unauthenticated', '無法取得 LINE userId');
  }

  // 2. 查 lineBindings — LINE Bot 守門
  const bindingSnap = await db.collection('lineBindings').doc(lineUserId).get();
  if (!bindingSnap.exists) {
    throw new HttpsError('not-found', '請先加入 LINE Bot 並完成綁定');
  }
  const bindingData = bindingSnap.data();
  const empId = bindingData.empId || null;

  // 3. 產 Firebase custom token
  const customToken = await admin.auth().createCustomToken(lineUserId);

  // 4. 回傳
  return {
    customToken,
    empId,
    employeeName: bindingData.employeeName || bindingData.name || '',
  };
});
