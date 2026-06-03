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
    { type: 'action', action: { type: 'message', label: '📢 公佈欄', text: '公佈欄' } },
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
          { type: 'button', style: 'primary', color: COLOR.headerReview,
            action: { type: 'message', label: '🏥 體檢', text: '體檢' } },
          { type: 'button', style: 'primary', color: COLOR.headerSelect,
            action: { type: 'message', label: '💪 體能', text: '體能' } },
          { type: 'button', style: 'primary', color: COLOR.headerConfirm,
            action: { type: 'message', label: '🚗 駕照', text: '駕照' } },
          { type: 'button', style: 'primary', color: COLOR.headerMenu,
            action: { type: 'message', label: '📜 證照', text: '證照' } },
          { type: 'button', style: 'secondary',
            action: { type: 'message', label: '📢 公佈欄', text: '公佈欄' } },
          { type: 'button', style: 'secondary',
            action: { type: 'message', label: '📅 本週休假', text: '本週休假' } },
        ],
      },
    },
  };
}

// ===== 卡片:進入 HR 系統 (LIFF) =====
function buildLiffEntryFlex() {
  return {
    type: 'flex',
    altText: '請登入 HR 系統',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: COLOR.headerMenu, paddingAll: '16px',
        contents: [
          { type: 'text', text: '🏢 HR 系統', weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: '請登入 HR 系統', size: 'sm', color: '#FFFFFFCC', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: COLOR.submit,
            action: { type: 'uri', label: '🔑 進入系統', uri: 'https://liff.line.me/2010216136-ErHg7td7' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '📋 返回主選單', text: '選單' } },
        ],
      },
    },
  };
}

// ===== 工具:算還剩幾天(以台北日期計) =====
function daysFromTodayTaipei(dateStr) {
  if (!dateStr) return null;
  // 台北今天的 YYYY-MM-DD
  const todayTw = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const ms = new Date(dateStr).getTime() - new Date(todayTw).getTime();
  return Math.round(ms / 86400000);
}

// ===== 工具:取體能項目陣列(防 undefined) =====
function getFitItems(empData) {
  return [empData.fitItem1, empData.fitItem2, empData.fitItem3].filter(Boolean);
}

// ===== 駕照 icon 對照 =====
const LICENSE_ICONS = {
  '普通小型車': '🚗',
  '普通重型機車': '🏍️',
  '輕型機車': '🛵',
  '大型重型機車': '🏍️',
  '大貨車': '🚛',
  '大客車': '🚌',
  '聯結車': '🚚',
};

// ===== 證照 對照(key → 中文 + icon) =====
const CERT_MAP = {
  emt: { name: 'EMT', icon: '🚑' },
  ccna: { name: 'CCNA/CCNP', icon: '💻' },
  hazmat: { name: 'HazMat', icon: '🧨' },
  swimming: { name: 'Swimming', icon: '🏊' },
  combat: { name: 'Combat Instructor', icon: '🥊' },
  ptcourse: { name: 'PT Course', icon: '🏋️' },
};

// ===== 工具:組駕照顯示字串(含 ⭐🔑 標記) =====
function getLicensesDisplay(empData) {
  const list = empData.licenses || [];
  if (list.length === 0) return [];
  return list.map(l => {
    const ico = LICENSE_ICONS[l] || '';
    let marks = '';
    if (l === '普通小型車') {
      if (empData.lmCarStar) marks += '⭐';
      if (empData.lmCarKey) marks += '🔑';
    }
    if (l === '大貨車') {
      if (empData.lmTruckStar) marks += '⭐';
      if (empData.lmTruckKey) marks += '🔑';
    }
    return `${ico} ${l}${marks}`;
  });
}

// ===== 工具:組證照顯示字串 =====
function getCertsDisplay(empData) {
  const list = empData.certs || [];
  if (list.length === 0) return [];
  return list.map(k => {
    const c = CERT_MAP[k];
    return c ? `${c.icon} ${c.name}` : k;
  });
}

// ===== 工具:剩X天文字 =====
function daysLeftText(dateStr) {
  const d = daysFromTodayTaipei(dateStr);
  if (d === null) return '';
  if (d < 0) return ` (已過期 ${-d} 天)`;
  if (d === 0) return ' (今天)';
  return ` (剩 ${d} 天)`;
}

