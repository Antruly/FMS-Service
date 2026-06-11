const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = path.resolve(__dirname, 'data/fileservice.db');
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Hash the password "Test@1234" (valid: lowercase, uppercase, digit, special)
  const hash = bcrypt.hashSync('Test@1234', 10);

  // Update user password
  var email = process.env.TEST_EMAIL || 'test@example.com';
  db.run("UPDATE users SET password = ? WHERE email = '" + email + "'", [hash]);

  // Save
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));

  console.log('Password updated. Hash:', hash);
  db.close();
}

main().catch(console.error);