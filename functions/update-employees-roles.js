// update-employees-roles.js
// 一次性更新 22 位員工的 role 和 supervisor
// 用法:在 Cloud Shell 執行 → cd ~/line-bot/functions && node update-employees-roles.js
//
// role 三種:
//   - admin:管理員(梁O邦、曾O宇)
//   - manager:主管(伍、何、張、吳)
//   - employee:一般員工

const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'sharedot-9999'
});

const db = admin.firestore();

// 員工資料 [姓名, 角色, 直屬主管(null 表示最高層)]
const employeeData = [
  // 管理員(2 位,自己請假不用審)
  ['梁O邦', 'admin',    null],
  ['曾O宇', 'admin',    null],

  // 主管(4 位,自己請假給兩位管理員都收到)
  ['伍O弘', 'manager',  null],
  ['何O祖', 'manager',  null],
  ['張O妮', 'manager',  null],
  ['吳O凱', 'manager',  null],

  // 一般員工(16 位)
  ['劉O緯', 'employee', '伍O弘'],
  ['林O皇', 'employee', '伍O弘'],
  ['申O格', 'employee', '伍O弘'],
  ['莊O澄', 'employee', '伍O弘'],
  ['吳O宇', 'employee', '何O祖'],
  ['吳O誼', 'employee', '何O祖'],
  ['黃O磬', 'employee', '梁O邦'],
  ['葉O翔', 'employee', '梁O邦'],
  ['謝O亨', 'employee', '梁O邦'],
  ['黃O中', 'employee', '梁O邦'],
  ['顏O智', 'employee', '曾O宇'],
  ['鄭O翔', 'employee', '曾O宇'],
  ['郭O旭', 'employee', '張O妮'],
  ['洪O瑋', 'employee', '張O妮'],
  ['廖O德', 'employee', '吳O凱'],
  ['詹O丞', 'employee', '吳O凱'],
];

async function run() {
  console.log(`準備更新 ${employeeData.length} 位員工的 role 和 supervisor...`);

  const batch = db.batch();
  for (const [name, role, supervisor] of employeeData) {
    const ref = db.collection('employees').doc(name);
    batch.update(ref, {
      role: role,
      supervisor: supervisor,
    });
  }
  await batch.commit();

  console.log(`✅ 完成!已更新 ${employeeData.length} 位員工`);
  console.log(`   - 管理員: 2 位`);
  console.log(`   - 主管: 4 位`);
  console.log(`   - 一般員工: 16 位`);
  process.exit(0);
}

run().catch(err => {
  console.error('❌ 更新失敗:', err);
  process.exit(1);
});
