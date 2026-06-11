const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../config');

const dbPath = path.resolve(__dirname, '..', config.DB_PATH);
const dbDir = path.dirname(dbPath);

let db = null;
let dbReady = null;

// 安全地添加列（SQLite ALTER TABLE ADD COLUMN 在列存在时不会报错）
function safeAddColumn(sqlite, table, columnDef) {
  try { sqlite.run('ALTER TABLE ' + table + ' ADD COLUMN ' + columnDef); } catch (e) {}
}

// 安全地创建表
function safeCreateTable(sqlite, sql) {
  try { sqlite.run(sql); } catch (e) {}
}

// 转义正则表达式特殊字符
function preg_quote(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function initDatabase() {
  if (dbReady) return dbReady;

  dbReady = new Promise(async function(resolve, reject) {
    try {
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      const SQL = await initSqlJs();

      if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
      } else {
        db = new SQL.Database();
      }

      // ==================== 表结构 ====================

      // 用户表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          nickname TEXT DEFAULT '',
          is_active INTEGER DEFAULT 1,
          is_verified INTEGER DEFAULT 0,
          is_admin INTEGER DEFAULT 0,
          quota_bytes INTEGER DEFAULT 104857600,
          used_bytes INTEGER DEFAULT 0,
          enc_master_key TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME,
          login_count INTEGER DEFAULT 0
        )
      `);

      // 虚拟目录表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS virtual_dirs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          parent_id INTEGER DEFAULT 0,
          name TEXT NOT NULL,
          is_public INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 虚拟文件表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS virtual_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          dir_id INTEGER DEFAULT 0,
          name TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          mime_type TEXT DEFAULT 'application/octet-stream',
          storage_path TEXT NOT NULL,
          nonce TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 权限表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          dir_id INTEGER DEFAULT 0,
          can_read INTEGER DEFAULT 1,
          can_write INTEGER DEFAULT 1,
          can_delete INTEGER DEFAULT 0,
          can_upload INTEGER DEFAULT 0,
          can_download INTEGER DEFAULT 1,
          can_create_dir INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (dir_id) REFERENCES virtual_dirs(id) ON DELETE CASCADE
        )
      `);

      // 公共文件表（不加密，直接存储在 files/download/ 下）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS public_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uploader_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          mime_type TEXT DEFAULT 'application/octet-stream',
          storage_path TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 操作日志表（记录用户操作：登录、文件上传下载删除等）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS action_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER DEFAULT 0,
          email TEXT DEFAULT '',
          action TEXT NOT NULL,
          target_type TEXT DEFAULT '',
          target_name TEXT DEFAULT '',
          target_id TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          status TEXT DEFAULT 'success',
          detail TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 邮件发送日志表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS email_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          to_email TEXT NOT NULL,
          template TEXT NOT NULL,
          status TEXT DEFAULT 'success',
          error TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
        db.run('CREATE INDEX IF NOT EXISTS idx_dirs_user ON virtual_dirs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_dirs_parent ON virtual_dirs(parent_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_files_user ON virtual_files(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_files_dir ON virtual_files(dir_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_perms_user ON permissions(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_public_files_uploader ON public_files(uploader_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_action_logs_user ON action_logs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_action_logs_action ON action_logs(action)');
        db.run('CREATE INDEX IF NOT EXISTS idx_action_logs_created ON action_logs(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_email_logs_email ON email_logs(to_email)');
        db.run('CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_offline_user ON offline_downloads(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_offline_status ON offline_downloads(status)');
      } catch (e) {
        console.error('[DB] 创建离线下载索引失败:', e.message);
      }

      // 离线下载任务表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS offline_downloads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          url TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT DEFAULT 'application/octet-stream',
          target_dir_id INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          total_bytes INTEGER DEFAULT 0,
          downloaded_bytes INTEGER DEFAULT 0,
          progress REAL DEFAULT 0,
          speed_bps INTEGER DEFAULT 0,
          error TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 回收站：已删除的个人文件表（软删除）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS deleted_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          dir_id INTEGER DEFAULT 0,
          name TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          mime_type TEXT DEFAULT 'application/octet-stream',
          storage_path TEXT NOT NULL,
          nonce TEXT,
          deleted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          original_dir_name TEXT DEFAULT '',
          recycle_dir_id INTEGER DEFAULT 0,
          enc_version INTEGER DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 回收站：已删除的个人目录表（软删除）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS deleted_dirs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          parent_id INTEGER DEFAULT 0,
          name TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          original_dir_path TEXT DEFAULT '',
          file_count INTEGER DEFAULT 0,
          file_nonces TEXT DEFAULT '',
          parent_recycle_id INTEGER DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 回收站索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_files_user ON deleted_files(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_files_expires ON deleted_files(expires_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_dirs_user ON deleted_dirs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_dirs_expires ON deleted_dirs(expires_at)');
      } catch (e) {}

      // 回收站：已删除的公共文件表（软删除）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS deleted_public_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          name TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          mime_type TEXT DEFAULT 'application/octet-stream',
          storage_path TEXT NOT NULL,
          nonce TEXT,
          deleted_by INTEGER NOT NULL,
          deleted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          original_path TEXT DEFAULT '',
          FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 回收站：已删除的公共目录表（软删除）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS deleted_public_dirs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dir_path TEXT NOT NULL,
          deleted_path TEXT NOT NULL,
          name TEXT NOT NULL,
          deleted_by INTEGER NOT NULL,
          deleted_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 公共回收站索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_pub_files_expires ON deleted_public_files(expires_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_pub_files_deleted ON deleted_public_files(deleted_by)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_pub_dirs_expires ON deleted_public_dirs(expires_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_deleted_pub_dirs_deleted ON deleted_public_dirs(deleted_by)');
      } catch (e) {}

      // 分享记录表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          share_hash TEXT NOT NULL UNIQUE,
          target_type TEXT NOT NULL,
          target_id INTEGER DEFAULT 0,
          target_name TEXT NOT NULL,
          extraction_code TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 分享索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_shares_hash ON shares(share_hash)');
        db.run('CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id)');
      } catch (e) {}

      // 迁移：为已有数据库补充新字段
      safeAddColumn(db, 'users', 'is_admin INTEGER DEFAULT 0');
      safeAddColumn(db, 'users', 'quota_bytes INTEGER DEFAULT 104857600');
      safeAddColumn(db, 'users', 'used_bytes INTEGER DEFAULT 0');
      safeAddColumn(db, 'users', 'enc_master_key TEXT');
      safeAddColumn(db, 'users', 'email_reminder INTEGER DEFAULT 1');  // 默认开启邮件提醒
      safeAddColumn(db, 'virtual_dirs', 'is_public INTEGER DEFAULT 0');
      // 确保旧数据的 is_public 值正确（ALTER TABLE DEFAULT 不更新已有行）
      db.run("UPDATE virtual_dirs SET is_public = 0 WHERE is_public IS NULL");
      // 确保旧数据的默认值生效
      db.run("UPDATE users SET is_admin = 0 WHERE is_admin IS NULL");
      db.run("UPDATE users SET quota_bytes = 104857600 WHERE quota_bytes IS NULL OR quota_bytes = 0");
      db.run("UPDATE users SET used_bytes = 0 WHERE used_bytes IS NULL");
      // 迁移：添加 deleted_public_dirs 的 deleted_path 列
      safeAddColumn(db, 'deleted_public_dirs', 'deleted_path TEXT');
      // 迁移：添加 deleted_dirs 的 file_count、file_nonces、parent_recycle_id 列
      safeAddColumn(db, 'deleted_dirs', 'file_count INTEGER DEFAULT 0');
      safeAddColumn(db, 'deleted_dirs', 'file_nonces TEXT');
      safeAddColumn(db, 'deleted_dirs', 'parent_recycle_id INTEGER DEFAULT 0');
      // 迁移：添加 deleted_files 的 recycle_dir_id 列
      safeAddColumn(db, 'deleted_files', 'recycle_dir_id INTEGER DEFAULT 0');
      // 迁移：添加 virtual_files 的引用类型字段
      safeAddColumn(db, 'virtual_files', 'is_reference INTEGER DEFAULT 0');
      safeAddColumn(db, 'virtual_files', 'reference_source_id INTEGER DEFAULT 0');
      // 迁移：添加 shares 的批量分享字段
      safeAddColumn(db, 'shares', "target_ids TEXT DEFAULT '[]'");
      // 迁移：为已有数据设置默认值
      db.run("UPDATE virtual_files SET is_reference = 0 WHERE is_reference IS NULL");
      db.run("UPDATE virtual_files SET reference_source_id = 0 WHERE reference_source_id IS NULL");
      // 迁移：添加文件加密版本字段（0=旧格式未标记, 1=分块V1格式）
      safeAddColumn(db, 'virtual_files', 'enc_version INTEGER DEFAULT 0');
      safeAddColumn(db, 'deleted_files', 'enc_version INTEGER DEFAULT 0');
      db.run("UPDATE virtual_files SET enc_version = 0 WHERE enc_version IS NULL");
      db.run("UPDATE deleted_files SET enc_version = 0 WHERE enc_version IS NULL");

      // 迁移：添加用户封禁字段
      safeAddColumn(db, 'users', 'is_banned INTEGER DEFAULT 0');
      safeAddColumn(db, 'users', 'ban_reason TEXT DEFAULT NULL');
      safeAddColumn(db, 'users', 'ban_expires_at TEXT DEFAULT NULL');
      // 创建用户流量配额表（独立存储流量配额和使用量）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS user_traffic_quotas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          guest_ip TEXT DEFAULT '',
          quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
          used_bytes INTEGER NOT NULL DEFAULT 0,
          period TEXT NOT NULL DEFAULT '',
          reset_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(user_id, guest_ip, period)
        )
      `);
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_utq_user ON user_traffic_quotas(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_utq_guest ON user_traffic_quotas(guest_ip)');
        db.run('CREATE INDEX IF NOT EXISTS idx_utq_period ON user_traffic_quotas(period)');
      } catch (e) {}

      // 迁移：添加文件封禁字段
      safeAddColumn(db, 'virtual_files', 'is_banned INTEGER DEFAULT 0');
      safeAddColumn(db, 'virtual_files', 'ban_reason TEXT DEFAULT NULL');
      safeAddColumn(db, 'virtual_files', 'ban_expires_at TEXT DEFAULT NULL');
      db.run("UPDATE virtual_files SET is_banned = 0 WHERE is_banned IS NULL");

      // 迁移：添加分享统计字段
      safeAddColumn(db, 'shares', 'view_count INTEGER DEFAULT 0');
      safeAddColumn(db, 'shares', 'download_count INTEGER DEFAULT 0');
      safeAddColumn(db, 'shares', 'max_downloads INTEGER DEFAULT 0');  // 0=不限制
      db.run("UPDATE shares SET view_count = 0 WHERE view_count IS NULL");
      db.run("UPDATE shares SET download_count = 0 WHERE download_count IS NULL");
      db.run("UPDATE shares SET max_downloads = 0 WHERE max_downloads IS NULL");

      // 迁移：WebDAV 链接表新增 require_auth 字段
      safeAddColumn(db, 'webdav_links', 'require_auth INTEGER DEFAULT 0');
      safeAddColumn(db, 'webdav_links', 'target_type TEXT DEFAULT \'public\'');

      // 迁移：重命名同目录下的重复文件名（为 WebDAV 兼容）
      console.log('[DB] 检查重复文件名...');
      var dupFiles = db.exec(
        'SELECT dir_id, name, COUNT(*) as cnt FROM virtual_files GROUP BY dir_id, name HAVING cnt > 1'
      );
      if (dupFiles.length > 0) {
        var rows = dupFiles[0].values || [];
        rows.forEach(function(row) {
          var dirId = row[0], fname = row[1];
          var files = query('SELECT id, name FROM virtual_files WHERE dir_id = ? AND name = ? ORDER BY id', [dirId, fname]);
          for (var fi = 1; fi < files.length; fi++) {
            var ext = '', base = fname;
            var dotIdx = fname.lastIndexOf('.');
            if (dotIdx > 0) { base = fname.substring(0, dotIdx); ext = fname.substring(dotIdx); }
            // 去掉已有的 (n) 后缀避免嵌套
            base = base.replace(/\s*\(\d+\)$/, '');
            var newName = base + ' (' + fi + ')' + ext;
            run('UPDATE virtual_files SET name = ? WHERE id = ?', [newName, files[fi].id]);
            console.log('[DB] 重命名重复文件: ' + fname + ' -> ' + newName + ' (dir_id=' + dirId + ')');
          }
        });
      }

      // 创建分享访问日志表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS share_access_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          share_id INTEGER NOT NULL,
          access_type TEXT NOT NULL,
          ip TEXT DEFAULT '',
          user_id INTEGER DEFAULT 0,
          email TEXT DEFAULT '',
          file_id INTEGER DEFAULT 0,
          file_name TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
        )
      `);

      // 创建 WebDAV 链接表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS webdav_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token TEXT NOT NULL UNIQUE,
          target_path TEXT NOT NULL,
          target_name TEXT NOT NULL,
          is_directory INTEGER DEFAULT 0,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          last_accessed TEXT,
          access_count INTEGER DEFAULT 0,
          is_revealed INTEGER DEFAULT 0,
          require_auth INTEGER DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_webdav_token ON webdav_links(token)');
        db.run('CREATE INDEX IF NOT EXISTS idx_webdav_user ON webdav_links(user_id)');
      } catch (e) {}

      // 创建IP黑名单表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS ip_blacklist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ip TEXT NOT NULL,
          reason TEXT DEFAULT '',
          created_by INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          is_active INTEGER DEFAULT 1,
          ban_level INTEGER DEFAULT 0,
          auto_ban INTEGER DEFAULT 0
        )
      `);

      // 升级已有表：添加新字段
      safeAddColumn(db, 'ip_blacklist', 'ban_level INTEGER DEFAULT 0');
      safeAddColumn(db, 'ip_blacklist', 'auto_ban INTEGER DEFAULT 0');

      // 创建流量记录表（详细日志）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS traffic_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER DEFAULT 0,
          guest_ip TEXT DEFAULT '',
          action_type TEXT NOT NULL,
          file_id INTEGER DEFAULT 0,
          file_name TEXT DEFAULT '',
          file_size INTEGER DEFAULT 0,
          bytes_count INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);

      // 创建月度汇总表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS monthly_traffic (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          guest_ip TEXT DEFAULT '',
          year_month TEXT NOT NULL,
          total_bytes INTEGER DEFAULT 0,
          UNIQUE(user_id, guest_ip, year_month),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 分享访问日志索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_share_access_share ON share_access_logs(share_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_share_access_created ON share_access_logs(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_share_access_ip ON share_access_logs(ip)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ip_blacklist_ip ON ip_blacklist(ip)');
        db.run('CREATE INDEX IF NOT EXISTS idx_traffic_logs_user ON traffic_logs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_traffic_logs_ip ON traffic_logs(guest_ip)');
        db.run('CREATE INDEX IF NOT EXISTS idx_traffic_logs_created ON traffic_logs(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_traffic_logs_type ON traffic_logs(action_type)');
        db.run('CREATE INDEX IF NOT EXISTS idx_monthly_traffic_user ON monthly_traffic(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_monthly_traffic_ip ON monthly_traffic(guest_ip)');
      } catch (e) {}

      // ==================== 存储架构 V2: 引用计数 + 哈希秒传 ====================

      // 文件物理存储实体（一份文件实体，多个用户可引用）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS file_storage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT UNIQUE NOT NULL,
          file_hash TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          plaintext_size INTEGER NOT NULL,
          ref_count INTEGER DEFAULT 1,
          enc_version INTEGER DEFAULT 1,
          is_encrypted INTEGER DEFAULT 1,
          nonce TEXT,
          status TEXT DEFAULT 'active',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 存储池配置（管理员管理）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS storage_pools (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          local_path TEXT NOT NULL,
          group_id INTEGER NOT NULL,
          mirror_index INTEGER DEFAULT 0,
          status TEXT DEFAULT 'active',
          total_bytes INTEGER DEFAULT 0,
          used_bytes INTEGER DEFAULT 0,
          priority INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 文件存储位置（一个文件可能有多个镜像路径）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS file_storage_paths (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          storage_id INTEGER NOT NULL,
          pool_id INTEGER NOT NULL,
          relative_path TEXT NOT NULL,
          full_path TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (storage_id) REFERENCES file_storage(id)
        )
      `);

      // 用户文件引用（用户-虚目录-文件实体的三元关联）
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS user_file_refs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          storage_id INTEGER NOT NULL,
          dir_id INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          mime_type TEXT DEFAULT 'application/octet-stream',
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (storage_id) REFERENCES file_storage(id)
        )
      `);

      // 创建索引
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_fs_hash_size ON file_storage(file_hash, file_size)');
        db.run('CREATE INDEX IF NOT EXISTS idx_fs_uuid ON file_storage(uuid)');
        db.run('CREATE INDEX IF NOT EXISTS idx_fs_ref_count ON file_storage(ref_count)');
        db.run('CREATE INDEX IF NOT EXISTS idx_sp_group ON storage_pools(group_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_fsp_storage ON file_storage_paths(storage_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_fsp_pool ON file_storage_paths(pool_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ufr_user ON user_file_refs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ufr_storage ON user_file_refs(storage_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ufr_dir ON user_file_refs(dir_id)');
      } catch (e) {}

      // 迁移：virtual_files 增加 storage_id 列（用于关联 file_storage）
      safeAddColumn(db, 'virtual_files', 'storage_id INTEGER DEFAULT 0');
      db.run("UPDATE virtual_files SET storage_id = 0 WHERE storage_id IS NULL");
      // 迁移状态：NULL/0=待迁移, 1=已迁移, -1=迁移失败(跳过)
      safeAddColumn(db, 'virtual_files', 'migration_status INTEGER DEFAULT 0');
      db.run("UPDATE virtual_files SET migration_status = 0 WHERE migration_status IS NULL");

      // 存储架构V3: file_storage 加 group_id（所属均衡组）
      safeAddColumn(db, 'file_storage', 'group_id INTEGER DEFAULT 0');
      // storage_pools 加 sync_status（synced/unsynced）和 name
      safeAddColumn(db, 'storage_pools', "sync_status TEXT DEFAULT 'synced'");
      safeAddColumn(db, 'storage_pools', "name TEXT DEFAULT ''");

      // 文件存储组表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS storage_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER UNIQUE NOT NULL,
          name TEXT DEFAULT '',
          status TEXT DEFAULT 'active',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      // 存储组加权重列
      safeAddColumn(db, 'storage_groups', 'weight INTEGER DEFAULT 5');
      // 创建默认组
      try {
        var defaultGroup = db.exec("SELECT id FROM storage_groups WHERE group_id = 0 LIMIT 1");
        if (!defaultGroup.length || !defaultGroup[0].values.length) {
          db.run("INSERT INTO storage_groups (group_id, name, status, weight) VALUES (0, '', 'active', 5)");
        }
      } catch(e) {}
      // 给已有池补名称
      db.run("UPDATE storage_pools SET name = '镜像' || mirror_index WHERE name = '' OR name IS NULL");

      // 默认存储组不自动创建镜像路径，由用户手动添加
      // （上传接口会降级使用 files/userdata 作为临时存储目录）
      // 给已有池补名称

      // ==================== 存储架构 V2 结束 ====================

      // ==================== 在线设备管理 ====================
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS user_devices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          device_id TEXT NOT NULL,
          device_name TEXT DEFAULT '',
          ip TEXT DEFAULT '',
          user_agent TEXT DEFAULT '',
          is_active INTEGER DEFAULT 1,
          last_active TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_ud_user ON user_devices(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ud_device ON user_devices(device_id)');
      } catch (e) {}
      // 迁移已有字段
      safeAddColumn(db, 'user_devices', 'last_active TEXT');

      // App 日志表
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS app_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER DEFAULT 0,
          device_id TEXT DEFAULT '',
          level TEXT DEFAULT 'info',
          tag TEXT DEFAULT '',
          message TEXT NOT NULL,
          metadata TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_app_logs_user ON app_logs(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at)');
      } catch (e) {}

      // ==================== 异步任务系统 ====================
      safeCreateTable(db, `
        CREATE TABLE IF NOT EXISTS async_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          progress INTEGER DEFAULT 0,
          total_items INTEGER DEFAULT 0,
          processed_items INTEGER DEFAULT 0,
          error_items INTEGER DEFAULT 0,
          logs TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}',
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_at_status ON async_tasks(status)');
        db.run('CREATE INDEX IF NOT EXISTS idx_at_type ON async_tasks(type)');
      } catch (e) {}

      saveDatabase();
      console.log('[DB] SQLite 数据库初始化完成');
      resolve();
    } catch (err) {
      console.error('[DB] 数据库初始化失败:', err);
      reject(err);
    }
  });

  return dbReady;
}

