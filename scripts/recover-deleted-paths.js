// 恢复被误删的文件路径引用
// 用法: node scripts/recover-deleted-paths.js
var initSqlJs = require('sql.js');
var fs = require('fs');
var path = require('path');

var buf = fs.readFileSync('data/fileservice.db');
initSqlJs().then(function(SQL) {
  var db = new SQL.Database(buf);

  // 1. 找到被标记deleted但物理文件仍存在的路径
  var result = db.exec(
    "SELECT fsp.id, fsp.storage_id, fsp.full_path, fsp.pool_id, sp.group_id " +
    "FROM file_storage_paths fsp LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id " +
    "WHERE fsp.status = 'deleted' LIMIT 200"
  );

  var recoverable = [];
  if (result[0] && result[0].values.length > 0) {
    var cols = result[0].columns;
    function col(r, n) { var i = cols.indexOf(n); return i >= 0 ? r[i] : null; }
    result[0].values.forEach(function(row) {
      var fp = col(row, 'full_path');
      if (fp && fs.existsSync(fp)) {
        recoverable.push({
          id: col(row, 'id'), storage_id: col(row, 'storage_id'),
          full_path: fp, old_pool_id: col(row, 'pool_id'), old_group_id: col(row, 'group_id')
        });
      }
    });
  }
  console.log('可恢复文件: ' + recoverable.length + ' (共扫描 ' + (result[0] ? result[0].values.length : 0) + ' 条deleted记录)');

  if (recoverable.length === 0) {
    console.log('没有可恢复的文件');
    return;
  }

  // 2. 找活跃的主路径作为目标
  var activeResult = db.exec("SELECT id, local_path, group_id FROM storage_pools WHERE status = 'active' AND mirror_index = 0 ORDER BY group_id LIMIT 1");
  if (!activeResult[0] || activeResult[0].values.length === 0) {
    console.log('错误: 没有活跃的均衡组，请先创建一个');
    return;
  }
  var target = activeResult[0].values[0];
  var targetId = target[0], targetPath = target[1];
  console.log('目标池: id=' + targetId + ' path=' + targetPath);

  // 3. 逐文件恢复
  var restored = 0, errors = 0;
  recoverable.forEach(function(r) {
    try {
      // 保持原目录结构
      var relPath = path.relative(targetPath, r.full_path);
      if (relPath.startsWith('..')) {
        // 跨盘，用 basename + 日期目录
        var dateMatch = r.full_path.match(/(\d{4}\/\d{2}\/\d{2}\/)/);
        relPath = dateMatch ? dateMatch[0] + path.basename(r.full_path) : path.basename(r.full_path);
      }
      var destPath = path.join(targetPath, relPath);
      var destDir = path.dirname(destPath);

      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(r.full_path) && r.full_path !== destPath) {
        try { fs.renameSync(r.full_path, destPath); } catch(e) {
          fs.copyFileSync(r.full_path, destPath);
          try { fs.unlinkSync(r.full_path); } catch(e2) {}
        }
      } else if (!fs.existsSync(destPath)) {
        console.log('源和目标都不存在: ' + r.full_path);
        return;
      }

      db.run("UPDATE file_storage_paths SET pool_id = ?, full_path = ?, status = 'active' WHERE id = ?",
        [targetId, destPath.replace(/\\/g, '/'), r.id]);
      restored++;
    } catch(e) {
      errors++;
      console.log('失败: id=' + r.id + ' err=' + e.message);
    }
  });

  console.log('恢复完成: ' + restored + ' 成功, ' + errors + ' 失败');

  var data = db.export();
  fs.writeFileSync('data/fileservice.db', Buffer.from(data));
  console.log('数据库已保存');
});