// ===== 卡片:單人體能(內部用 bubble,carousel 也共用) =====
function buildFitnessBubble(empData, extraButtons = []) {
  const name = empData.name || '—';
  const fitItems = getFitItems(empData);
  const status = empData.fitResult === 'pass' ? '✅ 通過'
    : empData.fitResult === 'fail' ? '❌ 未通過'
    : '⏳ 尚未測驗';

  const rows = [
    { type: 'text', text: `狀態:${status}`, size: 'sm', wrap: true, margin: 'sm' },
  ];
  if (fitItems.length) {
    rows.push({ type: 'text', text: `項目:${fitItems.join('、')}`, size: 'sm', wrap: true, margin: 'sm', color: '#666666' });
  }
  if (empData.fitDate) {
    rows.push({ type: 'text', text: `測驗日:${empData.fitDate}`, size: 'sm', wrap: true, margin: 'sm', color: '#666666' });
  }
  if (empData.fitNext) {
    rows.push({ type: 'text', text: `下次:${empData.fitNext}${daysLeftText(empData.fitNext)}`, size: 'sm', wrap: true, margin: 'sm', color: '#666666' });
  }

  // 加按鈕(可選)
  if (extraButtons.length > 0) {
    rows.push({ type: 'separator', margin: 'lg' });
    extraButtons.forEach(btn => {
      rows.push({ ...btn, margin: 'md' });
    });
  }

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR.headerSelect, paddingAll: '14px',
      contents: [
        { type: 'text', text: '💪 體能測驗', weight: 'bold', size: 'md', color: '#FFFFFF' },
        { type: 'text', text: name, size: 'sm', color: '#FFFFFFCC', margin: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', contents: rows,
    },
  };
}

// ===== 卡片:單人體檢 =====
function buildMedicalBubble(empData, extraButtons = []) {
  const name = empData.name || '—';
  const hasAny = empData.medLevel || empData.medDate || empData.medNext;

  const rows = [];
  if (!hasAny) {
    rows.push({ type: 'text', text: '⏳ 尚未體檢,請聯絡 HR', size: 'sm', wrap: true, margin: 'sm' });
  } else {
    if (empData.medLevel) {
      rows.push({ type: 'text', text: `等級:第 ${empData.medLevel} 級`, size: 'sm', wrap: true, margin: 'sm' });
    }
    if (empData.medDate) {
      rows.push({ type: 'text', text: `體檢日:${empData.medDate}`, size: 'sm', wrap: true, margin: 'sm', color: '#666666' });
    }
    if (empData.medNext) {
      rows.push({ type: 'text', text: `下次:${empData.medNext}${daysLeftText(empData.medNext)}`, size: 'sm', wrap: true, margin: 'sm', color: '#666666' });
    }
  }

  // 加按鈕(可選)
  if (extraButtons.length > 0) {
    rows.push({ type: 'separator', margin: 'lg' });
    extraButtons.forEach(btn => {
      rows.push({ ...btn, margin: 'md' });
    });
  }

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR.headerReview, paddingAll: '14px',
      contents: [
        { type: 'text', text: '🏥 體檢', weight: 'bold', size: 'md', color: '#FFFFFF' },
        { type: 'text', text: name, size: 'sm', color: '#FFFFFFCC', margin: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', contents: rows,
    },
  };
}

// ===== 卡片:單人駕照 =====
function buildLicenseBubble(empData, extraButtons = []) {
  const name = empData.name || '—';
  const items = getLicensesDisplay(empData);

  const rows = [];
  if (items.length === 0) {
    rows.push({ type: 'text', text: '⏳ 尚未登錄駕照', size: 'sm', wrap: true, margin: 'sm' });
  } else {
    items.forEach(line => {
      rows.push({ type: 'text', text: line, size: 'sm', wrap: true, margin: 'sm' });
    });
    // 標記說明(只有 ⭐🔑 時才顯示說明)
    const hasMarks = (empData.lmCarStar || empData.lmCarKey || empData.lmTruckStar || empData.lmTruckKey);
    if (hasMarks) {
      rows.push({ type: 'text', text: '⭐ 主駕  🔑 持有鑰匙', size: 'xs', wrap: true, margin: 'md', color: '#999999' });
    }
  }

  if (extraButtons.length > 0) {
    rows.push({ type: 'separator', margin: 'lg' });
    extraButtons.forEach(btn => rows.push({ ...btn, margin: 'md' }));
  }

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR.headerConfirm, paddingAll: '14px',
      contents: [
        { type: 'text', text: '🚗 駕照', weight: 'bold', size: 'md', color: '#FFFFFF' },
        { type: 'text', text: name, size: 'sm', color: '#FFFFFFCC', margin: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', contents: rows,
    },
  };
}