var _saveTimer = null;
var _savePending = false;

function saveDatabase() {
  if (!db) return;
  // 防抖：200ms内的多次调用合并为一次写入
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function() {
    _saveTimer = null;
    try {
      const data = db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
      _savePending = false;
    } catch (err) {
      console.error('[DB] 保存数据库失败:', err);
    }
  }, 200);
  _savePending = true;
}

// 强制立即保存（关键操作使用）
function saveDatabaseNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    _savePending = false;
  } catch (err) {
    console.error('[DB] 保存数据库失败:', err);
  }
}

function query(sql, params) {
  try {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (err) {
    console.error('[DB] 查询失败:', sql, err);
    return [];
  }
}

function run(sql, params) {
  try {
    db.run(sql, params || []);
    const changes = db.getRowsModified();
    let lastId = 0;
    try {
      const res = db.exec("SELECT last_insert_rowid()");
      if (res && res.length > 0 && res[0].values && res[0].values.length > 0) {
        lastId = res[0].values[0][0];
      }
    } catch (e) {}
    saveDatabase();
    return { lastInsertRowid: lastId, changes: changes };
  } catch (err) {
    console.error('[DB] 执行失败:', sql, err);
    return { lastInsertRowid: 0, changes: 0 };
  }
}

function get(sql, params) {
  const results = query(sql, params);
  return results.length > 0 ? results[0] : null;
}

// ==================== User ====================
const User = {
  init: initDatabase,

  create: function(email, password, nickname) {
    const hash = bcrypt.hashSync(password, 10);
    const result = run(
      'INSERT INTO users (email, password, nickname, is_verified) VALUES (?, ?, ?, 0)',
      [email.toLowerCase(), hash, nickname || email.split('@')[0]]
    );
    if (result.changes > 0) {
      if (result.lastInsertRowid > 0) return result.lastInsertRowid;
      const user = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
      if (user) return user.id;
    }
    return null;
  },

  findByEmail: function(email) {
    return get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  },

  findById: function(id) {
    return get(
      'SELECT id, email, nickname, is_active, is_verified, is_admin, quota_bytes, used_bytes, created_at, last_login, login_count, email_reminder FROM users WHERE id = ?',
      [id]
    );
  },

  updateLogin: function(id) {
    return run(
      'UPDATE users SET last_login = datetime("now"), login_count = login_count + 1 WHERE id = ?',
      [id]
    );
  },

  updatePassword: function(email, password) {
    const hash = bcrypt.hashSync(password, 10);
    return run('UPDATE users SET password = ? WHERE email = ?', [hash, email.toLowerCase()]);
  },

  changePassword: function(userId, oldPassword, newPassword) {
    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return { ok: false, message: '用户不存在' };
    if (!bcrypt.compareSync(oldPassword, user.password)) {
      return { ok: false, message: '原密码错误' };
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    run('UPDATE users SET password = ? WHERE id = ?', [hash, userId]);
    return { ok: true };
  },

  updateEmailReminder: function(userId, enabled) {
    return run('UPDATE users SET email_reminder = ? WHERE id = ?', [enabled ? 1 : 0, userId]);
  },

  verifyEmail: function(email) {
    return run('UPDATE users SET is_verified = 1 WHERE email = ?', [email.toLowerCase()]);
  },

  exists: function(email) {
    const result = get('SELECT COUNT(*) as count FROM users WHERE email = ?', [email.toLowerCase()]);
    return result && result.count > 0;
  },

  checkPassword: function(user, password) {
    return bcrypt.compareSync(password, user.password);
  },

  count: function() {
    const result = get('SELECT COUNT(*) as count FROM users');
    return result ? result.count : 0;
  },

  getAll: function(page, limit, keyword) {
    // 支持分页和关键词搜索
    var offset = (page - 1) * limit;
    var params = [];
    var where = [];
    if (keyword && keyword.trim()) {
      where.push('(email LIKE ? OR nickname LIKE ?)');
      var kw = '%' + keyword.trim() + '%';
      params.push(kw, kw);
    }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var users = query(
      'SELECT id, email, nickname, is_active, is_admin, quota_bytes, used_bytes, created_at, last_login, login_count, email_reminder, is_banned, ban_reason, ban_expires_at FROM users ' + whereStr + ' ORDER BY created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    var countRow = get('SELECT COUNT(*) as count FROM users ' + whereStr, params);
    return { users: users, total: countRow ? countRow.count : 0 };
  },

  updateQuota: function(userId, quotaBytes) {
    return run('UPDATE users SET quota_bytes = ? WHERE id = ?', [quotaBytes, userId]);
  },

  updateUsedBytes: function(userId, delta) {
    if (delta > 0) {
      return run('UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?', [delta, userId]);
    } else {
      return run('UPDATE users SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?', [delta, userId]);
    }
  },

  setUsedBytes: function(userId, bytes) {
    return run('UPDATE users SET used_bytes = ? WHERE id = ?', [bytes, userId]);
  },

  setAdmin: function(userId, isAdmin) {
    return run('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId]);
  },

  setActive: function(userId, isActive) {
    return run('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
  },

  updateNickname: function(userId, nickname) {
    return run('UPDATE users SET nickname = ? WHERE id = ?', [nickname, userId]);
  },

  saveEncMasterKey: function(userId, encKey) {
    return run('UPDATE users SET enc_master_key = ? WHERE id = ?', [encKey, userId]);
  },

  getEncMasterKey: function(userId) {
    const user = get('SELECT enc_master_key FROM users WHERE id = ?', [userId]);
    return user ? user.enc_master_key : null;
  },

  delete: function(userId) {
    return run('DELETE FROM users WHERE id = ?', [userId]);
  },

  // 用户封禁
  ban: function(userId, reason, expiresAt) {
    return run(
      'UPDATE users SET is_banned = 1, ban_reason = ?, ban_expires_at = ?, is_active = 0 WHERE id = ?',
      [reason || null, expiresAt || null, userId]
    );
  },

  // 用户解封
  unban: function(userId) {
    return run(
      'UPDATE users SET is_banned = 0, ban_reason = NULL, ban_expires_at = NULL, is_active = 1 WHERE id = ?',
      [userId]
    );
  },

  // 获取用户封禁信息
  getBanInfo: function(userId) {
    return get('SELECT is_banned, ban_reason, ban_expires_at FROM users WHERE id = ?', [userId]);
  },

  // 检查用户是否被封禁（包括时间检查）
  isEffectivelyBanned: function(userId) {
    var user = get('SELECT is_banned, ban_expires_at, is_active FROM users WHERE id = ?', [userId]);
    if (!user) return { banned: false };
    if (user.is_banned && user.ban_expires_at) {
      var expired = new Date(user.ban_expires_at) < new Date();
      if (expired) {
        // 自动解封
        run('UPDATE users SET is_banned = 0, ban_reason = NULL, ban_expires_at = NULL, is_active = 1 WHERE id = ?', [userId]);
        return { banned: false };
      }
      return { banned: true, reason: user.ban_reason, expires_at: user.ban_expires_at };
    }
    return { banned: !!user.is_banned, reason: user.ban_reason, expires_at: user.ban_expires_at };
  },

};

// ==================== VirtualDir ====================
const VirtualDir = {
  create: function(userId, parentId, name, isPublic) {
    const result = run(
      'INSERT INTO virtual_dirs (user_id, parent_id, name, is_public) VALUES (?, ?, ?, ?)',
      [userId, parentId || 0, name, isPublic ? 1 : 0]
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  },

  listByParent: function(userId, parentId) {
    return query(
      'SELECT * FROM virtual_dirs WHERE user_id = ? AND parent_id = ? ORDER BY name',
      [userId, parentId || 0]
    );
  },

  // 仅列出个人目录（排除公共目录）
  listPersonalByParent: function(userId, parentId) {
    return query(
      'SELECT * FROM virtual_dirs WHERE user_id = ? AND parent_id = ? AND is_public = 0 ORDER BY name',
      [userId, parentId || 0]
    );
  },

  listRoot: function(userId) {
    return query(
      'SELECT * FROM virtual_dirs WHERE user_id = ? AND parent_id = 0 ORDER BY name',
      [userId]
    );
  },

  // List all public root-level directories (from all users)
  listPublicRoot: function() {
    return query(
      'SELECT d.*, u.nickname as owner_nickname, u.email as owner_email FROM virtual_dirs d LEFT JOIN users u ON d.user_id = u.id WHERE d.parent_id = 0 AND d.is_public = 1 ORDER BY d.name'
    );
  },

  // List all public subdirectories under a given parent
  listPublicByParent: function(parentId) {
    return query(
      'SELECT d.*, u.nickname as owner_nickname, u.email as owner_email FROM virtual_dirs d LEFT JOIN users u ON d.user_id = u.id WHERE d.parent_id = ? AND d.is_public = 1 ORDER BY d.name',
      [parentId]
    );
  },

  findById: function(id) {
    return get('SELECT * FROM virtual_dirs WHERE id = ?', [id]);
  },

  findByName: function(userId, parentId, name) {
    return get('SELECT * FROM virtual_dirs WHERE user_id = ? AND parent_id = ? AND name = ?', [userId, parentId || 0, name]);
  },

  rename: function(id, newName) {
    return run('UPDATE virtual_dirs SET name = ? WHERE id = ?', [newName, id]);
  },

  delete: function(id) {
    return run('DELETE FROM virtual_dirs WHERE id = ?', [id]);
  },

  getAllChildIds: function(parentId) {
    const children = query('SELECT id FROM virtual_dirs WHERE parent_id = ?', [parentId]);
    const ids = children.map(function(c) { return c.id; });
    for (var i = 0; i < children.length; i++) {
      const grandChildren = VirtualDir.getAllChildIds(children[i].id);
      for (var j = 0; j < grandChildren.length; j++) ids.push(grandChildren[j]);
    }
    return ids;
  },

  countChildren: function(userId, parentId) {
    const result = get(
      'SELECT COUNT(*) as count FROM virtual_dirs WHERE user_id = ? AND parent_id = ?',
      [userId, parentId || 0]
    );
    return result ? result.count : 0;
  }
};

// ==================== VirtualFile ====================
const VirtualFile = {
  create: function(userId, dirId, name, size, mimeType, storagePath, nonce, opts) {
    var isRef = opts && opts.is_reference ? 1 : 0;
    var refSource = opts && opts.reference_source_id ? opts.reference_source_id : 0;
    const result = run(
      'INSERT INTO virtual_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, is_reference, reference_source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, dirId || 0, name, size, mimeType || 'application/octet-stream', storagePath, nonce, isRef, refSource]
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  },

  // 创建文件并指定加密版本
  createWithEncVersion: function(userId, dirId, name, size, mimeType, storagePath, nonce, encVersion) {
    const result = run(
      'INSERT INTO virtual_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, enc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, dirId || 0, name, size, mimeType || 'application/octet-stream', storagePath, nonce, encVersion || 0]
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  },

  // 复制文件（物理复制到用户存储目录，新建虚拟记录，保持原加密版本）
  copy: function(sourceFileId, newUserId, newDirId) {
    var src = VirtualFile.findById(sourceFileId);
    if (!src) return null;
    var fs = require('fs');
    var srcPath = src.storage_path;
    if (!fs.existsSync(srcPath)) return null;

    var Storage = require('./db').Storage;
    var newPath = Storage.genFilePath(src.name, newUserId);
    fs.copyFileSync(srcPath, newPath);

    var newId = VirtualFile.createWithEncVersion(
      newUserId, newDirId || 0, src.name, src.size, src.mime_type, newPath, src.nonce, src.enc_version
    );
    return newId;
  },

  listByDir: function(userId, dirId) {
    return query(
      'SELECT * FROM virtual_files WHERE user_id = ? AND dir_id = ? ORDER BY name',
      [userId, dirId || 0]
    );
  },

  listRoot: function(userId) {
    return query(
      'SELECT * FROM virtual_files WHERE user_id = ? AND dir_id = 0 ORDER BY name',
      [userId]
    );
  },

  // List all files in a public directory (with owner info)
  listByPublicDir: function(dirId) {
    return query(
      'SELECT f.*, u.nickname as owner_nickname, u.email as owner_email FROM virtual_files f LEFT JOIN users u ON f.user_id = u.id WHERE f.dir_id = ? ORDER BY f.name',
      [dirId]
    );
  },

  findById: function(id) {
    return get('SELECT * FROM virtual_files WHERE id = ?', [id]);
  },

  rename: function(id, newName) {
    return run('UPDATE virtual_files SET name = ?, updated_at = datetime("now") WHERE id = ?', [newName, id]);
  },

  delete: function(id) {
    const file = VirtualFile.findById(id);
    if (file) {
      run('DELETE FROM virtual_files WHERE id = ?', [id]);
      return file;
    }
    return null;
  },

  countUserFiles: function(userId) {
    const result = get('SELECT COUNT(*) as count FROM virtual_files WHERE user_id = ?', [userId]);
    return result ? result.count : 0;
  },

  sumUserSize: function(userId) {
    const result = get('SELECT COALESCE(SUM(size), 0) as total FROM virtual_files WHERE user_id = ?', [userId]);
    return result ? result.total : 0;
  },

  countInDir: function(userId, dirId) {
    const result = get(
      'SELECT COUNT(*) as count FROM virtual_files WHERE user_id = ? AND dir_id = ?',
      [userId, dirId || 0]
    );
    return result ? result.count : 0;
  },

  moveTo: function(fileId, newDirId) {
    return run('UPDATE virtual_files SET dir_id = ?, updated_at = datetime("now") WHERE id = ?', [newDirId, fileId]);
  },

  updateSize: function(id, newSize) {
    return run('UPDATE virtual_files SET size = ?, updated_at = datetime("now") WHERE id = ?', [newSize, id]);
  },

  // 获取需要升级的文件（enc_version = 0 且有物理文件）
  listForUpgrade: function(limit) {
    limit = limit || 100;
    return query(
      'SELECT vf.*, u.nickname as owner_nickname, u.email as owner_email FROM virtual_files vf LEFT JOIN users u ON vf.user_id = u.id WHERE vf.enc_version = 0 ORDER BY vf.id LIMIT ' + Number(limit)
    );
  },

  // 获取需要升级的文件总数
  countForUpgrade: function() {
    var result = get('SELECT COUNT(*) as count FROM virtual_files WHERE enc_version = 0');
    return result ? result.count : 0;
  },

  // 设置文件加密版本
  setEncVersion: function(id, version) {
    return run('UPDATE virtual_files SET enc_version = ? WHERE id = ?', [version, id]);
  },

  // 封禁文件
  ban: function(id, reason, expiresAt) {
    return run(
      'UPDATE virtual_files SET is_banned = 1, ban_reason = ?, ban_expires_at = ? WHERE id = ?',
      [reason || null, expiresAt || null, id]
    );
  },

  // 解封文件
  unban: function(id) {
    return run(
      'UPDATE virtual_files SET is_banned = 0, ban_reason = NULL, ban_expires_at = NULL WHERE id = ?',
      [id]
    );
  },

  // 获取文件封禁信息
  getBanInfo: function(id) {
    return get('SELECT is_banned, ban_reason, ban_expires_at FROM virtual_files WHERE id = ?', [id]);
  },

  // 获取文件实际存储大小
  getStorageSize: function(id) {
    var file = get('SELECT storage_path FROM virtual_files WHERE id = ?', [id]);
    if (!file || !file.storage_path) return 0;
    try {
      var stat = require('fs').statSync(file.storage_path);
      return stat.size;
    } catch (e) {
      return 0;
    }
  }
};

// ==================== Permission ====================
const Permission = {
  get: function(userId, dirId) {
    return get(
      'SELECT * FROM permissions WHERE user_id = ? AND dir_id = ?',
      [userId, dirId || 0]
    );
  },

  set: function(userId, dirId, perms) {
    const existing = Permission.get(userId, dirId);
    if (existing) {
      return run(
        'UPDATE permissions SET can_read = ?, can_write = ?, can_delete = ?, can_upload = ?, can_download = ?, can_create_dir = ? WHERE user_id = ? AND dir_id = ?',
        [perms.canRead ? 1 : 0, perms.canWrite ? 1 : 0, perms.canDelete ? 1 : 0, perms.canUpload ? 1 : 0, perms.canDownload ? 1 : 0, perms.canCreateDir ? 1 : 0, userId, dirId || 0]
      );
    } else {
      return run(
        'INSERT INTO permissions (user_id, dir_id, can_read, can_write, can_delete, can_upload, can_download, can_create_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, dirId || 0, perms.canRead ? 1 : 0, perms.canWrite ? 1 : 0, perms.canDelete ? 1 : 0, perms.canUpload ? 1 : 0, perms.canDownload ? 1 : 0, perms.canCreateDir ? 1 : 0]
      );
    }
  },

  remove: function(userId, dirId) {
    return run('DELETE FROM permissions WHERE user_id = ? AND dir_id = ?', [userId, dirId || 0]);
  },

  getAllForUser: function(userId) {
    return query('SELECT * FROM permissions WHERE user_id = ?', [userId]);
  },

  getAllForDir: function(dirId) {
    return query('SELECT * FROM permissions WHERE dir_id = ?', [dirId || 0]);
  }
};

// ==================== PublicFile ====================
const PublicFile = {
  create: function(uploaderId, name, size, mimeType, storagePath) {
    const result = run(
      'INSERT INTO public_files (uploader_id, name, size, mime_type, storage_path) VALUES (?, ?, ?, ?, ?)',
      [uploaderId, name, size, mimeType || 'application/octet-stream', storagePath]
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  },

  listAll: function() {
    return query(
      'SELECT pf.*, u.nickname as uploader_nickname, u.email as uploader_email FROM public_files pf LEFT JOIN users u ON pf.uploader_id = u.id ORDER BY pf.created_at DESC'
    );
  },

  findById: function(id) {
    return get('SELECT * FROM public_files WHERE id = ?', [id]);
  },

  delete: function(id) {
    const file = PublicFile.findById(id);
    if (file) {
      run('DELETE FROM public_files WHERE id = ?', [id]);
      return file;
    }
    return null;
  },

  count: function() {
    const result = get('SELECT COUNT(*) as count FROM public_files');
    return result ? result.count : 0;
  },

  totalSize: function() {
    const result = get('SELECT COALESCE(SUM(size), 0) as total FROM public_files');
    return result ? result.total : 0;
  }
};

// ==================== Storage ====================
const Storage = {
  STORAGE_DIR: path.join(__dirname, '..', 'files', 'userdata'),
  PUBLIC_DIR: path.join(__dirname, '..', 'files', 'download'),

  ensureUserDir: function(userId) {
    const userDir = path.join(Storage.STORAGE_DIR, String(userId));
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  },

  ensurePublicDir: function() {
    if (!fs.existsSync(Storage.PUBLIC_DIR)) {
      fs.mkdirSync(Storage.PUBLIC_DIR, { recursive: true });
    }
    return Storage.PUBLIC_DIR;
  },

  // 按日期生成相对路径: 2026/06/06/<uuid>.enc
  // dateStr: 可选，指定日期（ISO 字符串或 Date），默认当天
  getDateBasedPath: function(uuid, dateStr) {
    var d = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(d.getTime())) d = new Date(); // 无效日期回退当天
    var y = String(d.getFullYear());
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + day + '/' + uuid + '.enc';
  },

  // 获取完整存储路径（优先使用存储池路径，回退到旧 userdata 目录）
  getFilePath: function(userId, uuid) {
    // 新架构：按日期分目录，放在默认存储池下
    var StoragePool = require('./db').StoragePool;
    var defaultPool = StoragePool.getDefaultPath();
    var relPath = Storage.getDateBasedPath(uuid);
    var fullPath = path.join(defaultPool, relPath);
    // 确保目录存在
    var dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fullPath;
  },

  getPublicFilePath: function(filename) {
    return path.join(Storage.ensurePublicDir(), filename);
  },

  deleteFile: function(userId, uuid) {
    // 先试新路径（日期结构），再试旧路径（userdata/<userId>/<uuid>）
    var newPath = Storage.getFilePath(userId, uuid);
    if (fs.existsSync(newPath)) {
      fs.unlinkSync(newPath);
      return true;
    }
    var oldPath = path.join(Storage.STORAGE_DIR, String(userId), uuid + '.enc');
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      return true;
    }
    return false;
  },

  deletePublicFile: function(filename) {
    const filePath = Storage.getPublicFilePath(filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  },

  fileExists: function(userId, uuid) {
    return fs.existsSync(Storage.getFilePath(userId, uuid));
  },

  publicFileExists: function(filename) {
    return fs.existsSync(Storage.getPublicFilePath(filename));
  },

  getFileSize: function(userId, uuid) {
    const filePath = Storage.getFilePath(userId, uuid);
    if (fs.existsSync(filePath)) {
      return fs.statSync(filePath).size;
    }
    return 0;
  }
};

// ==================== ActionLog ====================
var ActionLog = {
  log: function(userId, email, action, targetType, targetName, targetId, ip, userAgent, status, detail) {
    // 直接存储 ISO UTC 时间字符串（避免 SQLite datetime() 时区问题）
    var ts = new Date().toISOString();
    return run(
      'INSERT INTO action_logs (user_id, email, action, target_type, target_name, target_id, ip, user_agent, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId || 0, email || '', action, targetType || '', targetName || '', targetId || '', ip || '', userAgent || '', status || 'success', detail || '', ts]
    );
  },

  list: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];

    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.email) {
      where.push('email LIKE ?');
      params.push('%' + opts.email + '%');
    }
    if (opts.action) {
      where.push('action = ?');
      params.push(opts.action);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.startDate) {
      where.push('created_at >= ?');
      params.push(opts.startDate);
    }
    if (opts.endDate) {
      where.push('created_at <= ?');
      params.push(opts.endDate + ' 23:59:59');
    }

    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var limit = opts.limit || 100;
    var offset = opts.offset || 0;
    var order = opts.order || 'DESC';

    var sql = 'SELECT * FROM action_logs ' + whereStr + ' ORDER BY id ' + order + ' LIMIT ' + Number(limit) + ' OFFSET ' + Number(offset);
    var results = query(sql, params);

    // 总数
    var countSql = 'SELECT COUNT(*) as total FROM action_logs ' + whereStr;
    var totalResult = get(countSql, params);

    return {
      data: results,
      total: totalResult ? totalResult.total : 0
    };
  },

  getActions: function() {
    return query('SELECT DISTINCT action FROM action_logs ORDER BY action');
  },

  deleteOld: function(days) {
    return run('DELETE FROM action_logs WHERE created_at < datetime("now", "-" || ? || " days")', [days || 90]);
  },

  clearAll: function() {
    return run('DELETE FROM action_logs');
  }
};

// ==================== EmailLog ====================
var EmailLog = {
  log: function(toEmail, template, status, error, ip) {
    // 直接存储 ISO UTC 时间字符串（避免 SQLite datetime() 时区问题）
    var ts = new Date().toISOString();
    return run(
      'INSERT INTO email_logs (to_email, template, status, error, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [toEmail, template, status || 'success', error || '', ip || '', ts]
    );
  },

  list: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];

    if (opts.toEmail) {
      where.push('to_email LIKE ?');
      params.push('%' + opts.toEmail + '%');
    }
    if (opts.template) {
      where.push('template = ?');
      params.push(opts.template);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.startDate) {
      where.push('created_at >= ?');
      params.push(opts.startDate);
    }
    if (opts.endDate) {
      where.push('created_at <= ?');
      params.push(opts.endDate + ' 23:59:59');
    }

    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var limit = opts.limit || 100;
    var offset = opts.offset || 0;

    var sql = 'SELECT * FROM email_logs ' + whereStr + ' ORDER BY id DESC LIMIT ' + Number(limit) + ' OFFSET ' + Number(offset);
    var results = query(sql, params);

    var countSql = 'SELECT COUNT(*) as total FROM email_logs ' + whereStr;
    var totalResult = get(countSql, params);

    return {
      data: results,
      total: totalResult ? totalResult.total : 0
    };
  },

  getTemplates: function() {
    return query('SELECT DISTINCT template FROM email_logs ORDER BY template');
  },

  deleteOld: function(days) {
    return run('DELETE FROM email_logs WHERE created_at < datetime("now", "-" || ? || " days")', [days || 180]);
  },

  clearAll: function() {
    return run('DELETE FROM email_logs');
  }
};

// ==================== RecycleBin（回收站）====================
const RecycleBin = {
  // 将个人文件移入回收站（软删除）
  moveFile: function(fileId, userId) {
    const file = VirtualFile.findById(fileId);
    if (!file || file.user_id !== userId) return null;

    // 获取所在目录名
    var dirName = '';
    if (file.dir_id) {
      var dir = VirtualDir.findById(file.dir_id);
      if (dir) dirName = dir.name;
    }

    var now = new Date().toISOString();
    var expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    // 插入回收站记录（保留 enc_version）
    run(
      'INSERT INTO deleted_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, deleted_at, expires_at, original_dir_name, enc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, file.dir_id, file.name, file.size, file.mime_type, file.storage_path, file.nonce, now, expires, dirName, file.enc_version || 0]
    );

    // 删除原记录
    run('DELETE FROM virtual_files WHERE id = ?', [fileId]);

    return file;
  },

  // 将个人目录及其所有文件移入回收站（每个目录独立记录，子目录通过 parent_recycle_id 关联）
  moveDir: function(dirId, userId) {
    const dir = VirtualDir.findById(dirId);
    if (!dir || dir.user_id !== userId) return null;

    var now = new Date().toISOString();
    var expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    // 递归获取所有子目录（含自身）
    var allDirIds = RecycleBin._getAllChildDirIds(dirId, userId);
    allDirIds.unshift(dirId);

    // 第一遍：先为所有目录插入回收站记录，获取 recycleId 映射
    var recycleIdMap = {}; // originalDirId -> recycleId
    allDirIds.forEach(function(did) {
      var vdir = VirtualDir.findById(did);
      var subDirPath = RecycleBin._getDirPath(did, userId);
      // 统计该目录下的文件数
      var subFiles = VirtualFile.listByDir(userId, did);
      var fileNonces = subFiles.map(function(f) { return f.nonce; });
      // 获取父目录对应的 recycle_id（如果是顶级目录则为 0）
      var parentRecycleId = 0;
      if (vdir.parent_id && vdir.parent_id !== 0 && recycleIdMap[vdir.parent_id]) {
        parentRecycleId = recycleIdMap[vdir.parent_id];
      }

      var result = run(
        'INSERT INTO deleted_dirs (user_id, parent_id, name, deleted_at, expires_at, original_dir_path, file_count, file_nonces, parent_recycle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, vdir.parent_id, vdir.name, now, expires, subDirPath, subFiles.length, JSON.stringify(fileNonces), parentRecycleId]
      );
      recycleIdMap[did] = result.lastInsertRowid;
    });

    // 第二遍：删除所有目录及其文件（记录到回收站）
    var topRecycleId = recycleIdMap[dirId];
    allDirIds.forEach(function(did) {
      var vdir = VirtualDir.findById(did);
      var files = VirtualFile.listByDir(userId, did);
      files.forEach(function(file) {
        // 插入文件回收站记录（dir_id=原虚拟目录id, recycle_dir_id=回收站目录id，保留 enc_version）
        run(
          'INSERT INTO deleted_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, deleted_at, expires_at, original_dir_name, recycle_dir_id, enc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [userId, did, file.name, file.size, file.mime_type, file.storage_path, file.nonce, now, expires, '', recycleIdMap[did], file.enc_version || 0]
        );
        run('DELETE FROM virtual_files WHERE id = ?', [file.id]);
      });
      run('DELETE FROM virtual_dirs WHERE id = ?', [did]);
    });

    return { dir: dir, recycleDirId: topRecycleId };
  },

  // 获取目录的完整路径（用于恢复时判断冲突）
  _getDirPath: function(dirId, userId) {
    var parts = [];
    var currentId = dirId;
    while (currentId && currentId !== 0) {
      var d = VirtualDir.findById(currentId);
      if (!d) break;
      if (d.user_id !== userId) break;
      parts.unshift(d.name);
      currentId = d.parent_id;
    }
    return parts.join('/');
  },

  // 递归获取所有子目录 ID
  _getAllChildDirIds: function(parentId, userId) {
    var result = [];
    var children = query('SELECT id FROM virtual_dirs WHERE user_id = ? AND parent_id = ?', [userId, parentId]);
    children.forEach(function(child) {
      result.push(child.id);
      var sub = RecycleBin._getAllChildDirIds(child.id, userId);
      sub.forEach(function(s) { result.push(s); });
    });
    return result;
  },

  // 获取用户回收站文件列表（排除已被目录软删除的文件，recycle_dir_id=0 表示独立删除的文件）
  listFiles: function(userId) {
    return query(
      'SELECT * FROM deleted_files WHERE user_id = ? AND expires_at > ? AND (recycle_dir_id = 0 OR recycle_dir_id NOT IN (SELECT id FROM deleted_dirs WHERE user_id = ?)) ORDER BY deleted_at DESC',
      [userId, new Date().toISOString(), userId]
    );
  },

  // 获取用户回收站目录列表（只显示顶级被删除的目录，子目录由恢复逻辑自动处理）
  listDirs: function(userId) {
    return query(
      'SELECT * FROM deleted_dirs WHERE user_id = ? AND expires_at > ? AND parent_recycle_id = 0 ORDER BY deleted_at DESC',
      [userId, new Date().toISOString()]
    );
  },

  // 获取回收站文件数（与 listFiles 保持一致）
  countFiles: function(userId) {
    var result = get(
      'SELECT COUNT(*) as count FROM deleted_files WHERE user_id = ? AND expires_at > ? AND (recycle_dir_id = 0 OR recycle_dir_id NOT IN (SELECT id FROM deleted_dirs WHERE user_id = ?))',
      [userId, new Date().toISOString(), userId]
    );
    return result ? result.count : 0;
  },

  // 获取回收站目录数
  countDirs: function(userId) {
    var result = get(
      'SELECT COUNT(*) as count FROM deleted_dirs WHERE user_id = ? AND expires_at > ?',
      [userId, new Date().toISOString()]
    );
    return result ? result.count : 0;
  },

  // 恢复文件（永久删除回收站记录，但保留物理文件）
  restoreFile: function(recycleFileId, userId, targetDirId) {
    targetDirId = targetDirId || 0;
    var file = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [recycleFileId, userId]);
    if (!file) return { ok: false, reason: 'file_not_found' };

    // 检查目标目录是否有同名文件
    var existing = query('SELECT id FROM virtual_files WHERE user_id = ? AND dir_id = ? AND name = ?', [userId, targetDirId, file.name]);
    if (existing && existing.length > 0) {
      return { ok: false, reason: 'name_conflict', existingId: existing[0].id, fileName: file.name };
    }

    // 恢复文件记录（保留 enc_version）
    var restoredFile = get('SELECT enc_version FROM deleted_files WHERE id = ?', [recycleFileId]);
    var encVersion = restoredFile ? restoredFile.enc_version : 0;
    run(
      'INSERT INTO virtual_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, created_at, enc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, targetDirId, file.name, file.size, file.mime_type, file.storage_path, file.nonce, file.deleted_at, encVersion]
    );

    // 删除回收站记录
    run('DELETE FROM deleted_files WHERE id = ?', [recycleFileId]);

    return { ok: true };
  },

  // 恢复目录（递归恢复子目录和文件）
  restoreDir: function(recycleDirId, userId, targetParentId) {
    targetParentId = targetParentId || 0;

    // 内部递归恢复（使用回收站 parent_recycle_id 建立层级）
    function restoreRecurse(recycleId, parentVirtualId) {
      var dRec = get('SELECT * FROM deleted_dirs WHERE id = ? AND user_id = ?', [recycleId, userId]);
      if (!dRec) return;

      // 检查目标目录是否有同名目录
      var existing = query('SELECT id FROM virtual_dirs WHERE user_id = ? AND parent_id = ? AND name = ?', [userId, parentVirtualId, dRec.name]);
      if (existing && existing.length > 0) return; // 冲突跳过

      // 创建虚拟目录
      var insResult = run(
        'INSERT INTO virtual_dirs (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
        [userId, parentVirtualId, dRec.name, dRec.deleted_at]
      );
      var newVirtualId = insResult.lastInsertRowid;

      // 递归恢复所有子回收站目录（通过 parent_recycle_id 找子目录）
      var children = query('SELECT id FROM deleted_dirs WHERE user_id = ? AND parent_recycle_id = ?', [userId, recycleId]);
      children.forEach(function(child) {
        restoreRecurse(child.id, newVirtualId);
      });

      // 恢复属于该目录的所有文件（通过 recycle_dir_id 找到）
      var dFiles = query('SELECT * FROM deleted_files WHERE user_id = ? AND recycle_dir_id = ?', [userId, recycleId]);
      dFiles.forEach(function(f) {
        run(
          'INSERT INTO virtual_files (user_id, dir_id, name, size, mime_type, storage_path, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [userId, newVirtualId, f.name, f.size, f.mime_type, f.storage_path, f.nonce, f.deleted_at]
        );
        run('DELETE FROM deleted_files WHERE id = ?', [f.id]);
      });

      // 删除回收站目录记录（放在最后，防止子目录找不到父）
      run('DELETE FROM deleted_dirs WHERE id = ?', [recycleId]);
    }

    // 先检查顶级目录是否有冲突
    var topRec = get('SELECT * FROM deleted_dirs WHERE id = ? AND user_id = ?', [recycleDirId, userId]);
    if (!topRec) return { ok: false, reason: 'dir_not_found' };
    var existing = query('SELECT id FROM virtual_dirs WHERE user_id = ? AND parent_id = ? AND name = ?', [userId, targetParentId, topRec.name]);
    if (existing && existing.length > 0) {
      return { ok: false, reason: 'name_conflict', existingId: existing[0].id, dirName: topRec.name };
    }

    restoreRecurse(recycleDirId, targetParentId);
    return { ok: true };
  },

  // 永久删除回收站文件（真正删除物理文件）
  purgeFile: function(recycleFileId, userId) {
    var file = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [recycleFileId, userId]);
    if (!file) return null;
    run('DELETE FROM deleted_files WHERE id = ?', [recycleFileId]);
    return file;
  },

  // 清空用户回收站（删除所有文件和目录的物理文件）
  emptyAll: function(userId) {
    // 先查出所有文件并删除物理文件
    var allFiles = query('SELECT * FROM deleted_files WHERE user_id = ?', [userId]);
    allFiles.forEach(function(f) {
      try { Storage.deleteFile(f.user_id, f.nonce); } catch (e) {}
    });
    run('DELETE FROM deleted_files WHERE user_id = ?', [userId]);
    run('DELETE FROM deleted_dirs WHERE user_id = ?', [userId]);
    return { files: allFiles };
  },

  // 自动清理过期文件（定时调用，返回清理数量）
  purgeExpired: function() {
    var now = new Date().toISOString();
    // 只清理过期的顶级目录（parent_recycle_id = 0）
    var expiredDirs = query('SELECT * FROM deleted_dirs WHERE expires_at <= ? AND parent_recycle_id = 0', [now]);
    var expiredFileIds = [];
    var count = 0;

    // 清理过期目录（目录下所有文件和子目录也一并删除物理文件）
    expiredDirs.forEach(function(d) {
      // 查出该回收站目录下所有文件（含所有子目录的）
      var allDirIds = [d.id];
      var subDirs = query('SELECT id FROM deleted_dirs WHERE parent_recycle_id = ?', [d.id]);
      subDirs.forEach(function(sd) {
        allDirIds.push(sd.id);
      });
      allDirIds.forEach(function(rid) {
        var dirFiles = query('SELECT * FROM deleted_files WHERE recycle_dir_id = ?', [rid]);
        dirFiles.forEach(function(f) {
          try { Storage.deleteFile(f.user_id, f.nonce); } catch (e) { console.error('[purgeExpired] 删除文件失败:', e); }
          expiredFileIds.push(f.id);
          count++;
        });
      });
      // 删除所有该顶级目录下的回收站目录记录
      run('DELETE FROM deleted_dirs WHERE parent_recycle_id = ?', [d.id]);
      run('DELETE FROM deleted_dirs WHERE id = ?', [d.id]);
      count++;
    });

    // 清理不在过期目录中的独立过期文件
    var otherExpiredFiles = query(
      'SELECT * FROM deleted_files WHERE expires_at <= ? AND (recycle_dir_id = 0 OR recycle_dir_id NOT IN (SELECT id FROM deleted_dirs WHERE expires_at <= ?))',
      [now, now]
    );
    otherExpiredFiles.forEach(function(f) {
      try { Storage.deleteFile(f.user_id, f.nonce); } catch (e) { console.error('[purgeExpired] 删除文件失败:', e); }
      expiredFileIds.push(f.id);
      count++;
    });

    // 统一删除文件记录
    if (expiredFileIds.length > 0) {
      var placeholders = expiredFileIds.map(function() { return '?'; }).join(',');
      run('DELETE FROM deleted_files WHERE id IN (' + placeholders + ')', expiredFileIds);
    }

    // 统计清理的文件数（含顶级和子目录）
    var totalCleanedFiles = 0;
    expiredDirs.forEach(function(d) {
      totalCleanedFiles += RecycleBin._countAllDirFiles(d.id);
    });
    totalCleanedFiles += otherExpiredFiles.length;

    return { count: count, files: totalCleanedFiles, dirs: expiredDirs.length };
  },

  // 统计某回收站目录下所有文件数（含子目录）
  _countAllDirFiles: function(recycleDirId) {
    var total = 0;
    var allDirIds = [recycleDirId];
    var subDirs = query('SELECT id FROM deleted_dirs WHERE parent_recycle_id = ?', [recycleDirId]);
    subDirs.forEach(function(sd) {
      allDirIds.push(sd.id);
    });
    allDirIds.forEach(function(rid) {
      var result = get('SELECT COUNT(*) as cnt FROM deleted_files WHERE recycle_dir_id = ?', [rid]);
      total += result ? result.cnt : 0;
    });
    return total;
  },

  // ---------- 公共目录回收站 ----------

  // 将公共文件移入回收站
  movePublicFile: function(filePath, fileName, size, mimeType, storagePath, nonce, deletedBy) {
    var now = new Date();
    var deletedAt = now.toISOString();
    var expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30天后过期

    run(
      'INSERT INTO deleted_public_files (file_path, name, size, mime_type, storage_path, nonce, deleted_by, deleted_at, expires_at, original_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [filePath, fileName, size, mimeType, storagePath, nonce, deletedBy, deletedAt, expiresAt, filePath]
    );
    return { ok: true };
  },

  // 将公共目录移入回收站
  movePublicDir: function(dirPath, dirName, deletedBy, deletedPath) {
    var now = new Date();
    var deletedAt = now.toISOString();
    var expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    run(
      'INSERT INTO deleted_public_dirs (dir_path, deleted_path, name, deleted_by, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [dirPath, deletedPath, dirName, deletedBy, deletedAt, expiresAt]
    );
    return { ok: true };
  },

  // 获取公共回收站文件列表
  listPublicFiles: function() {
    return query(
      'SELECT * FROM deleted_public_files WHERE expires_at > ? ORDER BY deleted_at DESC',
      [new Date().toISOString()]
    );
  },

  // 获取公共回收站目录列表
  listPublicDirs: function() {
    return query(
      'SELECT * FROM deleted_public_dirs WHERE expires_at > ? ORDER BY deleted_at DESC',
      [new Date().toISOString()]
    );
  },

  // 获取公共回收站总数
  countPublicRecycle: function() {
    var fileCount = get(
      'SELECT COUNT(*) as count FROM deleted_public_files WHERE expires_at > ?',
      [new Date().toISOString()]
    );
    var dirCount = get(
      'SELECT COUNT(*) as count FROM deleted_public_dirs WHERE expires_at > ?',
      [new Date().toISOString()]
    );
    return {
      files: fileCount ? fileCount.count : 0,
      dirs: dirCount ? dirCount.count : 0,
      total: (fileCount ? fileCount.count : 0) + (dirCount ? dirCount.count : 0)
    };
  },

  // 恢复公共文件
  restorePublicFile: function(recycleId) {
    var file = get('SELECT * FROM deleted_public_files WHERE id = ?', [recycleId]);
    if (!file) return { ok: false, reason: 'file_not_found' };

    // 检查原路径是否有同名文件
    var targetDir = path.dirname(file.file_path);
    var existingName = path.join(targetDir, file.name);
    try {
      if (fs.existsSync(existingName)) {
        return { ok: false, reason: 'name_conflict', fileName: file.name };
      }
    } catch (e) {}

    // 恢复文件记录（移动回原路径）
    try {
      Storage.ensurePublicDir();
      var targetPath = file.file_path;
      fs.writeFileSync(targetPath, fs.readFileSync(file.storage_path));
    } catch (e) {
      return { ok: false, reason: 'restore_failed' };
    }

    // 删除回收站记录
    run('DELETE FROM deleted_public_files WHERE id = ?', [recycleId]);
    return { ok: true };
  },

  // 恢复公共目录
  restorePublicDir: function(recycleId) {
    var dir = get('SELECT * FROM deleted_public_dirs WHERE id = ?', [recycleId]);
    if (!dir) return { ok: false, reason: 'dir_not_found' };

    // 原路径
    var originalPath = dir.dir_path;

    // 检查原路径是否有同名目录（如果存在，说明之前已经被恢复过了或者有其他同名目录）
    if (fs.existsSync(originalPath)) {
      return { ok: false, reason: 'name_conflict', dirName: dir.name };
    }

    // 尝试找到重命名后的目录
    var deletedPath = null;

    // 如果有 deleted_path 列，直接使用
    if (dir.deleted_path) {
      deletedPath = dir.deleted_path;
    } else {
      // 兼容旧数据：尝试从目录名匹配 .delbak 后缀的文件
      // 查找公共目录下的匹配文件
      var parentDir = path.dirname(originalPath);
      try {
        if (fs.existsSync(parentDir)) {
          var files = fs.readdirSync(parentDir);
          var dirName = dir.name;
          // 匹配类似 "原名.seq.delbak" 的目录
          var regex = new RegExp('^' + preg_quote(dirName) + '\\.\\d+\\.delbak$');
          for (var i = 0; i < files.length; i++) {
            if (regex.test(files[i])) {
              deletedPath = path.join(parentDir, files[i]);
              break;
            }
          }
        }
      } catch (e) {}
    }

    if (!deletedPath || !fs.existsSync(deletedPath)) {
      return { ok: false, reason: 'restore_failed' };
    }

    // 重命名回原来的名字
    try {
      fs.renameSync(deletedPath, originalPath);
    } catch (err) {
      console.error('[RecycleBin] 恢复公共目录失败:', err);
      return { ok: false, reason: 'restore_failed' };
    }

    // 删除回收站记录
    run('DELETE FROM deleted_public_dirs WHERE id = ?', [recycleId]);
    return { ok: true };
  },

  // 永久删除公共回收站文件
  purgePublicFile: function(recycleId) {
    var file = get('SELECT * FROM deleted_public_files WHERE id = ?', [recycleId]);
    if (!file) return null;
    run('DELETE FROM deleted_public_files WHERE id = ?', [recycleId]);
    return file;
  },

  // 永久删除公共回收站目录
  purgePublicDir: function(recycleId) {
    var dir = get('SELECT * FROM deleted_public_dirs WHERE id = ?', [recycleId]);
    if (!dir) return null;
    run('DELETE FROM deleted_public_dirs WHERE id = ?', [recycleId]);
    return dir;
  },

  // 清空公共回收站
  emptyPublicAll: function() {
    var files = RecycleBin.listPublicFiles();
    var dirs = RecycleBin.listPublicDirs();
    run('DELETE FROM deleted_public_files');
    run('DELETE FROM deleted_public_dirs');
    return { files: files, dirs: dirs };
  },

  // 清理公共回收站过期项
  purgePublicExpired: function() {
    var now = new Date().toISOString();
    var expiredFiles = query('SELECT * FROM deleted_public_files WHERE expires_at <= ?', [now]);
    var expiredDirs = query('SELECT * FROM deleted_public_dirs WHERE expires_at <= ?', [now]);
    var count = 0;

    if (expiredFiles.length > 0) {
      run('DELETE FROM deleted_public_files WHERE expires_at <= ?', [now]);
      count += expiredFiles.length;
    }

    if (expiredDirs.length > 0) {
      run('DELETE FROM deleted_public_dirs WHERE expires_at <= ?', [now]);
      count += expiredDirs.length;
    }

    return { count: count, files: expiredFiles.length, dirs: expiredDirs.length };
  }
};

// ==================== 分享模块 ====================
var Share = {
  // 创建分享记录
  create: function(userId, targetType, targetId, targetName, expiresDays, password, targetIds, maxDownloads) {
    // 生成8位随机哈希作为分享码
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var hash = '';
    for (var i = 0; i < 8; i++) {
      hash += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 生成4位提取码（可为空）
    var extractionCode = '';
    if (password) {
      var codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrSTUVWXYZ23456789';
      for (var j = 0; j < 4; j++) {
        extractionCode += codeChars.charAt(Math.floor(Math.random() * codeChars.length));
      }
    }
    var now = new Date();
    var expiresAt = expiresDays > 0
      ? new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000).toISOString()
      : null; // null 表示永久有效

    var maxDl = (typeof maxDownloads === 'number' && maxDownloads >= 0) ? maxDownloads : 0;
    var targetIdsJson = targetIds ? JSON.stringify(targetIds) : '[]';
    var shareId = run(
      'INSERT INTO shares (user_id, share_hash, target_type, target_id, target_name, extraction_code, expires_at, created_at, target_ids, max_downloads) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, hash, targetType, targetId, targetName, extractionCode || null, expiresAt, now.toISOString(), targetIdsJson, maxDl]
    ).lastInsertRowid;

    return {
      id: shareId,
      hash: hash,
      extraction_code: extractionCode,
      expires_at: expiresAt,
      target_type: targetType,
      target_id: targetId,
      target_name: targetName,
      max_downloads: maxDl
    };
  },

  // 获取用户的所有分享记录
  list: function(userId) {
    var now = new Date().toISOString();
    var rows = query(
      'SELECT s.*, CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END as is_expired, u.nickname, u.email FROM shares s LEFT JOIN users u ON u.id = s.user_id WHERE s.user_id = ? ORDER BY s.created_at DESC',
      [now, userId]
    );
    return rows.map(function(row) {
      row.is_expired = !!row.is_expired;
      row.owner = row.nickname || row.email || '未知用户';
      return row;
    });
  },

  // 通过 hash 查找分享
  getByHash: function(hash) {
    return get('SELECT * FROM shares WHERE share_hash = ?', [hash]);
  },

  // 验证提取码
  verifyCode: function(hash, code) {
    var share = get('SELECT * FROM shares WHERE share_hash = ?', [hash]);
    if (!share) return { valid: false, reason: 'share_not_found' };
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return { valid: false, reason: 'share_expired' };
    }
    if (!share.extraction_code) {
      return { valid: true, share: share }; // 无需密码
    }
    if (share.extraction_code.toUpperCase() === (code || '').toUpperCase()) {
      return { valid: true, share: share };
    }
    return { valid: false, reason: 'wrong_code' };
  },

  // 删除分享
  delete: function(shareId, userId) {
    var share = get('SELECT * FROM shares WHERE id = ? AND user_id = ?', [shareId, userId]);
    if (!share) return false;
    run('DELETE FROM shares WHERE id = ?', [shareId]);
    return true;
  },

  // 检查分享是否有效（目标文件/目录是否还存在）
  checkValidity: function(share) {
    if (!share) return { valid: false, reason: 'share_not_found' };
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return { valid: false, reason: 'expired' };
    }
    // 检查下载次数限制（max_downloads=0 表示不限制）
    var maxDl = share.max_downloads || 0;
    var dlCount = share.download_count || 0;
    if (maxDl > 0 && dlCount >= maxDl) {
      return { valid: false, reason: 'download_limit_reached' };
    }
    if (share.target_type === 'public') {
      try {
        var fs = require('fs');
        var path = require('path');
        var sharePath = share.target_ids ? JSON.parse(share.target_ids || '[]')[0] || share.target_name : share.target_name;
        var fullPath = path.join(Storage.PUBLIC_DIR, sharePath);
        return { valid: fs.existsSync(fullPath), reason: fs.existsSync(fullPath) ? 'ok' : 'file_deleted' };
      } catch(e) { return { valid: false, reason: 'file_deleted' }; }
    }
    if (share.target_type === 'file') {
      var file = get('SELECT * FROM virtual_files WHERE id = ?', [share.target_id]);
      return { valid: !!file, reason: !!file ? 'ok' : 'file_deleted' };
    } else if (share.target_type === 'dir') {
      var dir = get('SELECT * FROM virtual_dirs WHERE id = ?', [share.target_id]);
      return { valid: !!dir, reason: !!dir ? 'ok' : 'dir_deleted' };
    } else if (share.target_type === 'mixed') {
      // 批量分享：至少一个目标还存在即有效
      var ids = [];
      try { ids = JSON.parse(share.target_ids || '[]'); } catch(e) {}
      for (var i = 0; i < ids.length; i++) {
        var f = get('SELECT id FROM virtual_files WHERE id = ?', [ids[i]]);
        if (f) return { valid: true, reason: 'ok' };
        var d = get('SELECT id FROM virtual_dirs WHERE id = ?', [ids[i]]);
        if (d) return { valid: true, reason: 'ok' };
      }
      return { valid: false, reason: 'file_deleted' };
    }
    return { valid: false, reason: 'unknown_type' };
  },

  // 获取分享的文件列表（对分享者本人也做权限检查）
  // share: 分享记录, subDirId: 可选，指定浏览哪个子目录（用于目录浏览）
  getShareItems: function(share, subDirId) {
    var items = [];

    // 批量分享（mixed）
    if (share.target_type === 'mixed') {
      var targetIds = [];
      try { targetIds = JSON.parse(share.target_ids || '[]'); } catch(e) {}
      targetIds.forEach(function(id) {
        // 尝试文件
        var f = get('SELECT * FROM virtual_files WHERE id = ?', [id]);
        if (f) {
          items.push({
            id: f.id, name: f.name, size: f.size, mime_type: f.mime_type,
            isDirectory: false, nonce: f.nonce, created_at: f.created_at
          });
          return;
        }
        // 尝试目录
        var d = get('SELECT * FROM virtual_dirs WHERE id = ?', [id]);
        if (d) {
          items.push({
            id: d.id, name: d.name, size: 0, mime_type: 'inode/directory',
            isDirectory: true, created_at: d.created_at
          });
        }
      });
      return items;
    }

    // 单文件分享
    if (share.target_type === 'file') {
      var file = get('SELECT * FROM virtual_files WHERE id = ?', [share.target_id]);
      if (file) {
        items.push({
          id: file.id, name: file.name, size: file.size, mime_type: file.mime_type,
          isDirectory: false, nonce: file.nonce, created_at: file.created_at
        });
      }
      return items;
    }

    // 目录分享：默认浏览根目录，或指定 subDirId 浏览子目录
    var dirId = parseInt(subDirId, 10) || parseInt(share.target_id, 10);
    var parentDir = get('SELECT * FROM virtual_dirs WHERE id = ?', [dirId]);

    // 获取当前目录下的子目录
    var subDirs = query('SELECT * FROM virtual_dirs WHERE parent_id = ? ORDER BY name', [dirId]);
    subDirs.forEach(function(d) {
      items.push({
        id: d.id, name: d.name, size: 0, mime_type: 'inode/directory',
        isDirectory: true, created_at: d.created_at
      });
    });
    // 获取当前目录下的文件
    var files = query('SELECT * FROM virtual_files WHERE dir_id = ? ORDER BY name', [dirId]);
    files.forEach(function(f) {
      items.push({
        id: f.id, name: f.name, size: f.size, mime_type: f.mime_type,
        isDirectory: false, nonce: f.nonce, created_at: f.created_at
      });
    });

    // 如果是子目录浏览，附加父目录信息（用于返回按钮）
    if (parentDir && parentDir.id !== parseInt(share.target_id, 10)) {
      items._parentDir = { id: parentDir.id, name: parentDir.name, parent_id: parentDir.parent_id };
    }
    return items;
  },

  // 获取分享信息（公开信息，不含敏感数据）
  getPublicInfo: function(share) {
    var validity = Share.checkValidity(share);
    var result = {
      hash: share.share_hash,
      target_type: share.target_type,
      target_name: share.target_name,
      has_password: !!share.extraction_code,
      is_expired: validity.reason === 'expired' || !validity.valid,
      invalid_reason: !validity.valid ? validity.reason : null,
      created_at: share.created_at,
      expires_at: share.expires_at,
      owner_id: share.user_id,
      item_count: 0
    };

    // 判断是否为目录类型
    if (share.target_type === 'dir' || share.target_type === 'file') {
      result.is_directory = share.target_type === 'dir';
    } else if (share.target_type === 'public') {
      try {
        var fs = require('fs');
        var path = require('path');
        var sharePath = share.target_ids ? JSON.parse(share.target_ids || '[]')[0] || share.target_name : share.target_name;
        var fullPath = path.join(Storage.PUBLIC_DIR, sharePath);
        result.is_directory = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
      } catch(e) { result.is_directory = false; }
    }

    // 统计项目数量
    if (share.target_type === 'file') {
      result.item_count = 1;
    } else if (share.target_type === 'dir') {
      var subDirs = query('SELECT COUNT(*) as cnt FROM virtual_dirs WHERE parent_id = ?', [share.target_id]);
      var files = query('SELECT COUNT(*) as cnt FROM virtual_files WHERE dir_id = ?', [share.target_id]);
      result.item_count = (subDirs[0] ? subDirs[0].cnt : 0) + (files[0] ? files[0].cnt : 0);
    } else if (share.target_type === 'public' && result.is_directory) {
      try {
        var fs2 = require('fs');
        var path2 = require('path');
        var sp = share.target_ids ? JSON.parse(share.target_ids || '[]')[0] || share.target_name : share.target_name;
        var fp = path2.join(Storage.PUBLIC_DIR, sp);
        result.item_count = fs2.readdirSync(fp).length;
      } catch(e) { result.item_count = 0; }
    } else if (share.target_type === 'public') {
      result.item_count = 1;
    }
    return result;
  }
};

