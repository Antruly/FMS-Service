/**
 * 数据库检查脚本 - 使用 sql.js
 * 运行: node check-db.js
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function check() {
    console.log('=== 检查 offline_downloads 表 ===\n');

    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'data', 'fileservice.db');

    if (!fs.existsSync(dbPath)) {
        console.log('数据库文件不存在:', dbPath);
        return;
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    try {
        // 检查表是否存在
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_downloads'");
        console.log('表存在:', tables.length > 0 && tables[0].values.length > 0);

        if (tables.length > 0 && tables[0].values.length > 0) {
            // 获取列信息
            const cols = db.exec('PRAGMA table_info(offline_downloads)');
            console.log('\n列信息:');
            if (cols.length > 0) {
                cols[0].values.forEach(row => {
                    console.log('  ', row);
                });
            }

            // 测试插入
            console.log('\n=== 测试插入 ===');
            db.run(
                "INSERT INTO offline_downloads (user_id, url, filename, mime_type, target_dir_id, status) VALUES (?, ?, ?, ?, ?, ?)",
                [1, 'https://example.com/test.zip', 'test.zip', 'application/zip', 0, 'pending']
            );

            const lastId = db.exec("SELECT last_insert_rowid() as id");
            console.log('最后插入ID:', lastId[0].values[0][0]);

            const inserted = db.exec("SELECT * FROM offline_downloads WHERE id = last_insert_rowid()");
            console.log('查询结果:', inserted);

            // 删除测试数据
            db.run("DELETE FROM offline_downloads WHERE id = last_insert_rowid()");
            console.log('\n测试数据已清理');

            // 同步到文件
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(dbPath, buffer);
            console.log('数据库已保存');
        }
    } catch (e) {
        console.error('错误:', e.message);
    }

    db.close();
}

check().catch(console.error);
