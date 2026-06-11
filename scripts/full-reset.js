// Complete reset: restore files to original locations, clear V3 tables
var initSqlJs = require('sql.js');
var fs = require('fs');
var path = require('path');

var buf = fs.readFileSync('data/fileservice.db');
initSqlJs().then(function(SQL) {
  var db = new SQL.Database(buf);

  // Move pool files back to userdata originals
  var files = db.exec('SELECT id, user_id, storage_path FROM virtual_files');
  var poolPath = 'D:/tools/fileservice/files/userdata';
  var moved = 0;

  if (files[0]) {
    files[0].values.forEach(function(r) {
      var id = r[0], userId = r[1], sp = r[2] || '';
      var base = path.basename(sp);
      while (base.endsWith('.enc')) base = base.substring(0, base.length - 4);
      var origPath = poolPath + '/' + userId + '/' + base + '.enc';

      // Find file in pool dirs and move back
      function findIn(dir, depth) {
        if (depth > 3) return;
        try {
          fs.readdirSync(dir).forEach(function(e) {
            var fp = path.join(dir, e);
            try {
              var st = fs.statSync(fp);
              if (st.isDirectory()) { findIn(fp, depth + 1); }
              else if (fp !== origPath && path.basename(fp) === base + '.enc') {
                var d = path.dirname(origPath);
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                try { fs.renameSync(fp, origPath); } catch(ex) {
                  fs.copyFileSync(fp, origPath);
                  try { fs.unlinkSync(fp); } catch(ex2) {}
                }
                moved++;
              }
            } catch(ex) {}
          });
        } catch(ex) {}
      }
      findIn(poolPath, 0);

      db.run('UPDATE virtual_files SET storage_id = 0, migration_status = 0, storage_path = ? WHERE id = ?', [origPath, id]);
    });
  }

  db.run('DELETE FROM file_storage_paths');
  db.run('DELETE FROM file_storage');
  db.run('DELETE FROM user_file_refs');

  // Verify
  var allOk = true;
  var verify = db.exec('SELECT id, storage_path FROM virtual_files');
  if (verify[0]) verify[0].values.forEach(function(r) {
    var exists = fs.existsSync(r[1]);
    if (!exists) { console.log('MISSING: #' + r[0] + ' ' + r[1]); allOk = false; }
  });
  console.log('Files moved: ' + moved + ', all exist on disk: ' + allOk);

  var data = db.export();
  fs.writeFileSync('data/fileservice.db', Buffer.from(data));
  console.log('DB saved. Ready to migrate.');
});