// ==================== 分享访问日志 & 统计 ====================
var ShareAccessLog = {
  log: function(shareId, accessType, ip, userId, email, fileId, fileName) {
    var now = new Date().toISOString();
    run(
      'INSERT INTO share_access_logs (share_id, access_type, ip, user_id, email, file_id, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [shareId, accessType, ip || '', userId || 0, email || '', fileId || 0, fileName || '', now]
    );
  },

  listByShare: function(shareId, page, limit) {
    var offset = (page - 1) * limit;
    var logs = query(
      'SELECT * FROM share_access_logs WHERE share_id = ? ORDER BY created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      [shareId]
    );
    var total = get('SELECT COUNT(*) as count FROM share_access_logs WHERE share_id = ?', [shareId]);
    return { logs: logs, total: total ? total.count : 0 };
  },

  listAll: function(page, limit, filters) {
    var offset = (page - 1) * limit;
    var where = [];
    var params = [];
    if (filters && filters.share_id > 0) {
      where.push('sal.share_id = ?');
      params.push(filters.share_id);
    }
    if (filters && filters.ip) {
      where.push('sal.ip LIKE ?');
      params.push('%' + filters.ip + '%');
    }
    if (filters && filters.access_type) {
      where.push('sal.access_type = ?');
      params.push(filters.access_type);
    }
    if (filters && filters.start_date) {
      where.push('sal.created_at >= ?');
      params.push(filters.start_date);
    }
    if (filters && filters.end_date) {
      where.push('sal.created_at <= ?');
      params.push(filters.end_date);
    }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var logs = query(
      'SELECT sal.*, s.share_hash, s.target_name FROM share_access_logs sal LEFT JOIN shares s ON sal.share_id = s.id ' + whereStr + ' ORDER BY sal.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    var total = get('SELECT COUNT(*) as count FROM share_access_logs sal ' + whereStr, params);
    return { logs: logs, total: total ? total.count : 0 };
  }
};

// ==================== IP 黑名单 ====================
var IPBlacklist = {
  add: function(ip, reason, createdBy, expiresAt) {
    var now = new Date().toISOString();
    var result = run(
      'INSERT INTO ip_blacklist (ip, reason, created_by, created_at, expires_at, is_active, ban_level, auto_ban) VALUES (?, ?, ?, ?, ?, 1, 0, 0)',
      [ip, reason || '', createdBy || 0, now, expiresAt || null]
    );
    return result && result.lastInsertRowid ? result.lastInsertRowid : null;
  },

  remove: function(id) {
    return run('UPDATE ip_blacklist SET is_active = 0 WHERE id = ?', [id]);
  },

  delete: function(id) {
    return run('DELETE FROM ip_blacklist WHERE id = ?', [id]);
  },

  // 获取IP当前封禁级别（0=未封禁, 1-5=逐级递增）
  getBanLevel: function(ip) {
    var record = get('SELECT * FROM ip_blacklist WHERE ip = ? AND is_active = 1 AND auto_ban = 1', [ip]);
    if (!record) return 0;
    // 检查是否过期
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      run('UPDATE ip_blacklist SET is_active = 0 WHERE id = ?', [record.id]);
      return 0;
    }
    return record.ban_level || 1;
  },

  // 自动封禁：渐进式封禁
  // level: 1=1小时, 2=1天, 3=7天, 4=30天, 5=永久
  addAutoBan: function(ip, reason, currentLevel) {
    var now = new Date();
    var nextLevel = (currentLevel || 0) + 1;
    if (nextLevel > 5) nextLevel = 5;

    var banDurations = { 1: 1, 2: 24, 3: 24*7, 4: 24*30, 5: 0 }; // 小时，0=永久
    var expiresAt = null;
    if (banDurations[nextLevel] > 0) {
      expiresAt = new Date(now.getTime() + banDurations[nextLevel] * 60 * 60 * 1000).toISOString();
    }

    // 先禁用之前的自动封禁记录
    run('UPDATE ip_blacklist SET is_active = 0 WHERE ip = ? AND auto_ban = 1', [ip]);

    var banLabels = { 1: '1小时', 2: '1天', 3: '7天', 4: '30天', 5: '永久' };
    var fullReason = '自动封禁[L' + nextLevel + ']：' + (reason || '') + '，本次封禁' + banLabels[nextLevel];

    var result = run(
      'INSERT INTO ip_blacklist (ip, reason, created_by, created_at, expires_at, is_active, ban_level, auto_ban) VALUES (?, ?, ?, ?, ?, 1, ?, 1)',
      [ip, fullReason, 0, now.toISOString(), expiresAt, nextLevel]
    );
    return result && result.lastInsertRowid ? result.lastInsertRowid : null;
  },

  isBlocked: function(ip) {
    var now = new Date().toISOString();
    var record = get('SELECT * FROM ip_blacklist WHERE ip = ? AND is_active = 1', [ip]);
    if (!record) return false;
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      run('UPDATE ip_blacklist SET is_active = 0 WHERE id = ?', [record.id]);
      return false;
    }
    return true;
  },

  getAll: function(page, limit) {
    var offset = (page - 1) * limit;
    var records = query(
      'SELECT ib.*, u.email as created_by_email FROM ip_blacklist ib LEFT JOIN users u ON ib.created_by = u.id ORDER BY ib.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      []
    );
    var total = get('SELECT COUNT(*) as count FROM ip_blacklist WHERE is_active = 1');
    return { records: records, total: total ? total.count : 0 };
  }
};