// ===== 卡片:單人證照 =====
function buildCertBubble(empData, extraButtons = []) {
  const name = empData.name || '—';
  const items = getCertsDisplay(empData);

  const rows = [];
  if (items.length === 0) {
    rows.push({ type: 'text', text: '⏳ 尚未登錄證照', size: 'sm', wrap: true, margin: 'sm' });
  } else {
    items.forEach(line => {
      rows.push({ type: 'text', text: line, size: 'sm', wrap: true, margin: 'sm' });
    });
  }

  if (extraButtons.length > 0) {
    rows.push({ type: 'separator', margin: 'lg' });
    extraButtons.forEach(btn => rows.push({ ...btn, margin: 'md' }));
  }

  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: COLOR.headerMenu, paddingAll: '14px',
      contents: [
        { type: 'text', text: '📜 證照', weight: 'bold', size: 'md', color: '#FFFFFF' },
        { type: 'text', text: name, size: 'sm', color: '#FFFFFFCC', margin: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', contents: rows,
    },
  };
}

// ===== 卡片:看下屬清單按鈕(manager) =====
function buildSubordinatesEntryFlex(kind, role) {
  // kind: 'fit' | 'med', role: 'manager' | 'admin'
  const scope = role === 'admin' ? '全公司' : '下屬';
  const label = kind === 'fit' ? `💪 看${scope}體能名單` : `🏥 看${scope}體檢名單`;
  // text 統一,handleText 用同一個分支處理(差別在 role 而非觸發字串)
  const text = kind === 'fit' ? '下屬體能' : '下屬體檢';
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px',
      contents: [
        { type: 'button', style: 'primary', color: COLOR.headerMenu,
          action: { type: 'message', label, text } },
      ],
    },
  };
}

// ===== 卡片:admin 進 HR 看完整名單 =====
function buildAdminLiffEntryFlex() {
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px',
      contents: [
        { type: 'button', style: 'primary', color: COLOR.headerMenu,
          action: { type: 'uri', label: '📋 進 HR 看完整名單', uri: 'https://liff.line.me/2010216136-ErHg7td7' } },
      ],
    },
  };
}

// ===== 4 種 kind 的對照表 =====
const KIND_META = {
  fit: { altText: '體能測驗', buttonLabel: '體能', trigger: '下屬體能', emoji: '💪' },
  med: { altText: '體檢',     buttonLabel: '體檢', trigger: '下屬體檢', emoji: '🏥' },
  lic: { altText: '駕照',     buttonLabel: '駕照', trigger: '下屬駕照', emoji: '🚗' },
  cer: { altText: '證照',     buttonLabel: '證照', trigger: '下屬證照', emoji: '📜' },
};

