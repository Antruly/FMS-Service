// 彻底重建: 以 userdata 物理文件为准, 匹配到 virtual_files
var initSqlJs = require('sql.js');
var fs = require('fs');
var path = require('path');

var buf = fs.readFileSync('data/fileservice.db');
initSqlJs().then(function(SQL) {
  var db = new SQL.Database(buf);

  // 清池，userdata 作为 group 0
  db.run('DELETE FROM storage_pools');
  db.run("INSERT INTO storage_pools (local_path, group_id, mirror_index, status, sync_status) VALUES ('D:/tools/fileservice/files/userdata', 0, 0, 'active', 'synced')");
  console.log('Pool: userdata (group 0)');

  // 收集 userdata 下所有 .enc 文件
  var diskFiles = [];
  function scan(dir) {
    try {
      fs.readdirSync(dir).forEach(function(e) {
        var fp = path.join(dir, e);
        try {
          if (fs.statSync(fp).isDirectory()) { scan(fp); }
          else if (e.endsWith('.enc')) { diskFiles.push(fp); }
        } catch(ex) {}
      });
    } catch(ex) {}
  }
  scan('D:/tools/fileservice/files/userdata');
  console.log('Disk .enc files: ' + diskFiles.length);

  // 重置所有 virtual_files
  db.run('UPDATE virtual_files SET storage_id = 0, migration_status = 0');
  db.run('DELETE FROM file_storage_paths');
  db.run('DELETE FROM file_storage');
  db.run('DELETE FROM user_file_refs');

  // 获取 virtual_files 列表
  var vfRows = db.exec('SELECT id, user_id FROM virtual_files ORDER BY id');
  var vfList = [];
  if (vfRows[0]) vfRows[0].values.forEach(function(r) { vfList.push({id: r[0], userId: r[1]}); });
  console.log('virtual_files: ' + vfList.length);

  // 直接用 userdata 下的真实文件 path 更新 virtual_files
  // 按 user_id 分组匹配
  var byUser = {};
  diskFiles.forEach(function(fp) {
    var dir = path.dirname(fp);
    var userId = parseInt(path.basename(dir));
    if (userId > 0) {
      if (!byUser[userId]) byUser[userId] = [];
      byUser[userId].push(fp);
    }
  });
  console.log('Files by user:');
  Object.keys(byUser).forEach(function(uid) { console.log('  user ' + uid + ': ' + byUser[uid].length + ' files'); });

  // 分配：每个 user 的 virtual_files 按顺序对应其磁盘文件
  var updated = 0;
  Object.keys(byUser).forEach(function(uid) {
    var userId = parseInt(uid);
    var userFiles = byUser[userId];
    var userVFs = vfList.filter(function(v) { return v.userId === userId; });
    console.log('User ' + userId + ': disk=' + userFiles.length + ' db=' + userVFs.length);
    for (var i = 0; i < Math.min(userFiles.length, userVFs.length); i++) {
      var cleanPath = userFiles[i].replace(/\\/g, '/');
      db.run('UPDATE virtual_files SET storage_path = ? WHERE id = ?', [cleanPath, userVFs[i].id]);
      updated++;
    }
  });
  console.log('Updated: ' + updated + ' paths');

  // 验证
  var exist = 0, missing = 0;
  var verify = db.exec('SELECT storage_path FROM virtual_files');
  if (verify[0]) verify[0].values.forEach(function(r) {
    if (fs.existsSync(r[0])) exist++; else missing++;
  });
  console.log('After rebuild: exist=' + exist + ' missing=' + missing);

  var data = db.export();
  fs.writeFileSync('data/fileservice.db', Buffer.from(data));
  console.log('DB saved.');
});
