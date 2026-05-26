// import-employees.js
// 一次性匯入 22 位員工到 Firestore (sharedot-9999)
// 用法:在 Cloud Shell 執行 → node import-employees.js

const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'sharedot-9999'
});

const db = admin.firestore();

const employees = [
  '伍O弘',
  '劉O緯',
  '林O皇',
  '申O格',
  '吳O宇',
  '何O祖',
  '黃O磬',
  '梁O邦',
  '吳O誼',
  '葉O翔',
  '謝O亨',
  '顏O智',
  '郭O旭',
  '洪O瑋',
  '鄭O翔',
  '張O妮',
  '莊O澄',
  '黃O中',
  '曾O宇',
  '吳O凱',
  '廖O德',
  '詹O丞'
];

async function run() {
  console.log(`準備匯入 ${employees.length} 位員工...`);

  const batch = db.batch();
  for (const name of employees) {
    const ref = db.collection('employees').doc(name);
    batch.set(ref, {
      name: name,
      lineUserId: null,
      boundAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  await batch.commit();

  console.log(`✅ 完成!已匯入 ${employees.length} 位員工到 employees collection`);
  process.exit(0);
}

run().catch(err => {
  console.error('❌ 匯入失敗:', err);
  process.exit(1);
});
