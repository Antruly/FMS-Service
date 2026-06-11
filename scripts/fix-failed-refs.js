// Fix failed migration files by referencing deduped entries
var initSqlJs = require('sql.js');
var fs = require('fs');
var buf = fs.readFileSync('data/fileservice.db');
initSqlJs().then(function(SQL) {
  var db = new SQL.Database(buf);

  // Find failed and successful files
  var failed = db.exec('SELECT id,user_id,name,dir_id,mime_type,size FROM virtual_files WHERE migration_status = -1');
  var ok = db.exec('SELECT vf.id as vfid, vf.name, vf.size, vf.storage_id, fs.id as fsid FROM virtual_files vf LEFT JOIN file_storage fs ON vf.storage_id = fs.id WHERE vf.migration_status = 1');

  if (!failed[0] || !ok[0]) { console.log('No failed files to fix'); return; }

  var cols = failed[0].columns;
  function fc(r, n) { var i = cols.indexOf(n); return i >= 0 ? r[i] : null; }
  var ocols = ok[0].columns;
  function oc(r, n) { var i = ocols.indexOf(n); return i >= 0 ? r[i] : null; }

  var fixed = 0;
  failed[0].values.forEach(function(fr) {
    var fid = fc(fr, 'id'), fname = fc(fr, 'name'), fsize = fc(fr, 'size');
    ok[0].values.forEach(function(or) {
      if (oc(or, 'name') === fname && oc(or, 'size') === fsize) {
        var sid = oc(or, 'storage_id');
        db.run('UPDATE virtual_files SET storage_id = ?, migration_status = 1 WHERE id = ?', [sid, fid]);
        db.run('UPDATE file_storage SET ref_count = ref_count + 1 WHERE id = ?', [sid]);
        db.run('INSERT INTO user_file_refs(user_id, storage_id, dir_id, name, mime_type) VALUES(?,?,?,?,?)',
          [fc(fr, 'user_id'), sid, fc(fr, 'dir_id') || 0, fname, fc(fr, 'mime_type') || '']);
        console.log('Fixed: vf#' + fid + ' -> storage_id=' + sid + ' (' + fname + ')');
        fixed++;
      }
    });
  });

  console.log('Fixed: ' + fixed + ' files');
  var data = db.export();
  fs.writeFileSync('data/fileservice.db', Buffer.from(data));
});