// ==================== 分享统计 ====================
var ShareStats = {
  incrementView: function(shareId) {
    run('UPDATE shares SET view_count = view_count + 1 WHERE id = ?', [shareId]);
  },

  incrementDownload: function(shareId) {
    run('UPDATE shares SET download_count = download_count + 1 WHERE id = ?', [shareId]);
  },

  listAdmin: function(page, limit, userId, keyword) {
    var offset = (page - 1) * limit;
    var params = [];
    var where = [];
    if (userId > 0) {
      where.push('s.user_id = ?');
      params.push(userId);
    }
    if (keyword) {
      where.push('(s.target_name LIKE ? OR u.email LIKE ? OR s.share_hash LIKE ?)');
      var k = '%' + keyword + '%';
      params.push(k, k, k);
    }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var shares = query(
      'SELECT s.*, u.email as owner_email, u.nickname as owner_nickname FROM shares s LEFT JOIN users u ON s.user_id = u.id ' + whereStr + ' ORDER BY s.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    var total = get('SELECT COUNT(*) as count FROM shares s LEFT JOIN users u ON s.user_id = u.id ' + whereStr, params);
    return { shares: shares, total: total ? total.count : 0 };
  }
};

// ==================== 流量记录 ====================
var TrafficLog = {
  // 记录一条流量（由上层函数批量缓冲）
  log: function(userId, guestIp, actionType, fileId, fileName, fileSize, bytesCount) {
    var now = new Date().toISOString();
    run(
      'INSERT INTO traffic_logs (user_id, guest_ip, action_type, file_id, file_name, file_size, bytes_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId || 0, guestIp || '', actionType, fileId || 0, fileName || '', fileSize || 0, bytesCount || 0, now]
    );
  },

  // 批量插入（高效）
  logBatch: function(records) {
    records.forEach(function(r) {
      TrafficLog.log(r.user_id, r.guest_ip, r.action_type, r.file_id, r.file_name, r.file_size, r.bytes_count);
    });
  },

  // 按时间范围+类型获取流量列表
  list: function(opts) {
    opts = opts || {};
    var page = Math.max(1, opts.page || 1);
    var limit = Math.min(500, Math.max(1, opts.limit || 100));
    var offset = (page - 1) * limit;
    var where = [];
    var params = [];
    if (opts.user_id > 0) { where.push('tl.user_id = ?'); params.push(opts.user_id); }
    if (opts.guest_ip) { where.push('tl.guest_ip = ?'); params.push(opts.guest_ip); }
    if (opts.action_type) { where.push('tl.action_type = ?'); params.push(opts.action_type); }
    if (opts.start_date) { where.push('tl.created_at >= ?'); params.push(opts.start_date); }
    if (opts.end_date) {
      // end_date 默认加 23:59:59，确保包含当天所有记录
      var endDt = opts.end_date;
      if (endDt.length === 10) { endDt += ' 23:59:59'; }
      where.push('tl.created_at <= ?'); params.push(endDt);
    }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    var logs = query(
      'SELECT tl.*, u.email FROM traffic_logs tl LEFT JOIN users u ON tl.user_id = u.id ' + whereStr + ' ORDER BY tl.created_at DESC LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    var total = get('SELECT COUNT(*) as count FROM traffic_logs tl ' + whereStr, params);
    return { logs: logs, total: total ? total.count : 0 };
  },

  // 汇总统计（用户维度）
  summaryByUser: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];
    var groupBy = 'tl.user_id';
    if (opts.start_date) { where.push('tl.created_at >= ?'); params.push(opts.start_date); }
    if (opts.end_date) {
      // end_date 默认加 23:59:59，确保包含当天所有记录
      var endDt = opts.end_date;
      if (endDt.length === 10) { endDt += ' 23:59:59'; }
      where.push('tl.created_at <= ?'); params.push(endDt);
    }
    if (opts.is_guest) { groupBy = 'tl.guest_ip'; }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    return query(
      'SELECT ' + groupBy + ' as key_id, SUM(tl.bytes_count) as total_bytes, COUNT(*) as record_count, tl.action_type FROM traffic_logs tl ' + whereStr + ' GROUP BY ' + groupBy + ', tl.action_type ORDER BY total_bytes DESC',
      params
    );
  },

  // 获取指定用户的月度流量
  getMonthlyTotal: function(userId, yearMonth) {
    var result = get(
      'SELECT SUM(bytes_count) as total FROM traffic_logs WHERE user_id = ? AND created_at LIKE ?',
      [userId, yearMonth + '%']
    );
    return result ? (result.total || 0) : 0;
  },

  // 获取访客IP的月度流量
  getGuestMonthlyTotal: function(guestIp, yearMonth) {
    var result = get(
      'SELECT SUM(bytes_count) as total FROM traffic_logs WHERE guest_ip = ? AND user_id = 0 AND created_at LIKE ?',
      [guestIp, yearMonth + '%']
    );
    return result ? (result.total || 0) : 0;
  },

  // 每日汇总
  dailySummary: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];
    if (opts.user_id > 0) { where.push('user_id = ?'); params.push(opts.user_id); }
    if (opts.guest_ip) { where.push('guest_ip = ?'); params.push(opts.guest_ip); }
    if (opts.start_date) { where.push('created_at >= ?'); params.push(opts.start_date); }
    if (opts.end_date) {
      var endDt = opts.end_date;
      if (endDt.length === 10) { endDt += ' 23:59:59'; }
      where.push('created_at <= ?'); params.push(endDt);
    }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    return query(
      'SELECT DATE(created_at) as date, action_type, SUM(bytes_count) as bytes, COUNT(*) as cnt FROM traffic_logs ' + whereStr + ' GROUP BY DATE(created_at), action_type ORDER BY date DESC',
      params
    );
  },

  // 月度汇总
  monthlySummary: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];
    if (opts.user_id > 0) { where.push('user_id = ?'); params.push(opts.user_id); }
    if (opts.guest_ip) { where.push('guest_ip = ?'); params.push(opts.guest_ip); }
    if (opts.start_month) { where.push('created_at >= ?'); params.push(opts.start_month + '-01'); }
    if (opts.end_month) { where.push('created_at <= ?'); params.push(opts.end_month + '-31'); }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    return query(
      'SELECT strftime("%Y-%m", created_at) as month, action_type, SUM(bytes_count) as bytes, COUNT(*) as cnt FROM traffic_logs ' + whereStr + ' GROUP BY strftime("%Y-%m", created_at), action_type ORDER BY month DESC',
      params
    );
  },

  // 年度汇总
  yearlySummary: function(opts) {
    opts = opts || {};
    var where = [];
    var params = [];
    if (opts.user_id > 0) { where.push('user_id = ?'); params.push(opts.user_id); }
    if (opts.guest_ip) { where.push('guest_ip = ?'); params.push(opts.guest_ip); }
    if (opts.start_year) { where.push('created_at >= ?'); params.push(opts.start_year + '-01-01'); }
    if (opts.end_year) { where.push('created_at <= ?'); params.push(opts.end_year + '-12-31'); }
    var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    return query(
      'SELECT strftime("%Y", created_at) as year, action_type, SUM(bytes_count) as bytes, COUNT(*) as cnt FROM traffic_logs ' + whereStr + ' GROUP BY strftime("%Y", created_at), action_type ORDER BY year DESC',
      params
    );
  }
};