// ===== 主入口:組體能/體檢/駕照/證照 回應 messages =====
async function buildFitMedReply(kind, myEmpId, myData) {
  // kind: 'fit' | 'med' | 'lic' | 'cer'
  const role = myData.role || 'employee';
  const meta = KIND_META[kind];

  // 組要塞進 bubble body 的按鈕
  const buttons = [];

  // manager / admin: 查有沒有下屬,決定要不要放「看下屬」按鈕
  if (role === 'manager' || role === 'admin') {
    const subSnap = await db.collection('employees')
      .where('supervisor', '==', myData.name || '')
      .get();
    const hasSubordinates = subSnap.docs.some(d => d.data().status === 'active');
    // admin 即使沒下屬也要顯示「看全公司」按鈕
    if (hasSubordinates || role === 'admin') {
      const scope = role === 'admin' ? '全公司' : '下屬';
      const label = `${meta.emoji} 看${scope}${meta.buttonLabel}名單`;
      buttons.push({
        type: 'button', style: 'primary', height: 'sm', color: COLOR.headerMenu,
        action: { type: 'message', label, text: meta.trigger },
      });
    }
    if (role === 'admin') {
      buttons.push({
        type: 'button', style: 'primary', height: 'sm', color: COLOR.headerSelect,
        action: { type: 'uri', label: '📋 進 HR 看完整名單', uri: 'https://liff.line.me/2010216136-ErHg7td7' },
      });
    }
  }

  // 所有卡片都加「返回主選單」
  buttons.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'message', label: '📋 返回主選單', text: '選單' },
  });

  let myBubble;
  if (kind === 'fit') myBubble = buildFitnessBubble(myData, buttons);
  else if (kind === 'med') myBubble = buildMedicalBubble(myData, buttons);
  else if (kind === 'lic') myBubble = buildLicenseBubble(myData, buttons);
  else if (kind === 'cer') myBubble = buildCertBubble(myData, buttons);

  return [{
    type: 'flex',
    altText: meta.altText,
    contents: myBubble,
  }];
}

