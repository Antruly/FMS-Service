var log = require('./lib/log');
/**
 * FileService 配置
 * 配置优先级: 环境变量 > .env 文件 > 自动生成（仅全新安装时）
 *
 * ⚠️ 安全策略：
 *   - 全新安装（数据库为空）：自动生成密钥并写入 .env
 *   - 已有数据库但密钥缺失：拒绝启动，要求手动配置（防止覆盖生产密钥导致文件永久无法解密）
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// ==================== .env 文件加载 ====================
var ENV_FILE = path.join(__dirname, '.env');

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  var lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
  lines.forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    var eqIdx = line.indexOf('=');
    if (eqIdx === -1) return;
    var key = line.substring(0, eqIdx).trim();
    var value = line.substring(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
  log.info('[Config] 已加载 .env 配置文件');
}

function saveEnvFile(updates) {
  var existing = {};
  if (fs.existsSync(ENV_FILE)) {
    var lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
    lines.forEach(function(line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      var eqIdx = line.indexOf('=');
      if (eqIdx === -1) return;
      var k = line.substring(0, eqIdx).trim();
      var v = line.substring(eqIdx + 1).trim();
      existing[k] = v;
    });
  }
  Object.keys(updates).forEach(function(k) { existing[k] = updates[k]; });

  var content = '# FileService 配置文件\n';
  content += '# ⚠️ SYSTEM_MASTER_KEY 用于加密所有文件，请妥善保管，切勿丢失！\n';
  content += '# 丢失此密钥将导致所有已上传文件永久无法解密！\n\n';
  Object.keys(existing).sort().forEach(function(k) {
    content += k + '=' + existing[k] + '\n';
  });
  fs.writeFileSync(ENV_FILE, content, 'utf-8');
  log.info('[Config] 已更新 .env 文件');
}

loadEnvFile();

// ==================== 检查是否为已有数据的生产环境 ====================
// 读取数据库路径配置（可能在 env 中）
var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fileservice.db');
var dbfile = path.resolve(DB_PATH);
var hasExistingData = false;

// 检查数据库文件是否存在且不为空
if (fs.existsSync(dbfile)) {
  var stat = fs.statSync(dbfile);
  if (stat.size > 0) {
    hasExistingData = true;
    log.info('[Config] 检测到已有数据库: ' + dbfile + ' (' + Math.round(stat.size / 1024) + ' KB)');
  }
}

// ==================== 密钥处理 ====================
var newKeys = {};
var missingCritical = [];
var generated = false;

// —— SESSION_SECRET ——
if (!process.env.SESSION_SECRET) {
  if (hasExistingData) {
    // 生产环境已有数据但缺失密钥 → 危险！必须手动配置
    missingCritical.push('SESSION_SECRET');
  } else {
    // 全新安装 → 自动生成
    process.env.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    newKeys['SESSION_SECRET'] = process.env.SESSION_SECRET;
    generated = true;
    log.info('[Config] 全新安装，已自动生成 SESSION_SECRET');
  }
}

// —— SYSTEM_MASTER_KEY ——
if (!process.env.SYSTEM_MASTER_KEY) {
  if (hasExistingData) {
    // ⚠️ 生产环境已有加密文件但缺失主密钥 → 拒绝启动！
    missingCritical.push('SYSTEM_MASTER_KEY');
  } else {
    // 全新安装 → 自动生成
    process.env.SYSTEM_MASTER_KEY = crypto.randomBytes(48).toString('hex');
    newKeys['SYSTEM_MASTER_KEY'] = process.env.SYSTEM_MASTER_KEY;
    generated = true;
    log.info('[Config] 全新安装，已自动生成 SYSTEM_MASTER_KEY');
    log.info('[Config] ⚠️ 请妥善保存此密钥！丢失后所有加密文件将无法解密！');
  }
}

// —— 如果有缺失的关键密钥，拒绝启动 ——
if (missingCritical.length > 0) {
  log.error('');
  log.error('╔══════════════════════════════════════════════════════════════╗');
  log.error('║  ⚠️  严重安全错误：缺少必需密钥                            ║');
  log.error('╠══════════════════════════════════════════════════════════════╣');
  log.error('║                                                              ║');
  log.error('║  检测到服务器已有用户数据（数据库文件存在），但以下密钥    ║');
  log.error('║  未配置。自动生成新密钥会导致已有加密文件永久无法解密！    ║');
  log.error('║                                                              ║');
  log.error('║  缺失密钥: ' + padRight(missingCritical.join(', '), 50) + '║');
  log.error('║                                                              ║');
  log.error('║  解决方法：                                                  ║');
  log.error('║  1. 在 .env 文件中手动设置正确的密钥值                      ║');
  log.error('║  2. 或设置环境变量后启动                                    ║');
  log.error('║                                                              ║');
  log.error('║  如果是从旧版本升级，SYSTEM_MASTER_KEY 的旧默认值为:        ║');
  log.error('║  fileservice-default-master-key-change-this-in-production    ║');
  log.error('║                                                              ║');
  log.error('╚══════════════════════════════════════════════════════════════╝');
  log.error('');
  process.exit(1);
}

// —— 写入 .env ——
if (generated) {
  saveEnvFile(newKeys);
}

// —— EMAIL_AUTH_CODE (可选，仅提醒) ——
if (!process.env.EMAIL_AUTH_CODE) {
  console.warn('[Config] EMAIL_AUTH_CODE 未设置，邮件功能（注册验证码/密码重置）将不可用');
}

// —— STORAGE_ALERT_EMAIL: 存储健康告警邮件接收人 ——
// 设为 "admins" 发送给所有管理员，设为具体邮箱（逗号分隔）则发给指定邮箱
// 不设置则默认发送给所有管理员
if (!process.env.STORAGE_ALERT_EMAIL) {
  process.env.STORAGE_ALERT_EMAIL = 'admins';
}

function padRight(str, len) {
  while (str.length < len) str += ' ';
  return str;
}

// ==================== 导出配置 ====================
module.exports = {
  PORT: process.env.PORT || 88,
  SESSION_SECRET: process.env.SESSION_SECRET,
  SESSION_NAME: 'fileservice.sid',

  DB_PATH: DB_PATH,

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: +(process.env.REDIS_PORT || 6379),
    db: +(process.env.REDIS_DB || 15),
    keyPrefix: process.env.REDIS_PREFIX || 'ambush:'
  },

  ssl: {
    enabled: process.env.SSL_ENABLED === 'true',
    key: process.env.SSL_KEY_PATH || './cer/download.ssvr.top.key',
    cert: process.env.SSL_CERT_PATH || './cer/download.ssvr.top.pem',
    port: +(process.env.SSL_PORT || 8843)
  },

  email: {
    user: process.env.EMAIL_USER || 'assvr@foxmail.com',
    authCode: process.env.EMAIL_AUTH_CODE || '',
    from: process.env.EMAIL_FROM || '文件管理系统'
  },

  systemMasterKey: process.env.SYSTEM_MASTER_KEY,
  previewTokenSecret: process.env.PREVIEW_TOKEN_SECRET || process.env.SYSTEM_MASTER_KEY,

  security: {
    verifyCodeExpire: 300,
    loginErrorExpire: 60,
    maxLoginErrors: 3,
    minPasswordLength: 8,
    passwordRequireVariety: 3
  },

  corsAllowedOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),

  app: {
    baseUrl: process.env.APP_BASE_URL || ''
  },

  storageAlertEmail: process.env.STORAGE_ALERT_EMAIL || 'admins'
};
