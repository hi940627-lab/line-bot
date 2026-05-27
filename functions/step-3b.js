// step-3b.js — 刪除舊 employees (姓名當 doc.id) 和舊 lineBindings
//
// 用法:
//   1. Dry-run (預設,只列出要刪什麼,不真刪):
//      node step-3b.js
//
//   2. 真刪 (確認 dry-run 沒問題後才跑):
//      node step-3b.js --really-delete

const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'sharedot-9999',
});

const db = admin.firestore();

// 22 員工姓名 — 只有 doc.id 等於這些才會刪
const EMPLOYEE_NAMES = [
  '伍O弘', '何O祖', '張O妮', '吳O凱', '梁O邦', '曾O宇',
  '劉O緯', '林O皇', '申O格', '莊O澄',
  '吳O宇', '吳O誼',
  '黃O磬', '葉O翔', '謝O亨', '黃O中',
  '顏O智', '鄭O翔',
  '郭O旭', '洪O瑋',
  '廖O德', '詹O丞',
];

const REALLY_DELETE = process.argv.includes('--really-delete');

function maskUserId(id) {
  if (!id || id.length < 10) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

async function main() {
  console.log('='.repeat(60));
  if (REALLY_DELETE) {
    console.log('🔥 真刪模式 — 接下來會實際刪除資料');
  } else {
    console.log('👀 Dry-run 模式 — 只列出,不刪除');
    console.log('   確認沒問題後,加 --really-delete 參數真跑');
  }
  console.log('='.repeat(60));

  // === Step 1: 掃 employees ===
  console.log('\n📂 掃 employees collection...');
  const empSnap = await db.collection('employees').get();
  console.log(`   共 ${empSnap.docs.length} 筆\n`);

  const toDeleteEmp = [];
  const toKeepEmp = [];

  for (const doc of empSnap.docs) {
    if (EMPLOYEE_NAMES.includes(doc.id)) {
      toDeleteEmp.push(doc);
    } else {
      toKeepEmp.push(doc);
    }
  }

  console.log(`🗑️  要刪 (姓名當 doc.id): ${toDeleteEmp.length} 筆`);
  for (const doc of toDeleteEmp) {
    const data = doc.data();
    console.log(`     - doc.id: "${doc.id}" | name: "${data.name || '(無)'}"`);
  }

  console.log(`\n✅ 保留 (亂碼 doc.id): ${toKeepEmp.length} 筆`);
  for (const doc of toKeepEmp) {
    const data = doc.data();
    console.log(`     - doc.id: ${doc.id} | name: "${data.name || '(無)'}" | role: ${data.role || '-'}`);
  }

  // === Step 2: 掃 lineBindings ===
  console.log('\n📂 掃 lineBindings collection...');
  const bindSnap = await db.collection('lineBindings').get();
  console.log(`   共 ${bindSnap.docs.length} 筆\n`);

  console.log(`🗑️  要刪 (全部): ${bindSnap.docs.length} 筆`);
  for (const doc of bindSnap.docs) {
    const data = doc.data();
    console.log(`     - lineUserId: ${maskUserId(doc.id)} | name: "${data.employeeName || '(無)'}"`);
  }

  // === Step 3: 數量檢查 ===
  console.log('\n' + '='.repeat(60));
  console.log('📊 預期 vs 實際:');
  console.log(`   employees 要刪: 預期 22, 實際 ${toDeleteEmp.length} ${toDeleteEmp.length === 22 ? '✅' : '⚠️'}`);
  console.log(`   employees 保留: 預期 22, 實際 ${toKeepEmp.length} ${toKeepEmp.length === 22 ? '✅' : '⚠️'}`);
  console.log(`   lineBindings 要刪: 預期 1, 實際 ${bindSnap.docs.length} ${bindSnap.docs.length === 1 ? '✅' : '⚠️'}`);
  console.log('='.repeat(60));

  if (toDeleteEmp.length !== 22 || toKeepEmp.length !== 22) {
    console.log('\n⚠️  數量不符預期!請先確認狀況再決定要不要繼續');
  }

  // === Step 4: 真刪 ===
  if (!REALLY_DELETE) {
    console.log('\n👉 看起來對的話,加 --really-delete 參數真跑:');
    console.log('   node step-3b.js --really-delete');
    process.exit(0);
  }

  console.log('\n🔥 開始真刪...');

  // 用 batch 一次寫,失敗整個 rollback
  const batch = db.batch();
  for (const doc of toDeleteEmp) {
    batch.delete(doc.ref);
  }
  for (const doc of bindSnap.docs) {
    batch.delete(doc.ref);
  }

  await batch.commit();
  console.log(`✅ 已刪除 ${toDeleteEmp.length} 筆 employees + ${bindSnap.docs.length} 筆 lineBindings`);

  // === Step 5: 驗證 ===
  console.log('\n🔍 驗證刪除結果...');
  const empAfter = await db.collection('employees').get();
  const bindAfter = await db.collection('lineBindings').get();

  const remainingOld = empAfter.docs.filter(d => EMPLOYEE_NAMES.includes(d.id));
  console.log(`   employees 剩 ${empAfter.docs.length} 筆 (其中舊版 ${remainingOld.length} 筆)`);
  console.log(`   lineBindings 剩 ${bindAfter.docs.length} 筆`);

  if (remainingOld.length === 0 && bindAfter.docs.length === 0) {
    console.log('\n🎉 3b 完成,可以進 3d');
  } else {
    console.log('\n⚠️  還有殘留,請確認');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('💥 腳本錯誤:', err);
  process.exit(1);
});
