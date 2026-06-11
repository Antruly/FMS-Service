// 修复: 设置 active pool 为 savepath5, 匹配文件到 virtual_files
var initSqlJs = require('sql.js');
var fs = require('fs');
var path = require('path');

var buf = fs.readFileSync('data/fileservice.db');
initSqlJs().then(function(SQL) {
  var db = new SQL.Database(buf);

  // 清池，只保留 savepath5
  db.run('DELETE FROM storage_pools');
  db.run("INSERT INTO storage_pools (local_path, group_id, mirror_index, status, sync_status) VALUES ('D:/tools/fileservice/files/savepath5', 0, 0, 'active', 'synced')");
  console.log('Pool: savepath5 (group 0)');

  // 收集所有 virtual_files uuid
  var vfResult = db.exec('SELECT id, storage_path FROM virtual_files');
  var vfMap = {};
  if (vfResult[0]) {
    vfResult[0].values.forEach(function(r) {
      var u = path.basename(r[1] || '');
      while (u.endsWith('.enc')) u = u.substring(0, u.length - 4);
      vfMap[u] = r[0];
    });
  }
  console.log('DB records: ' + Object.keys(vfMap).length);

  // 扫描 savepath5，匹配 uuid → 更新 storage_path
  var updated = 0;
  function scanDir(dir) {
    try {
      fs.readdirSync(dir).forEach(function(e) {
        var fp = path.join(dir, e);
        try {
          if (fs.statSync(fp).isDirectory()) { scanDir(fp); }
          else if (e.endsWith('.enc')) {
            var u = path.basename(e);
            while (u.endsWith('.enc')) u = u.substring(0, u.length - 4);
            if (vfMap[u]) {
              var cleanPath = fp.replace(/\\/g, '/');
              db.run('UPDATE virtual_files SET storage_path = ? WHERE id = ?', [cleanPath, vfMap[u]]);
              delete vfMap[u]; // 已匹配
              updated++;
            }
          }
        } catch(ex) {}
      });
    } catch(ex) {}
  }
  scanDir('D:/tools/fileservice/files/savepath5');
  console.log('Matched and updated: ' + updated);
  console.log('Unmatched (will fail migration): ' + Object.keys(vfMap).length);

  // 重置迁移状态
  db.run('UPDATE virtual_files SET storage_id = 0, migration_status = 0');
  db.run('DELETE FROM file_storage_paths');
  db.run('DELETE FROM file_storage');
  db.run('DELETE FROM user_file_refs');

  var data = db.export();
  fs.writeFileSync('data/fileservice.db', Buffer.from(data));
  console.log('DB saved. Ready to migrate.');
});