// ==================== 离线下载 ====================
var OfflineDownload = {
  // 创建下载任务
  create: function(userId, url, filename, mimeType, targetDirId) {
    var result = run('INSERT INTO offline_downloads (user_id, url, filename, mime_type, target_dir_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, url, filename, mimeType || 'application/octet-stream', targetDirId || 0, 'pending']);
    if (!result || !result.lastInsertRowid) {
      console.log('[OfflineDownload.create] 获取插入ID失败, result:', result);
      return null;
    }
    return get('SELECT * FROM offline_downloads WHERE id = ?', [result.lastInsertRowid]);
  },

  // 获取用户的下载任务列表
  listByUser: function(userId) {
    return query('SELECT * FROM offline_downloads WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  // 获取单个任务
  findById: function(id, userId) {
    return get('SELECT * FROM offline_downloads WHERE id = ? AND user_id = ?', [id, userId]);
  },

  // 更新进度
  updateProgress: function(id, downloadedBytes, totalBytes, speedBps) {
    var progress = totalBytes > 0 ? (downloadedBytes / totalBytes * 100) : 0;
    run('UPDATE offline_downloads SET downloaded_bytes = ?, total_bytes = ?, progress = ?, speed_bps = ? WHERE id = ?',
      [downloadedBytes, totalBytes, Math.round(progress * 100) / 100, speedBps || 0, id]);
  },

  // 更新状态
  updateStatus: function(id, status, error) {
    if (status === 'completed') {
      run('UPDATE offline_downloads SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]);
    } else {
      run('UPDATE offline_downloads SET status = ?, error = ? WHERE id = ?', [status, error || '', id]);
    }
  },

  // 标记为下载中
  markDownloading: function(id) {
    run('UPDATE offline_downloads SET status = ? WHERE id = ?', ['downloading', id]);
  },

  // 删除任务
  delete: function(id, userId) {
    run('DELETE FROM offline_downloads WHERE id = ? AND user_id = ?', [id, userId]);
  },

  // 获取进行中的任务（用于后台恢复下载）
  listActive: function() {
    return query("SELECT * FROM offline_downloads WHERE status IN ('downloading','paused')");
  },

  // 内部方法：更新任务的 URL（用于重定向跟随后记录最终 URL）
  _updateUrl: function(id, newUrl) {
    return run('UPDATE offline_downloads SET url = ? WHERE id = ?', [newUrl, id]);
  }
};

// ==================== 用户流量配额 ====================
// 独立表存储用户和访客的流量配额与使用量，每月自动重置
var TrafficQuota = {
  // 获取当前周期的配额记录（用户或访客）
  // isGuest=true时 userId 被忽略，用 guestIp 标识
  get: function(userId, guestIp, isGuest) {
    var now = new Date();
    var period = now.toISOString().substring(0, 7); // YYYY-MM
    var resetAt = now.toISOString();
    // 下个月1号0点
    var nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    resetAt = nextMonth.toISOString();

    if (isGuest) {
      // 访客
      var row = get('SELECT * FROM user_traffic_quotas WHERE guest_ip = ? AND period = ?', [guestIp, period]);
      if (!row) {
        // 首次访问，创建记录
        var result = run(
          'INSERT INTO user_traffic_quotas (user_id, guest_ip, quota_bytes, used_bytes, period, reset_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [0, guestIp, 1073741824, 0, period, resetAt, now.toISOString()]
        );
        if (result && result.lastInsertRowid) {
          return { user_id: 0, guest_ip: guestIp, quota_bytes: 1073741824, used_bytes: 0, period: period, reset_at: resetAt };
        }
      }
      return row || { quota_bytes: 1073741824, used_bytes: 0, period: period, reset_at: resetAt };
    } else {
      // 注册用户
      var row2 = get('SELECT * FROM user_traffic_quotas WHERE user_id = ? AND guest_ip = "" AND period = ?', [userId, period]);
      if (!row2) {
        // 首次，插入新记录
        var result2 = run(
          'INSERT INTO user_traffic_quotas (user_id, guest_ip, quota_bytes, used_bytes, period, reset_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [userId, '', 10737418240, 0, period, resetAt, now.toISOString()]
        );
        if (result2 && result2.lastInsertRowid) {
          return { user_id: userId, guest_ip: '', quota_bytes: 10737418240, used_bytes: 0, period: period, reset_at: resetAt };
        }
      }
      return row2 || { user_id: userId, guest_ip: '', quota_bytes: 10737418240, used_bytes: 0, period: period, reset_at: resetAt };
    }
  },

  // 增加已使用流量
  addUsed: function(userId, guestIp, isGuest, bytes) {
    if (bytes <= 0) return;
    var info = TrafficQuota.get(userId, guestIp, isGuest);
    var p = info.period;
    if (isGuest) {
      run('UPDATE user_traffic_quotas SET used_bytes = used_bytes + ? WHERE guest_ip = ? AND period = ?', [bytes, guestIp, p]);
    } else {
      run('UPDATE user_traffic_quotas SET used_bytes = used_bytes + ? WHERE user_id = ? AND guest_ip = "" AND period = ?', [bytes, userId, p]);
    }
  },

  // 检查是否超限
  checkLimit: function(userId, guestIp, isGuest, bytesToAdd) {
    var info = TrafficQuota.get(userId, guestIp, isGuest);
    return (info.used_bytes + bytesToAdd) <= info.quota_bytes;
  },

  // 设置配额上限
  setQuota: function(userId, guestIp, isGuest, quotaBytes) {
    var info = TrafficQuota.get(userId, guestIp, isGuest);
    var p = info.period;
    if (isGuest) {
      run('UPDATE user_traffic_quotas SET quota_bytes = ? WHERE guest_ip = ? AND period = ?', [quotaBytes, guestIp, p]);
    } else {
      run('UPDATE user_traffic_quotas SET quota_bytes = ? WHERE user_id = ? AND guest_ip = "" AND period = ?', [quotaBytes, userId, p]);
    }
  },

  // 列出当前周期所有用户配额（含访客）
  listAll: function(period) {
    var p = period || new Date().toISOString().substring(0, 7);
    var rows = query(
      'SELECT utq.*, u.email, u.nickname FROM user_traffic_quotas utq LEFT JOIN users u ON utq.user_id = u.id WHERE utq.period = ? ORDER BY utq.used_bytes DESC',
      [p]
    );
    return rows;
  },

  // 获取某用户所有历史记录
  listByUser: function(userId) {
    return query('SELECT * FROM user_traffic_quotas WHERE user_id = ? ORDER BY period DESC', [userId]);
  },

  // 获取某访客IP所有历史记录
  listByGuestIp: function(guestIp) {
    return query('SELECT * FROM user_traffic_quotas WHERE guest_ip = ? ORDER BY period DESC', [guestIp]);
  },

  // 重置某周期的所有配额（由定时任务调用）
  resetPeriod: function(period) {
    run('UPDATE user_traffic_quotas SET used_bytes = 0, reset_at = ? WHERE period = ?',
      [new Date().toISOString(), period]);
  }
};

// ==================== WebDAV 链接管理 ====================
var WebDAVLink = {
  create: function(userId, targetPath, targetName, isDirectory, expiresDays, requireAuth, targetType) {
    var token = '';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    for (var i = 0; i < 32; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
    var now = new Date();
    var expiresAt = new Date(now.getTime() + (expiresDays || 180) * 24 * 3600 * 1000).toISOString();
    run(
      'INSERT INTO webdav_links (user_id, token, target_path, target_name, is_directory, expires_at, created_at, require_auth, target_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, token, targetPath, targetName, isDirectory ? 1 : 0, expiresAt, now.toISOString(), requireAuth ? 1 : 0, targetType || 'public']
    );
    return { token: token, expires_at: expiresAt, require_auth: requireAuth ? 1 : 0, target_type: targetType || 'public' };
  },

  listByUser: function(userId) {
    return query('SELECT * FROM webdav_links WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  findByToken: function(token) {
    return get('SELECT * FROM webdav_links WHERE token = ?', [token]);
  },

  findByUserAndToken: function(userId, token) {
    return get('SELECT * FROM webdav_links WHERE user_id = ? AND token = ?', [userId, token]);
  },

  reveal: function(id) {
    run('UPDATE webdav_links SET is_revealed = 1 WHERE id = ?', [id]);
  },

  touchAccess: function(id) {
    run('UPDATE webdav_links SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      [new Date().toISOString(), id]);
  },

  delete: function(id, userId) {
    return run('DELETE FROM webdav_links WHERE id = ? AND user_id = ?', [id, userId]).changes > 0;
  },

  checkExpired: function(link) {
    if (!link) return true;
    if (link.expires_at && new Date(link.expires_at) < new Date()) return true;
    return false;
  }
};

// ==================== 存储架构 V2: FileStorage ====================
var FileStorage = {
  // 创建文件存储实体（返回 id）
  create: function(uuid, fileHash, fileSize, plaintextSize, encVersion, isEncrypted, nonce) {
    var result = run(
      'INSERT INTO file_storage (uuid, file_hash, file_size, plaintext_size, ref_count, enc_version, is_encrypted, nonce) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      [uuid, fileHash, fileSize, plaintextSize, encVersion || 1, isEncrypted ? 1 : 0, nonce || null]
    );
    return result.lastInsertRowid;
  },

  // 按 hash+size 查找（防碰撞双重匹配）
  findByHashAndSize: function(fileHash, fileSize) {
    return get('SELECT * FROM file_storage WHERE file_hash = ? AND file_size = ? AND status = ?',
      [fileHash, fileSize, 'active']);
  },

  findById: function(id) {
    return get('SELECT * FROM file_storage WHERE id = ?', [id]);
  },

  // 增加引用计数
  incrementRef: function(id) {
    return run('UPDATE file_storage SET ref_count = ref_count + 1 WHERE id = ?', [id]);
  },

  // 减少引用计数，返回新的 ref_count
  decrementRef: function(id) {
    var result = run('UPDATE file_storage SET ref_count = MAX(0, ref_count - 1) WHERE id = ?', [id]);
    var fs = get('SELECT ref_count FROM file_storage WHERE id = ?', [id]);
    return fs ? fs.ref_count : 0;
  },

  // 获取文件的所有有效存储路径
  getValidPaths: function(storageId) {
    var paths = query(
      'SELECT fsp.*, sp.local_path FROM file_storage_paths fsp ' +
      'LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
      'WHERE fsp.storage_id = ? AND fsp.status = ? AND (sp.status IS NULL OR sp.status = ?)',
      [storageId, 'active', 'active']
    );
    var fs = require('fs');
    var pathLib = require('path');
    return paths.filter(function(p) {
      var checkPath = p.full_path;
      // full_path 可能是相对路径，拼上池路径
      if (checkPath && !pathLib.isAbsolute(checkPath) && p.local_path) {
        checkPath = pathLib.join(p.local_path, checkPath);
      }
      try { return fs.existsSync(checkPath); } catch(e) { return false; }
    });
  },

  // 检查是否存在至少一个可读路径
  hasValidPath: function(storageId) {
    var paths = FileStorage.getValidPaths(storageId);
    return paths.length > 0;
  },

  // 获取第一个可读路径，并返回文件统计信息
  getReadableFile: function(storageId) {
    var paths = FileStorage.getValidPaths(storageId);
    if (paths.length === 0) return null;
    var fs = require('fs');
    var p = paths[0];
    try {
      var st = fs.statSync(p.full_path);
      return { path: p.full_path, poolId: p.pool_id, size: st.size };
    } catch(e) {
      // 尝试下一个路径
      for (var i = 1; i < paths.length; i++) {
        try { var st2 = fs.statSync(paths[i].full_path); return { path: paths[i].full_path, poolId: paths[i].pool_id, size: st2.size }; }
        catch(e2) {}
      }
      return null;
    }
  },

  // 添加文件存储路径（去重：同一 storage+pool 已有记录则更新）
  addPath: function(storageId, poolId, relativePath, fullPath) {
    var existing = get(
      'SELECT id FROM file_storage_paths WHERE storage_id = ? AND pool_id = ?',
      [storageId, poolId]
    );
    if (existing) {
      return run(
        "UPDATE file_storage_paths SET relative_path = ?, full_path = ?, status = 'active' WHERE id = ?",
        [relativePath, fullPath, existing.id]
      );
    }
    return run(
      'INSERT INTO file_storage_paths (storage_id, pool_id, relative_path, full_path) VALUES (?, ?, ?, ?)',
      [storageId, poolId, relativePath, fullPath]
    );
  },

  // 删除某个存储路径
  removePath: function(pathId) {
    return run("UPDATE file_storage_paths SET status = 'deleted' WHERE id = ?", [pathId]);
  },

  // 迁移某个文件的所有引用到新的 storage_id
  migrateAllRefs: function(oldStorageId, newStorageId) {
    // 更新 user_file_refs
    run('UPDATE user_file_refs SET storage_id = ? WHERE storage_id = ?', [newStorageId, oldStorageId]);
    // 更新 virtual_files
    run('UPDATE virtual_files SET storage_id = ? WHERE storage_id = ?', [newStorageId, oldStorageId]);
    // 标记旧文件为待清理
    run("UPDATE file_storage SET status = 'deprecated' WHERE id = ?", [oldStorageId]);
  },

  // 查找 ref_count=0 的待清理文件
  findOrphansForCleanup: function(limit) {
    return query(
      "SELECT * FROM file_storage WHERE ref_count = 0 AND status IN ('active', 'deprecated') ORDER BY created_at LIMIT ?",
      [limit || 500]
    );
  },

  // 查找 ref_count=0 且创建超过指定小时的文件
  findOrphansForCleanupByAge: function(hours, limit) {
    return query(
      "SELECT * FROM file_storage WHERE ref_count = 0 AND status IN ('active', 'deprecated') " +
      "AND created_at < datetime('now', '-" + Number(hours) + " hours') ORDER BY created_at LIMIT ?",
      [limit || 500]
    );
  },

  // 查找丢失文件：有引用但所有路径都不可访问
  getLostFiles: function() {
    var db = require('../lib/db');
    var files = db.query(
      'SELECT fs.id, fs.uuid, fs.file_hash, fs.file_size, fs.ref_count, fs.created_at ' +
      'FROM file_storage fs WHERE fs.ref_count > 0 AND fs.status = ? ' +
      'ORDER BY fs.id', ['active']
    );
    var lost = [];
    var fsCheck = require('fs');
    files.forEach(function(f) {
      var paths = StoragePool.getReadPaths(f.id);
      if (paths.length === 0) {
        lost.push({ id: f.id, uuid: f.uuid, hash: (f.file_hash||''), size: f.file_size, ref_count: f.ref_count, created_at: f.created_at, reason:'no_paths' });
      } else {
        var anyAccessible = paths.some(function(p) {
          var checkPath = p.full_path;
          // relative path: join with pool local_path
          if (checkPath && !checkPath.match(/^[A-Za-z]:/) && p.local_path) {
            checkPath = require('path').join(p.local_path, checkPath);
          }
          try { return fsCheck.existsSync(checkPath); } catch(e) { return false; }
        });
        if (!anyAccessible) {
          lost.push({ id: f.id, uuid: f.uuid, hash: (f.file_hash||''), size: f.file_size, ref_count: f.ref_count, created_at: f.created_at, reason:'all_inaccessible' });
        }
      }
    });
    return lost;
  },

  // 物理删除文件存储记录
  delete: function(id) {
    run('DELETE FROM file_storage_paths WHERE storage_id = ?', [id]);
    run('DELETE FROM file_storage WHERE id = ?', [id]);
  },

  // 统计文件引用情况
  stats: function() {
    var total = get('SELECT COUNT(*) as cnt, SUM(ref_count) as total_refs, SUM(file_size) as total_bytes FROM file_storage WHERE status = ?', ['active']);
    return {
      fileCount: total ? total.cnt : 0,
      totalRefs: total ? total.total_refs : 0,
      totalBytes: total ? total.total_bytes : 0
    };
  },

  // 列出某个文件的所有引用用户
  listRefUsers: function(storageId) {
    return query(
      'SELECT ufr.id, ufr.user_id, ufr.name, u.email FROM user_file_refs ufr LEFT JOIN users u ON ufr.user_id = u.id WHERE ufr.storage_id = ?',
      [storageId]
    );
  },

  // 列出所有文件引用（管理员用）
  listAll: function(limit, offset) {
    return query(
      'SELECT fs.*, ' +
      'GROUP_CONCAT(u.email) as user_emails ' +
      'FROM file_storage fs ' +
      'LEFT JOIN user_file_refs ufr ON fs.id = ufr.storage_id ' +
      'LEFT JOIN users u ON ufr.user_id = u.id ' +
      'WHERE fs.status = ? ' +
      'GROUP BY fs.id ORDER BY fs.created_at DESC LIMIT ? OFFSET ?',
      ['active', limit || 50, offset || 0]
    );
  }
};

// ==================== 存储架构 V2: StoragePool ====================
var StoragePool = {
  // 获取默认存储池路径（优先活跃池，回退到 userdata 目录）
  getDefaultPath: function() {
    var pool = get("SELECT local_path FROM storage_pools WHERE status = 'active' ORDER BY group_id, mirror_index LIMIT 1");
    var path = require('path');
    return pool ? pool.local_path : path.join(__dirname, '..', 'files', 'userdata');
  },

  // 获取所有可写入的均衡组（排除锁定/停用/处理中的组）
  getBalancedGroups: function() {
    return query(
      "SELECT group_id, COUNT(*) as path_count FROM storage_pools WHERE status = 'active' GROUP BY group_id ORDER BY group_id"
    );
  },

  // 获取所有均衡组（含停用，用于读取）
  getAllGroups: function() {
    return query(
      "SELECT group_id, COUNT(*) as path_count FROM storage_pools WHERE status IN ('active','disabled','disabled_migrated') GROUP BY group_id ORDER BY group_id"
    );
  },

  // 按权重选择写入组（只在 storage_groups.status='active' 的组中选择）
  selectWriteGroup: function() {
    var db2 = require('../lib/db');
    var balanced = StoragePool.getBalancedGroups();
    console.log('[selectWriteGroup] balanced groups:', JSON.stringify(balanced));
    // 过滤：组本身必须 active
    var groups = balanced.filter(function(g) {
      var grp = db2.get("SELECT status FROM storage_groups WHERE group_id = ? AND status = 'active'", [g.group_id]);
      return !!grp;
    });
    console.log('[selectWriteGroup] after group filter:', JSON.stringify(groups));
    if (groups.length === 0) { console.log('[selectWriteGroup] NO WRITABLE GROUP'); return null; }
    if (groups.length === 1) return groups[0];

    // 获取各组权重
    var db2 = require('../lib/db');
    var weights = {};
    var gnRows = db2.query('SELECT group_id, weight FROM storage_groups WHERE status = ?', ['active']);
    gnRows.forEach(function(r) { weights[r.group_id] = r.weight || 5; });

    // 加权随机选择
    var totalWeight = 0;
    groups.forEach(function(g) { totalWeight += weights[g.group_id] || 5; });
    var rand = Math.random() * totalWeight;
    var cumulative = 0;
    for (var i = 0; i < groups.length; i++) {
      cumulative += weights[groups[i].group_id] || 5;
      if (rand <= cumulative) return groups[i];
    }
    return groups[groups.length - 1];
  },

  // 检查是否有可写入的均衡组
  hasWritableGroup: function() {
    var groups = StoragePool.getBalancedGroups();
    return groups.length > 0;
  },

  // 获取所有被锁定的均衡组信息（用于错误提示）
  getLockedGroups: function() {
    return query(
      "SELECT group_id, status, local_path FROM storage_pools WHERE status IN ('processing','syncing','disabled','disabled_migrated') ORDER BY group_id"
    );
  },

  // 检查写入锁：有可写均衡组返回 null，全部锁死返回错误消息
  checkWriteLock: function() {
    if (StoragePool.hasWritableGroup()) return null;
    var locked = StoragePool.getLockedGroups();
    var reasons = locked.map(function(g) {
      var reason = g.status === 'processing' ? '维护中' : g.status === 'syncing' ? '同步中' : g.status === 'disabled' ? '已停用' : '待删除';
      return '组#' + g.group_id + '(' + reason + ')';
    });
    return '所有均衡组均不可写入: ' + (reasons.length > 0 ? reasons.join(', ') : '无可用均衡组') + '。服务器维护中，请稍后重试';
  },

  // 统一锁管理：锁住整个均衡组所有路径
  lockGroup: function(groupId, status) {
    status = status || 'processing';
    return require('../lib/db').run(
      "UPDATE storage_pools SET status = ? WHERE group_id = ? AND status = 'active'",
      [status, groupId]
    );
  },

  // 统一解锁：检查均衡组是否可以解锁（无进行中任务则恢复active）
  unlockGroup: function(groupId) {
    var db = require('../lib/db');
    // 检查是否有该组的进行中任务
    var runningTasks = db.get(
      "SELECT COUNT(*) as cnt FROM async_tasks WHERE status IN ('running','pending') AND (json_extract(metadata, '$.group_id') = ?)",
      [groupId]
    );
    var hasRunning = runningTasks && runningTasks.cnt > 0;
    if (hasRunning) return false; // 还有进行中任务，不解锁

    // 检查该组路径是否都是 syncing/processing（锁状态）
    var lockedPaths = db.get(
      "SELECT COUNT(*) as cnt FROM storage_pools WHERE group_id = ? AND status IN ('processing','syncing')",
      [groupId]
    );
    if (lockedPaths && lockedPaths.cnt > 0) {
      // 解锁所有被锁路径
      db.run(
        "UPDATE storage_pools SET status = 'active' WHERE group_id = ? AND status IN ('processing','syncing')",
        [groupId]
      );
      console.log('[StoragePool] 解锁均衡组#' + groupId + ' (' + lockedPaths.cnt + '个路径)');
      return true;
    }
    return false;
  },

  // 任务完成/取消时统一调用：重新评估并更新锁状态
  syncGroupLock: function(groupId) {
    var db = require('../lib/db');
    var running = db.get(
      "SELECT COUNT(*) as cnt FROM async_tasks WHERE status IN ('running','pending') AND (json_extract(metadata, '$.group_id') = ? OR json_extract(metadata, '$.target_groups') LIKE '%' || ? || '%')",
      [groupId, groupId]
    );
    if (running && running.cnt > 0) return;
    StoragePool.unlockGroup(groupId);
  },

  // 标记路径为降级（镜像损坏，不影响写入）
  markDegraded: function(poolId) {
    return require('../lib/db').run(
      "UPDATE storage_pools SET status = 'degraded', priority = 1 WHERE id = ?",
      [poolId]
    );
  },

  // 恢复路径为正常
  markHealthy: function(poolId) {
    return require('../lib/db').run(
      "UPDATE storage_pools SET status = 'active', priority = 5 WHERE id = ?",
      [poolId]
    );
  },

  // 获取路径权重（1-10）
  getWeight: function(poolId) {
    var pool = require('../lib/db').get('SELECT priority FROM storage_pools WHERE id = ?', [poolId]);
    return pool && pool.priority ? pool.priority : 5;
  },

  // 全组健康检查（1分钟定时调用）
  runHealthCheck: function() {
    var db = require('../lib/db');
    var fs = require('fs');
    var pathLib = require('path');
    var allPools = StoragePool.listAll();
    var groups = {};
    allPools.forEach(function(p) { if (!groups[p.group_id]) groups[p.group_id] = []; groups[p.group_id].push(p); });

    // 已通知记录：避免重复告警（poolId -> lastNotifyTime）30分钟内不重复
    if (!StoragePool._notifiedPools) StoragePool._notifiedPools = {};

    var alerts = []; // 本轮新产生的告警

    Object.keys(groups).forEach(function(gid) {
      var groupId = parseInt(gid);
      var paths = groups[groupId];
      var hasRunningTask = db.get(
        "SELECT COUNT(*) as cnt FROM async_tasks WHERE status IN ('running','pending') AND (json_extract(metadata, '$.group_id') = ?)",
        [groupId]
      );
      var running = hasRunningTask && hasRunningTask.cnt > 0;

      paths.forEach(function(p) {
        // 跳过已删除/停用/迁移完成的
        if (p.status === 'deleted' || p.status === 'disabled_migrated') return;
        if (p.status === 'disabled') return;

        // 检查路径是否可访问
        var accessible = false;
        try { accessible = fs.existsSync(p.local_path) && fs.statSync(p.local_path).isDirectory(); } catch(e) {}

        if (!accessible && p.status === 'active') {
          // 路径挂了→降级并降权
          StoragePool.markDegraded(p.id);
          // 降低整组权重为 1
          db.run('UPDATE storage_groups SET weight = 1 WHERE group_id = ? AND weight > 1', [groupId]);
          console.log('[HealthCheck] 路径降级+降权: group=' + groupId + ' mirror=' + p.mirror_index + ' path=' + p.local_path);

          // 新告警：30分钟内未通知过
          var now = Date.now();
          var lastNotify = StoragePool._notifiedPools[p.id] || 0;
          if (now - lastNotify > 30 * 60 * 1000) {
            StoragePool._notifiedPools[p.id] = now;
            alerts.push({
              poolId: p.id, groupId: groupId, name: p.name || ('镜像' + p.mirror_index),
              path: p.local_path, status: 'degraded', reason: '路径不可访问（磁盘断开/权限变更/目录被删除）'
            });
          }
        } else if (accessible && p.status === 'degraded') {
          // 路径恢复了 → 恢复权重
          StoragePool.markHealthy(p.id);
          // 恢复整组权重为默认 5（如果组内无其他降级镜像）
          var degradedInGroup = paths.filter(function(pp) { return pp.id !== p.id && pp.status === 'degraded'; });
          if (degradedInGroup.length === 0) {
            db.run('UPDATE storage_groups SET weight = 5 WHERE group_id = ? AND weight = 1', [groupId]);
          }
          console.log('[HealthCheck] 路径恢复: group=' + groupId + ' mirror=' + p.mirror_index + ' path=' + p.local_path);
        }

        // 锁状态检查：无运行任务且可访问→恢复active
        if (!running && accessible && (p.status === 'processing' || p.status === 'syncing')) {
          db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [p.id]);
          console.log('[HealthCheck] 恢复路径状态: group=' + groupId + ' id=' + p.id + ' → active');
        }
      });

      // 检查 stopping→stopped 转换
      var stoppingPaths = paths.filter(function(p) { return p.status === 'stopping'; });
      if (stoppingPaths.length > 0) {
        var StorageStream = require('./storage-stream');
        StorageStream.checkStoppingGroup(groupId);
      }

      // 检查整组是否全部不可用
      var allDown = paths.every(function(p) {
        if (p.status === 'deleted' || p.status === 'disabled_migrated') return false;
        try { return !fs.existsSync(p.local_path); } catch(e) { return true; }
      });
      var anyActive = paths.some(function(p) { return p.status === 'active' || p.status === 'degraded'; });
      if (allDown && anyActive) {
        paths.forEach(function(p) {
          if (p.status === 'active' || p.status === 'degraded') {
            db.run("UPDATE storage_pools SET status = 'error' WHERE id = ?", [p.id]);
          }
        });
        console.log('[HealthCheck] 均衡组#' + groupId + ' 全部路径不可用→标记error');
      }
    });

    // 发送邮件告警（异步，不阻塞健康检查）
    if (alerts.length > 0) {
      sendStorageAlerts(alerts);
    }
  },

  // 获取指定均衡组的所有路径（用于写入）
  getWritePathsForGroup: function(groupId) {
    return query(
      'SELECT * FROM storage_pools WHERE group_id = ? AND status = ? ORDER BY mirror_index',
      [groupId, 'active']
    );
  },

  // 获取文件可用的读取路径（均衡选择）
  getReadPaths: function(storageId) {
    // 返回所有可用路径（active/degraded/disabled，排除已删除和处理中的）
    var paths = query(
      'SELECT fsp.*, sp.local_path, sp.mirror_index, sp.group_id, sp.status as pool_status, sp.priority as weight ' +
      'FROM file_storage_paths fsp ' +
      'LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
      'WHERE fsp.storage_id = ? AND fsp.status = ? AND sp.status IN (?,?,?) ' +
      'ORDER BY sp.group_id, sp.priority DESC, sp.mirror_index',
      [storageId, 'active', 'active', 'degraded', 'disabled']
    );
    return paths;
  },

  // 按权重选择最佳读取路径（跳过不可访问的）
  selectBestReadPath: function(storageId) {
    var paths = StoragePool.getReadPaths(storageId);
    var fs = require('fs');
    for (var i = 0; i < paths.length; i++) {
      try {
        if (fs.existsSync(paths[i].full_path)) return paths[i];
      } catch(e) {}
    }
    return null; // 全部不可用
  },

  // 获取所有活跃的存储池
  listAll: function() {
    return query(
      'SELECT * FROM storage_pools WHERE status != ? ORDER BY group_id, mirror_index',
      ['deleted']
    );
  },

  // 列出可管理的均衡组（用于管理页面）
  listGroups: function() {
    return query(
      'SELECT group_id, COUNT(*) as mirror_count, SUM(total_bytes) as group_total, SUM(used_bytes) as group_used ' +
      'FROM storage_pools WHERE status != ? GROUP BY group_id ORDER BY group_id',
      ['deleted']
    );
  },

  // 添加路径到指定均衡组
  addPath: function(localPath, groupId, mirrorIndex) {
    return run(
      'INSERT INTO storage_pools (local_path, group_id, mirror_index, status) VALUES (?, ?, ?, ?)',
      [localPath, groupId, mirrorIndex, 'active']
    );
  },

  // 停用某个路径
  deactivate: function(poolId) {
    return run("UPDATE storage_pools SET status = 'disabled' WHERE id = ?", [poolId]);
  },

  // 启用某个路径
  activate: function(poolId) {
    return run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [poolId]);
  },

  // 删除某个路径（逻辑删除，同时清理关联的文件路径引用）
  remove: function(poolId) {
    // 标记存储池为已删除
    run("UPDATE storage_pools SET status = 'deleted' WHERE id = ?", [poolId]);
    // 标记该池下所有文件路径为已删除
    var affected = run("UPDATE file_storage_paths SET status = 'deleted' WHERE pool_id = ?", [poolId]);
    console.log('[StoragePool] 删除 pool_id=' + poolId + ' 影响文件路径: ' + (affected.changes || 0));
    return affected;
  },

  // 获取下一个可用的均衡组 ID
  getNextGroupId: function() {
    var result = get('SELECT MAX(group_id) as max_group FROM storage_pools');
    return (result && result.max_group ? result.max_group + 1 : 1);
  }
};

// ==================== 用户文件引用 ====================
var UserFileRef = {
  // 创建引用
  create: function(userId, storageId, dirId, name, mimeType) {
    return run(
      'INSERT INTO user_file_refs (user_id, storage_id, dir_id, name, mime_type) VALUES (?, ?, ?, ?, ?)',
      [userId, storageId, dirId || 0, name, mimeType || 'application/octet-stream']
    );
  },

  // 获取用户某个文件引用
  findByUserAndFile: function(userId, storageId) {
    return get('SELECT * FROM user_file_refs WHERE user_id = ? AND storage_id = ?', [userId, storageId]);
  },

  // 获取用户所有引用
  listByUser: function(userId) {
    return query(
      'SELECT ufr.*, fs.file_hash, fs.file_size, fs.ref_count as total_ref_count ' +
      'FROM user_file_refs ufr LEFT JOIN file_storage fs ON ufr.storage_id = fs.id ' +
      'WHERE ufr.user_id = ? ORDER BY ufr.created_at DESC',
      [userId]
    );
  },

  // 获取某个目录下的所有引用
  listByDir: function(userId, dirId) {
    return query(
      'SELECT ufr.*, fs.file_hash, fs.file_size, fs.uuid as storage_uuid, fs.ref_count as total_ref_count ' +
      'FROM user_file_refs ufr LEFT JOIN file_storage fs ON ufr.storage_id = fs.id ' +
      'WHERE ufr.user_id = ? AND ufr.dir_id = ? ORDER BY ufr.name',
      [userId, dirId || 0]
    );
  },

  // 删除引用（返回被删除的引用信息）
  remove: function(refId) {
    var ref = get('SELECT * FROM user_file_refs WHERE id = ?', [refId]);
    if (ref) {
      run('DELETE FROM user_file_refs WHERE id = ?', [refId]);
    }
    return ref;
  },

  // 通过 storage_id + user_id 删除引用
  removeByStorageAndUser: function(storageId, userId) {
    var ref = get('SELECT * FROM user_file_refs WHERE storage_id = ? AND user_id = ?', [storageId, userId]);
    if (ref) {
      run('DELETE FROM user_file_refs WHERE storage_id = ? AND user_id = ?', [storageId, userId]);
    }
    return ref;
  },

  // 统计某个 storage 的引用数量
  countByStorage: function(storageId) {
    var result = get('SELECT COUNT(*) as cnt FROM user_file_refs WHERE storage_id = ?', [storageId]);
    return result ? result.cnt : 0;
  }
};

// ==================== 在线设备管理 ====================
var UserDevice = {
  // 记录或更新设备
  upsert: function(userId, deviceId, deviceName, ip, userAgent) {
    var existing = get('SELECT * FROM user_devices WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
    if (existing) {
      run('UPDATE user_devices SET device_name = ?, ip = ?, user_agent = ?, last_active = datetime("now"), is_active = 1 WHERE id = ?',
        [deviceName || existing.device_name, ip, userAgent, existing.id]);
      return existing.id;
    }
    var result = run(
      'INSERT INTO user_devices (user_id, device_id, device_name, ip, user_agent, last_active) VALUES (?, ?, ?, ?, ?, datetime("now"))',
      [userId, deviceId, deviceName || '', ip, userAgent || '']
    );
    return result.lastInsertRowid;
  },

  // 更新设备活跃时间
  touch: function(userId, deviceId) {
    run('UPDATE user_devices SET last_active = datetime("now") WHERE user_id = ? AND device_id = ? AND is_active = 1',
      [userId, deviceId]);
  },

  // 列出用户的所有设备
  listByUser: function(userId) {
    return query(
      'SELECT * FROM user_devices WHERE user_id = ? AND is_active = 1 ORDER BY last_active DESC',
      [userId]
    );
  },

  // 强制登出设备
  deactivate: function(deviceId, userId) {
    return run('UPDATE user_devices SET is_active = 0 WHERE id = ? AND user_id = ?', [deviceId, userId]);
  },

  // 通过 device_id 字符串强制登出
  deactivateByDeviceStr: function(deviceStr, userId) {
    return run('UPDATE user_devices SET is_active = 0 WHERE device_id = ? AND user_id = ?', [deviceStr, userId]);
  },

  // 强制登出用户的所有设备
  deactivateAll: function(userId) {
    return run('UPDATE user_devices SET is_active = 0 WHERE user_id = ?', [userId]);
  },

  // 检查设备是否活跃
  isActive: function(userId, deviceId) {
    var device = get('SELECT is_active FROM user_devices WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
    return device ? device.is_active === 1 : true; // 新设备默认允许
  },

  // 删除设备记录
  remove: function(deviceId, userId) {
    return run('DELETE FROM user_devices WHERE id = ? AND user_id = ?', [deviceId, userId]);
  },

  // 统计用户设备数
  countByUser: function(userId) {
    var result = get('SELECT COUNT(*) as cnt FROM user_devices WHERE user_id = ? AND is_active = 1', [userId]);
    return result ? result.cnt : 0;
  }
};

// ==================== 异步任务管理 ====================
var AsyncTask = {
  // 创建任务
  create: function(type, title, metadata) {
    var result = run(
      'INSERT INTO async_tasks (type, title, metadata) VALUES (?, ?, ?)',
      [type, title, JSON.stringify(metadata || {})]
    );
    return result.lastInsertRowid;
  },

  // 开始任务
  start: function(id, totalItems) {
    return run(
      "UPDATE async_tasks SET status = 'running', started_at = datetime('now'), total_items = ?, progress = 0, processed_items = 0, error_items = 0 WHERE id = ?",
      [totalItems || 0, id]
    );
  },

  // 更新进度
  updateProgress: function(id, processed, total, errors) {
    var pct = total > 0 ? Math.round(processed / total * 100) : 0;
    return run(
      'UPDATE async_tasks SET progress = ?, processed_items = ?, total_items = ?, error_items = ? WHERE id = ?',
      [pct, processed || 0, total || 0, errors || 0, id]
    );
  },

  // 添加日志
  appendLog: function(id, message, level) {
    level = level || 'info';
    var task = get('SELECT logs FROM async_tasks WHERE id = ?', [id]);
    if (!task) return;
    try {
      var logs = JSON.parse(task.logs || '[]');
      logs.push({ time: new Date().toISOString(), level: level, msg: message });
      // 保留最近 500 条日志
      if (logs.length > 500) logs = logs.slice(-500);
      run('UPDATE async_tasks SET logs = ? WHERE id = ?', [JSON.stringify(logs), id]);
    } catch(e) {}
  },

  // 完成任务
  complete: function(id, status) {
    status = status || 'completed'; // 'completed' or 'error'
    return run(
      "UPDATE async_tasks SET status = ?, completed_at = datetime('now') WHERE id = ?",
      [status, id]
    );
  },

  // 暂停任务
  pause: function(id) {
    return run("UPDATE async_tasks SET status = 'paused' WHERE id = ? AND status = 'running'", [id]);
  },

  // 恢复任务
  resume: function(id) {
    return run("UPDATE async_tasks SET status = 'pending' WHERE id = ? AND status = 'paused'", [id]);
  },

  // 获取任务详情
  get: function(id) {
    var task = get('SELECT * FROM async_tasks WHERE id = ?', [id]);
    if (task) {
      try { task.logs = JSON.parse(task.logs || '[]'); } catch(e) { task.logs = []; }
      try { task.metadata = JSON.parse(task.metadata || '{}'); } catch(e) { task.metadata = {}; }
    }
    return task;
  },

  // 任务列表
  list: function(status, limit, offset) {
    var where = '';
    var params = [];
    if (status && status !== 'all') { where = 'WHERE status = ?'; params.push(status); }
    return query(
      'SELECT * FROM async_tasks ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      params.concat([limit || 20, offset || 0])
    ).map(function(t) {
      try { t.metadata = JSON.parse(t.metadata || '{}'); } catch(e) { t.metadata = {}; }
      return t;
    });
  },

  // 清理旧任务（保留最近 N 天的）
  cleanup: function(days) {
    return run(
      "DELETE FROM async_tasks WHERE status IN ('completed','error') AND completed_at < datetime('now', '-" + (days || 7) + " days')"
    );
  }
};

// ==================== 存储健康告警邮件 ====================
// 延迟加载避免循环依赖
function sendStorageAlerts(alerts) {
  try {
    var config = require('../config');
    var db = require('../lib/db');

    // 确定收件人
    var recipients = [];
    var alertConfig = config.storageAlertEmail || 'admins';
    if (alertConfig === 'admins') {
      var admins = db.query('SELECT email FROM users WHERE is_admin = 1');
      admins.forEach(function(a) { recipients.push(a.email); });
    } else {
      recipients = alertConfig.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    }
    if (recipients.length === 0) return;

    var alertRows = alerts.map(function(a) {
      var statusLabel = a.status === 'degraded' ? '降级(⚠)' : '故障(✖)';
      return '<tr style="border-bottom:1px solid #334155">' +
        '<td style="padding:8px 12px;color:#f0f0f0">存储组#' + a.groupId + '</td>' +
        '<td style="padding:8px 12px;color:#f0f0f0">' + escHtml2(a.name) + '</td>' +
        '<td style="padding:8px 12px;color:#f87171;font-weight:600">' + statusLabel + '</td>' +
        '<td style="padding:8px 12px;color:#9ca3af;font-size:12px;font-family:monospace">' + escHtml2(a.path) + '</td>' +
        '<td style="padding:8px 12px;color:#fbbf24;font-size:12px">' + escHtml2(a.reason) + '</td>' +
        '</tr>';
    }).join('');

    var html = '<div style="font-family:\'Microsoft YaHei\',Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#1a1d27;color:#e0e0e0;border-radius:8px">' +
      '<h2 style="color:#f59e0b;margin:0 0 16px">⚠ 存储健康告警</h2>' +
      '<p style="color:#9ca3af;font-size:14px;margin:0 0 16px">FileService 健康检查检测到 <strong style="color:#f87171">' + alerts.length + '</strong> 个存储路径异常，已自动降级处理：</p>' +
      '<table style="width:100%;border-collapse:collapse;background:#0f1117;border-radius:8px;overflow:hidden;margin-bottom:16px"><thead><tr style="background:#1f2937">' +
      '<th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:12px">存储组</th>' +
      '<th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:12px">镜像</th>' +
      '<th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:12px">状态</th>' +
      '<th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:12px">路径</th>' +
      '<th style="padding:8px 12px;text-align:left;color:#9ca3af;font-size:12px">原因</th>' +
      '</tr></thead><tbody>' + alertRows + '</tbody></table>' +
      '<div style="background:#1f2937;border-radius:8px;padding:12px;margin-bottom:16px">' +
      '<p style="color:#9ca3af;font-size:12px;margin:0">📋 <strong>已自动处理：</strong></p>' +
      '<ul style="color:#9ca3af;font-size:12px;margin:8px 0 0;padding-left:18px">' +
      '<li>镜像状态已降级（不会接受新写入）</li><li>存储组权重已降至 1（减少写入分配）</li>' +
      '<li>请尽快检查磁盘连接、目录权限或网络挂载</li></ul></div>' +
      '<p style="color:#6b7280;font-size:11px;text-align:center;margin:0">FileService 健康检查 · ' + new Date().toLocaleString('zh-CN') + '<br>此邮件由系统自动发送，30分钟内相同路径不会重复告警</p></div>';

    // 使用 email 模块发送（单个收件人，逐个发送避免被封）
    var emailLib = require('./email');
    function sendNext(idx) {
      if (idx >= recipients.length) return;
      emailLib.sendEmail(recipients[idx], '【FileService 告警】存储路径异常 - ' + alerts.length + '个镜像降级', html)
        .then(function() { sendNext(idx + 1); })
        .catch(function() { sendNext(idx + 1); });
    }
    sendNext(0);
    console.log('[HealthCheck] 已发送存储告警邮件: ' + recipients.join(', ') + ' alerts=' + alerts.length);
  } catch(e) {
    console.error('[HealthCheck] 发送告警邮件失败:', e.message);
  }
}

function escHtml2(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

module.exports = {
  User,
  VirtualDir,
  VirtualFile,
  Permission,
  PublicFile,
  Storage,
  ActionLog,
  EmailLog,
  RecycleBin,
  Share,
  ShareAccessLog,
  ShareStats,
  IPBlacklist,
  TrafficLog,
  TrafficQuota,
  OfflineDownload,
  WebDAVLink,
  FileStorage,
  StoragePool,
  UserFileRef,
  UserDevice,
  AsyncTask,
  initDatabase,
  // 导出内部 query 函数供其他模块使用
  query: query,
  get: get,
  run: run,
  saveDatabaseNow: saveDatabaseNow,
  Share: Share,
  // 导出 db 对象供直接访问
  get db() { return db; }
};