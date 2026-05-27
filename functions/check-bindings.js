// check-bindings.js — 純讀取,看 lineBindings 長怎樣
// 用法:
//   1. 放到 ~/line-bot/functions/
//   2. cd ~/line-bot/functions
//   3. node check-bindings.js

const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'sharedot-9999',
});

const db = admin.firestore();

// 把 lineUserId 遮蔽,只露頭尾 4 字
function maskUserId(id) {
  if (!id || id.length < 10) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

async function main() {
  console.log('🔍 撈 sharedot-9999 lineBindings collection...\n');

  const snap = await db.collection('lineBindings').get();
  console.log(`📊 找到 ${snap.docs.length} 筆綁定\n`);

  if (snap.docs.length === 0) {
    console.log('(空的,沒人綁定)');
    process.exit(0);
  }

  console.log('=' .repeat(60));
  for (const doc of snap.docs) {
    const data = doc.data();
    console.log(`\n📌 lineUserId: ${maskUserId(doc.id)}`);
    console.log(`   全部欄位:`);
    for (const [key, value] of Object.entries(data)) {
      let display = value;
      if (value && typeof value.toDate === 'function') {
        display = value.toDate().toISOString();
      } else if (typeof value === 'object' && value !== null) {
        display = JSON.stringify(value);
      }
      console.log(`     ${key}: ${display}`);
    }
  }
  console.log('\n' + '='.repeat(60));

  // 分析:有沒有 empId 欄位?
  const withEmpId = snap.docs.filter(d => d.data().empId).length;
  const withoutEmpId = snap.docs.length - withEmpId;
  console.log(`\n📈 統計:`);
  console.log(`   有 empId 欄位: ${withEmpId} 筆`);
  console.log(`   沒有 empId 欄位: ${withoutEmpId} 筆`);

  if (withoutEmpId > 0) {
    console.log(`\n⚠️  ${withoutEmpId} 筆綁定還在用舊版 (只有 employeeName)`);
    console.log(`   → 3b 刪舊 employees + 3d 部署新版後,這些綁定需要重新綁`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('💥 腳本錯誤:', err);
  process.exit(1);
});