// ===== 下屬/全公司名單 純文字(manager/admin 點按鈕後觸發) =====
async function buildSubordinatesText(kind, myData) {
  // kind: 'fit' | 'med', myData: { name, role, ... }
  const role = myData.role || 'employee';
  let snap;
  let scopeLabel;
  if (role === 'admin') {
    // admin 看全公司在職員工
    snap = await db.collection('employees').where('status', '==', 'active').get();
    scopeLabel = '全公司';
  } else {
    // manager 看 supervisor === 自己的人
    snap = await db.collection('employees').where('supervisor', '==', myData.name || '').get();
    scopeLabel = '下屬';
  }

  const list = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.status === 'active')
    // 部門優先,部門內按姓名
    .sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.name || '').localeCompare(b.name || ''));

  if (list.length === 0) return null;

  const title = `${KIND_META[kind].emoji} ${scopeLabel}${KIND_META[kind].buttonLabel}名單`;
  const lines = [title, `共 ${list.length} 人`, '─────────'];

  for (const e of list) {
    const deptTag = e.department ? `[${e.department}] ` : '';
    lines.push(`${deptTag}${e.name || '—'}`);
    if (kind === 'fit') {
      const status = e.fitResult === 'pass' ? '✅ 通過' : e.fitResult === 'fail' ? '❌ 未通過' : '⏳ 尚未測驗';
      lines.push(`  ${status}`);
      const items = getFitItems(e);
      if (items.length) lines.push(`  項目:${items.join('、')}`);
      if (e.fitDate) lines.push(`  測驗日:${e.fitDate}`);
      if (e.fitNext) lines.push(`  下次:${e.fitNext}${daysLeftText(e.fitNext)}`);
    } else if (kind === 'med') {
      if (e.medLevel) lines.push(`  等級:第 ${e.medLevel} 級`);
      else lines.push(`  ⏳ 尚未體檢`);
      if (e.medDate) lines.push(`  體檢日:${e.medDate}`);
      if (e.medNext) lines.push(`  下次:${e.medNext}${daysLeftText(e.medNext)}`);
    } else if (kind === 'lic') {
      const licItems = getLicensesDisplay(e);
      if (licItems.length) {
        licItems.forEach(item => lines.push(`  ${item}`));
      } else {
        lines.push('  ⏳ 尚未登錄駕照');
      }
    } else if (kind === 'cer') {
      const cerItems = getCertsDisplay(e);
      if (cerItems.length) {
        cerItems.forEach(item => lines.push(`  ${item}`));
      } else {
        lines.push('  ⏳ 尚未登錄證照');
      }
    }
    lines.push(''); // 段落空行
  }

  return { type: 'text', text: lines.join('\n').trimEnd() };
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
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '📋 返回主選單', text: '選單' } },
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
      buildLiffEntryFlex(),
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

  // 體能/體檢/駕照/證照 - 自己查詢
  const SELF_KIND_MAP = { '體能': 'fit', '體檢': 'med', '駕照': 'lic', '證照': 'cer' };
  if (SELF_KIND_MAP[text]) {
    const kind = SELF_KIND_MAP[text];
    const myEmpId = binding.empId;
    const me = await getEmployeeById(myEmpId);
    if (!me) {
      await replyText(client, event.replyToken, '找不到您的員工資料,請聯絡 HR');
      return;
    }
    if (me.data.status !== 'active') {
      await replyText(client, event.replyToken, '您目前不是在職狀態,無法查詢');
      return;
    }
    const messages = await buildFitMedReply(kind, myEmpId, me.data);
    await replyMessages(client, event.replyToken, attachMenuQR(messages));
    return;
  }

  // 下屬名單 - manager/admin 用
  const SUB_KIND_MAP = { '下屬體能': 'fit', '下屬體檢': 'med', '下屬駕照': 'lic', '下屬證照': 'cer' };
  if (SUB_KIND_MAP[text]) {
    const kind = SUB_KIND_MAP[text];
    const myEmpId = binding.empId;
    const me = await getEmployeeById(myEmpId);
    if (!me) {
      await replyText(client, event.replyToken, '找不到您的員工資料,請聯絡 HR');
      return;
    }
    if (me.data.role !== 'manager' && me.data.role !== 'admin') {
      await replyText(client, event.replyToken, '此功能僅限主管或管理員使用');
      return;
    }
    const textMsg = await buildSubordinatesText(kind, me.data);
    if (!textMsg) {
      const emptyMsg = me.data.role === 'admin' ? '目前公司沒有在職員工' : '您目前沒有下屬員工';
      await replyText(client, event.replyToken, emptyMsg);
      return;
    }
    await replyMessages(client, event.replyToken, attachMenuQR([textMsg]));
    return;
  }

  // 我的假單 + 本週休假（合併）
  if (['本週休假', '休假', '誰休假', '假單', '我的假單', '假單狀態'].includes(text)) {
    const empId = bindingRef.data().empId;
    const STATUS_ICON = { approved: '✅', pending: '⏳', rejected: '❌', cancelled: '🚫' };
    const STATUS_TEXT = { approved: '已核准', pending: '待審核', rejected: '已駁回', cancelled: '已取消' };
    let msg = '';

    // ── 我的假單 ──
    try {
      const mySnap = await db.collection('leaves')
        .where('empId', '==', empId).get();
      if (!mySnap.empty) {
        const myLeaves = mySnap.docs
          .map(d => d.data())
          .sort((a, b) => {
            const ta = a.createdAt?.toDate?.()?.getTime() || 0;
            const tb = b.createdAt?.toDate?.()?.getTime() || 0;
            return tb - ta;
          })
          .slice(0, 3);
        msg += '📋 我的假單\n' + '─'.repeat(14);
        myLeaves.forEach((l, i) => {
          const typeZh = Object.keys(LEAVE_TYPE_TO_KEY).find(k => LEAVE_TYPE_TO_KEY[k] === l.type) || l.type;
          const t = findLeaveType(typeZh);
          const ico = STATUS_ICON[l.status] || '❓';
          const stxt = STATUS_TEXT[l.status] || l.status;
          const dateRange = l.startDate === l.endDate ? l.startDate : `${l.startDate}~${l.endDate}`;
          msg += `\n${i+1}. ${ico} ${stxt} ${t ? t.emoji : ''}${typeZh} ${dateRange}`;
        });
        msg += '\n\n';
      }
    } catch(e) { console.error('[Bot] myLeaves error:', e.message); }

    // ── 本週休假 ──
    try {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const monday = new Date(now);
      monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const monStr = monday.toISOString().slice(0, 10);
      const sunStr = sunday.toISOString().slice(0, 10);
      const monDisplay = `${monday.getMonth()+1}/${monday.getDate()}`;
      const sunDisplay = `${sunday.getMonth()+1}/${sunday.getDate()}`;

      const snap = await db.collection('leaves').get();
      const leaves = snap.docs
        .map(d => d.data())
        .filter(l => l.startDate <= sunStr && l.endDate >= monStr && l.status !== 'cancelled')
        .sort((a, b) => a.startDate.localeCompare(b.startDate));

      msg += `📅 本週休假（${monDisplay}-${sunDisplay}）\n` + '─'.repeat(14);
      if (leaves.length === 0) {
        msg += '\n🎉 本週無人休假';
      } else {
        leaves.forEach(l => {
          const typeZh = Object.keys(LEAVE_TYPE_TO_KEY).find(k => LEAVE_TYPE_TO_KEY[k] === l.type) || l.type;
          const t = findLeaveType(typeZh);
          const ico = STATUS_ICON[l.status] || '';
          const dateRange = l.startDate === l.endDate
            ? formatDateWithWeekday(l.startDate)
            : `${l.startDate}~${l.endDate}`;
          msg += `\n${ico} ${l.empName || '—'} ${t ? t.emoji : ''}${typeZh} ${dateRange}`;
        });
        msg += `\n\n共 ${leaves.length} 人`;
      }
    } catch(e) {
      msg += `📅 本週休假\n` + '─'.repeat(14) + '\n⚠️ 查詢失敗';
      console.error('[Bot] weekLeaves error:', e.message);
    }

    await replyText(client, event.replyToken, msg.trim());
    return;
  }

  // 公佈欄查詢
  if (['公佈欄', '最新公告', '公告'].includes(text)) {
    const annSnap = await db.collection('announcements')
      .orderBy('createdAt', 'desc').limit(5).get();
    if (annSnap.empty) {
      await replyText(client, event.replyToken, '📢 目前沒有公告');
      return;
    }
    let msg = '📢 最新公告\n' + '─'.repeat(14) + '\n';
    annSnap.docs.forEach((d, i) => {
      const r = d.data();
      const ts = r.createdAt?.toDate?.();
      const dateStr = ts ? `${ts.getMonth()+1}/${ts.getDate()}` : '';
      msg += `\n${i+1}. ${r.title}`;
      if (r.content) msg += `\n   ${r.content.substring(0, 60)}${r.content.length > 60 ? '…' : ''}`;
      if (dateStr) msg += `\n   📅 ${dateStr}`;
      msg += '\n';
    });
    await replyText(client, event.replyToken, msg.trim());
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
    role: empData.role || 'employee',
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
// ════════════════════════════════════════════════════
exports.lineLogin = onCall({ region: 'asia-east1' }, async (request) => {
  const accessToken = (request.data?.accessToken || '').trim();
  if (!accessToken) {
    throw new HttpsError('invalid-argument', '缺少 accessToken');
  }

  // 1. 驗證 access token
  let verifyData;
  try {
    const verifyRes = await fetch(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
    );
    verifyData = await verifyRes.json();
    console.log('LINE verify response:', JSON.stringify(verifyData));
  } catch (err) {
    console.error('LINE verify fetch error:', err);
    throw new HttpsError('internal', 'LINE Verify API 呼叫失敗: ' + err.message);
  }

  if (!verifyData.client_id) {
    throw new HttpsError('unauthenticated', 'token 驗證失敗: ' + JSON.stringify(verifyData));
  }
  if (verifyData.client_id !== '2010216136') {
    throw new HttpsError('unauthenticated', 'client_id 不符: ' + verifyData.client_id);
  }
  if (verifyData.expires_in !== undefined && verifyData.expires_in <= 0) {
    throw new HttpsError('unauthenticated', 'access token 已過期');
  }

  // 2. 拿 lineUserId
  let lineUserId;
  try {
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileData = await profileRes.json();
    console.log('LINE profile response:', JSON.stringify(profileData));
    lineUserId = profileData.userId;
  } catch (err) {
    console.error('LINE profile fetch error:', err);
    throw new HttpsError('internal', 'LINE Profile API 呼叫失敗: ' + err.message);
  }

  if (!lineUserId) {
    throw new HttpsError('unauthenticated', '無法取得 LINE userId');
  }

  // 3. 查 lineBindings
  const bindingSnap = await db.collection('lineBindings').doc(lineUserId).get();
  if (!bindingSnap.exists) {
    throw new HttpsError('not-found', '請先加入 LINE Bot 並完成綁定 (userId: ' + lineUserId + ')');
  }
  const bindingData = bindingSnap.data();
  const empId = bindingData.empId || null;

  // 3b. 同步 employees 的 role 到 lineBindings（讓 Rules 只需讀一層）
  //     employees 仍是事實源，lineBindings.role 只是登入時更新的快取
  if (empId) {
    try {
      const empSnap = await db.collection('employees').doc(empId).get();
      if (empSnap.exists) {
        const role = empSnap.data().role || 'employee';
        const dept = empSnap.data().department || '';
        if (bindingData.role !== role || bindingData.department !== dept) {
          await db.collection('lineBindings').doc(lineUserId).set(
            { role, department: dept },
            { merge: true }
          );
          console.log('synced role to lineBindings:', role);
        }
      }
    } catch (err) {
      console.error('sync role error (non-fatal):', err);
      // 同步失敗不擋登入
    }
  }

  // 4. 產 Firebase custom token
  let customToken;
  try {
    customToken = await admin.auth().createCustomToken(lineUserId);
    console.log('custom token created for:', lineUserId);
  } catch (err) {
    console.error('createCustomToken error:', err);
    throw new HttpsError('internal', 'custom token 建立失敗: ' + err.message);
  }

  // 5. 回傳
  return {
    customToken,
    empId,
    employeeName: bindingData.employeeName || '',
  };
});

// ════════════════════════════════════════════════════
//  dailyFitMedReminder — 前一日推播提醒(體能/體檢)
//
//  觸發: GCP Console 手動建 Cloud Scheduler
//  時區: Asia/Taipei
//  排程: 每日 20:00 (0 20 * * *)
//  HTTP 觸發: POST 此 function URL
//
//  邏輯: 掃 employees,fitNext/medNext === 明天 的人,推 LINE
//  推播失敗: try-catch 包住,只寫 log,不擋整批
// ════════════════════════════════════════════════════
exports.dailyFitMedReminder = onRequest({ region: 'asia-east1' }, async (req, res) => {
  // 算台北明天的 YYYY-MM-DD
  const nowMs = Date.now() + 8 * 3600 * 1000; // UTC + 8
  const tomorrowMs = nowMs + 86400 * 1000;
  const tomorrowStr = new Date(tomorrowMs).toISOString().slice(0, 10);
  const tomorrowWeekday = WEEKDAYS[new Date(tomorrowMs).getUTCDay()];

  console.log(`[dailyFitMedReminder] 開始掃描,明天=${tomorrowStr} ${tomorrowWeekday}`);

  const client = getLineClient();
  const empsSnap = await db.collection('employees').get();

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const doc of empsSnap.docs) {
    const emp = doc.data();
    if (emp.status !== 'active') { skipped++; continue; }
    if (!emp.lineUserId) { skipped++; continue; }

    const hasFit = emp.fitNext === tomorrowStr;
    const hasMed = emp.medNext === tomorrowStr;
    if (!hasFit && !hasMed) { skipped++; continue; }

    // 組訊息
    let msgText;
    if (hasFit && hasMed) {
      const fitItems = getFitItems(emp);
      const itemsLine = fitItems.length ? `\n體能項目:${fitItems.join('、')}` : '';
      msgText = `🏥💪 提醒:您明天(${tomorrowStr} ${tomorrowWeekday})有體能測驗 + 體檢${itemsLine}\n如有調整,請聯絡主管或管理員`;
    } else if (hasFit) {
      const fitItems = getFitItems(emp);
      const itemsLine = fitItems.length ? `\n測驗項目:${fitItems.join('、')}` : '';
      msgText = `💪 提醒:您明天(${tomorrowStr} ${tomorrowWeekday})有體能測驗${itemsLine}\n如有調整,請聯絡主管或管理員`;
    } else {
      msgText = `🏥 提醒:您明天(${tomorrowStr} ${tomorrowWeekday})有體檢\n如有調整,請聯絡主管或管理員`;
    }

    // 推播
    const ok = await pushMessages(client, emp.lineUserId, [{ type: 'text', text: msgText }]);
    if (ok) {
      pushed++;
      results.push({ empId: doc.id, name: emp.name, type: hasFit && hasMed ? 'both' : hasFit ? 'fit' : 'med', success: true });
    } else {
      failed++;
      results.push({ empId: doc.id, name: emp.name, type: hasFit && hasMed ? 'both' : hasFit ? 'fit' : 'med', success: false });
    }
  }

  const summary = { tomorrow: tomorrowStr, pushed, skipped, failed, results };
  console.log('[dailyFitMedReminder] 完成:', JSON.stringify(summary));
  res.json(summary);
});

