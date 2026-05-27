// check-3a.js — 純讀取，驗證 3a 完成狀態
// 用法:
//   1. 把這支檔案放到 ~/line-bot/functions/
//   2. cd ~/line-bot/functions
//   3. node check-3a.js

const admin = require('firebase-admin');

// 用 Cloud Shell 的 application default credentials,不需要 key 檔
admin.initializeApp({
  projectId: 'sharedot-9999',
});

const db = admin.firestore();

// 期望的 22 員工資料 (姓名 -> { role, supervisor })
// role 是 null 表示「不該有 role 欄位」
const EXPECTED = {
  '伍O弘': { role: 'manager', supervisor: '' },
  '何O祖': { role: 'manager', supervisor: '' },
  '張O妮': { role: 'manager', supervisor: '' },
  '吳O凱': { role: 'manager', supervisor: '' },
  '梁O邦': { role: 'admin', supervisor: '' },
  '曾O宇': { role: 'admin', supervisor: '' },
  '劉O緯': { role: null, supervisor: '伍O弘' },
  '林O皇': { role: null, supervisor: '伍O弘' },
  '申O格': { role: null, supervisor: '伍O弘' },
  '莊O澄': { role: null, supervisor: '伍O弘' },
  '吳O宇': { role: null, supervisor: '何O祖' },
  '吳O誼': { role: null, supervisor: '何O祖' },
  '黃O磬': { role: null, supervisor: '梁O邦' },
  '葉O翔': { role: null, supervisor: '梁O邦' },
  '謝O亨': { role: null, supervisor: '梁O邦' },
  '黃O中': { role: null, supervisor: '梁O邦' },
  '顏O智': { role: null, supervisor: '曾O宇' },
  '鄭O翔': { role: null, supervisor: '曾O宇' },
  '郭O旭': { role: null, supervisor: '張O妮' },
  '洪O瑋': { role: null, supervisor: '張O妮' },
  '廖O德': { role: null, supervisor: '吳O凱' },
  '詹O丞': { role: null, supervisor: '吳O凱' },
};

async function main() {
  console.log('🔍 開始檢查 sharedot-9999 的 employees collection...\n');

  const snap = await db.collection('employees').get();
  const docs = snap.docs;

  console.log(`📊 Firestore 找到 ${docs.length} 筆 employees 文件\n`);

  // 把所有 doc 按 name 分組
  const byName = {};
  const noNameDocs = [];
  for (const d of docs) {
    const data = d.data();
    const name = data.name;
    if (!name) {
      noNameDocs.push({ id: d.id, data });
      continue;
    }
    if (!byName[name]) byName[name] = [];
    byName[name].push({ id: d.id, data });
  }

  const problems = [];
  const okList = [];

  // === Check 1: 22 位姓名都在 ===
  console.log('=== Check 1: 22 位姓名是否齊全 ===');
  const expectedNames = Object.keys(EXPECTED);
  const missing = expectedNames.filter(n => !byName[n]);
  if (missing.length > 0) {
    problems.push(`❌ 缺少員工: ${missing.join(', ')}`);
    console.log(`❌ 缺少 ${missing.length} 位: ${missing.join(', ')}`);
  } else {
    console.log(`✅ 22 位姓名都在`);
  }

  // === Check 2: 同名重複? ===
  console.log('\n=== Check 2: 是否有同名重複 ===');
  const dupes = expectedNames.filter(n => byName[n] && byName[n].length > 1);
  if (dupes.length > 0) {
    for (const n of dupes) {
      problems.push(`❌ ${n} 有 ${byName[n].length} 筆重複 (doc.id: ${byName[n].map(x => x.id).join(', ')})`);
      console.log(`❌ ${n} 重複 ${byName[n].length} 次`);
    }
  } else {
    console.log(`✅ 沒有同名重複`);
  }

  // === Check 3: 舊的 LINE Bot employees (姓名當 doc.id) ===
  console.log('\n=== Check 3: 是否還有舊版 employees (姓名當 doc.id) ===');
  const oldStyle = docs.filter(d => expectedNames.includes(d.id));
  if (oldStyle.length > 0) {
    console.log(`⚠️  發現 ${oldStyle.length} 筆舊版 (姓名當 doc.id): ${oldStyle.map(d => d.id).join(', ')}`);
    console.log(`   → 這是預期的,3b 會刪掉`);
  } else {
    console.log(`✅ 沒有舊版 employees (或已被刪)`);
  }

  // === Check 4: 逐筆檢查 role 和 supervisor ===
  console.log('\n=== Check 4: 逐筆檢查 role 和 supervisor ===');
  for (const name of expectedNames) {
    if (!byName[name]) continue; // 已在 Check 1 報過

    // 跳過舊版 (姓名當 doc.id) 的那筆,只看新版亂碼 id
    const newDocs = byName[name].filter(d => d.id !== name);
    if (newDocs.length === 0) {
      problems.push(`❌ ${name}: 只有舊版 (姓名當 doc.id),沒有新版`);
      continue;
    }
    if (newDocs.length > 1) {
      problems.push(`❌ ${name}: 有 ${newDocs.length} 筆新版,doc.id: ${newDocs.map(d => d.id).join(', ')}`);
      continue;
    }

    const doc = newDocs[0];
    const expected = EXPECTED[name];
    const actual = doc.data;
    const issues = [];

    // 檢查 role
    if (expected.role === null) {
      // 不該有 role,或是空字串
      if (actual.role && actual.role !== '') {
        issues.push(`role 不該有值,實際是 "${actual.role}"`);
      }
    } else {
      if (actual.role !== expected.role) {
        issues.push(`role 應該是 "${expected.role}",實際是 "${actual.role || '(無)'}"`);
      }
    }

    // 檢查 supervisor
    const actualSup = actual.supervisor || '';
    if (actualSup !== expected.supervisor) {
      issues.push(`supervisor 應該是 "${expected.supervisor || '(空)'}",實際是 "${actualSup || '(空)'}"`);
    }

    if (issues.length > 0) {
      problems.push(`❌ ${name} (doc.id: ${doc.id}): ${issues.join('; ')}`);
    } else {
      okList.push(`✅ ${name} (role: ${actual.role || '-'}, supervisor: ${actualSup || '-'})`);
    }
  }

  // === Check 5: 多餘的員工 (不在 22 名單裡的) ===
  console.log('\n=== Check 5: 是否有多餘員工 (不在 22 名單) ===');
  const extraNames = Object.keys(byName).filter(n => !expectedNames.includes(n));
  if (extraNames.length > 0) {
    console.log(`⚠️  發現 ${extraNames.length} 位不在 22 名單: ${extraNames.join(', ')}`);
    console.log(`   → 可能是測試資料或打錯名字,請確認`);
  } else {
    console.log(`✅ 沒有多餘員工`);
  }

  // === 總結 ===
  console.log('\n' + '='.repeat(50));
  console.log('📋 詳細結果:');
  console.log('='.repeat(50));
  for (const line of okList) console.log(line);
  if (problems.length > 0) {
    console.log('\n⚠️  問題清單:');
    for (const p of problems) console.log(p);
  }

  console.log('\n' + '='.repeat(50));
  if (problems.length === 0) {
    console.log('🎉 全部 OK,可以進 3b');
  } else {
    console.log(`⚠️  共 ${problems.length} 個問題,請先修正再進 3b`);
  }
  console.log('='.repeat(50));

  process.exit(0);
}

main().catch(err => {
  console.error('💥 腳本錯誤:', err);
  process.exit(1);
});
