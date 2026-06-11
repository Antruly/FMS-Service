// 直接查询 deleted_public_files 的 file_path 值
const path = require('path');
const fs = require('fs');

// 直接用 better-sqlite3
const sqlite3 = require('better-sqlite3');
const dbPath = path.join(__dirname, 'backend', 'fileservice.db');
console.log('DB path:', dbPath);
console.log('Exists:', fs.existsSync(dbPath));

const db = sqlite3(dbPath);

const rows = db.prepare('SELECT * FROM deleted_public_files').all();
for (const r of rows) {
    console.log('\n--- id=' + r.id + ' ---');
    console.log('  name:', r.name);
    console.log('  file_path:', JSON.stringify(r.file_path));
    console.log('  storage_path:', JSON.stringify(r.storage_path));

    // 可能的路径
    const publicDir = path.join(__dirname, 'files', 'download');
    const candidates = [
        { label: 'raw file_path', p: r.file_path },
        { label: 'raw storage_path', p: r.storage_path },
        { label: 'join(file_path)', p: r.file_path ? path.join(publicDir, r.file_path) : null },
        { label: 'join(storage_path)', p: r.storage_path ? path.join(publicDir, r.storage_path) : null },
    ];
    for (const c of candidates) {
        if (!c.p) continue;
        const exists = fs.existsSync(c.p);
        console.log(`  ${exists ? 'EXISTS' : 'NOT FOUND'}: ${c.label} -> ${c.p}`);
    }
}

db.close();
