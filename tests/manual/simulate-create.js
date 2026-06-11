/**
 * 模拟 OfflineDownload.create 的执行
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function simulate() {
    console.log('=== 模拟 OfflineDownload.create ===\n');

    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'data', 'fileservice.db');

    if (!fs.existsSync(dbPath)) {
        console.log('数据库文件不存在');
        return;
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // 模拟 db.run
    function run(sql, params) {
        console.log('执行 SQL:', sql);
        console.log('参数:', params);
        try {
            db.run(sql, params || []);
            const changes = db.getRowsModified();
            console.log('影响行数:', changes);

            // 获取 last_insert_rowid
            let lastId = 0;
            try {
                const res = db.exec("SELECT last_insert_rowid()");
                console.log('last_insert_rowid 查询结果:', res);
                if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
                    lastId = res[0].values[0][0];
                }
            } catch (e) {
                console.log('获取 last_insert_rowid 失败:', e.message);
            }

            console.log('返回的 lastId:', lastId);
            return { lastInsertRowid: lastId, changes: changes };
        } catch (err) {
            console.error('SQL 执行失败:', err);
            return { lastInsertRowid: 0, changes: 0 };
        }
    }

    // 模拟 get
    function get(sql, params) {
        console.log('查询 SQL:', sql);
        try {
            const stmt = db.prepare(sql);
            if (params) stmt.bind(params);
            const results = [];
            while (stmt.step()) results.push(stmt.getAsObject());
            stmt.free();
            console.log('查询结果:', results);
            return results.length > 0 ? results[0] : null;
        } catch (err) {
            console.error('查询失败:', err);
            return null;
        }
    }

    // 测试
    console.log('\n--- 测试 INSERT ---');
    const result = run(
        'INSERT INTO offline_downloads (user_id, url, filename, mime_type, target_dir_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [1, 'https://example.com/test.zip', 'test.zip', 'application/zip', 0, 'pending']
    );

    console.log('\n--- 测试获取最后插入的行 ---');
    const row = get('SELECT * FROM offline_downloads WHERE id = last_insert_rowid()');

    console.log('\n--- 模拟 OfflineDownload.create 逻辑 ---');
    if (result.changes > 0) {
        console.log('返回行:', row);
    } else {
        console.log('返回: null');
    }

    // 清理测试数据
    if (row) {
        db.run("DELETE FROM offline_downloads WHERE id = ?", [row.id]);
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
        console.log('\n测试数据已清理');
    }

    db.close();
}

simulate().catch(console.error);
