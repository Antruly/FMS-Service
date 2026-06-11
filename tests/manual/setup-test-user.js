/**
 * 重置测试用户密码并设为管理员
 * 运行一次即可
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

(async () => {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'data', 'fileservice.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const targetEmail = process.env.TEST_EMAIL || 'test@example.com';
  const newPassword = process.env.TEST_PASSWORD || 'Test@123456';
  const newHash = bcrypt.hashSync(newPassword, 10);

  // 更新密码和设为管理员
  db.run(`UPDATE users SET password = '${newHash}', is_admin = 1 WHERE email = '${targetEmail}'`);

  // 验证
  const r = db.exec(`SELECT email, is_admin FROM users WHERE email = '${targetEmail}'`);
  if (r.length > 0 && r[0].values.length > 0) {
    console.log(`已更新用户: ${r[0].values[0][0]}`);
    console.log(`管理员状态: ${r[0].values[0][1] === 1 ? '是' : '否'}`);
    console.log(`新密码: ${newPassword}`);
  } else {
    console.log('用户不存在');
  }

  // 保存
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log('数据库已保存');
})();
