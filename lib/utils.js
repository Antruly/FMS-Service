const config = require('../config');

// 验证邮箱格式
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 验证密码强度
function validatePassword(password) {
  const errors = [];

  if (!password || password.length < config.security.minPasswordLength) {
    errors.push('密码长度不能少于' + config.security.minPasswordLength + '位');
    return { valid: false, errors: errors };
  }

  let variety = 0;
  if (/[a-z]/.test(password)) variety++;
  if (/[A-Z]/.test(password)) variety++;
  if (/[0-9]/.test(password)) variety++;
  if (/[^a-zA-Z0-9]/.test(password)) variety++;

  if (variety < config.security.passwordRequireVariety) {
    errors.push('密码必须包含至少' + config.security.passwordRequireVariety + '种字符（大小写字母、数字、特殊字符）');
  }

  return { valid: errors.length === 0, errors: errors };
}

// 统一JSON响应格式
function json(res, code, message, data) {
  res.json({ code: code, message: message, data: data });
}

function success(res, data, message) {
  return json(res, 0, message || '操作成功', data);
}

function error(res, message, code, data) {
  return json(res, code || 1, message, data || null);
}

// 验证是否已登录
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return error(res, '请先登录', 401);
  }
  next();
}

// 验证邮箱验证码中间件
function verifyCodeCheck(email, code, type) {
  return require('../lib/redis').VerifyCode.verify(email, type, code);
}

// 生成随机token
function generateToken(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  require('crypto').randomFillSync(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

// 从请求中提取客户端 IP 地址
function getClientIp(req) {
  var ip = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || '';
  // 如果 x-forwarded-for 包含多个 IP（逗号分隔），取第一个
  if (ip && ip.indexOf(',') !== -1) {
    ip = ip.split(',')[0].trim();
  }
  return ip.replace(/^::ffff:/, '');
}

// 格式化文件大小（用于日志和显示）
function formatFileSize(bytes) {
  if (bytes === 0 || bytes === null || bytes === undefined) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
}

// 计算剩余毫秒数
function getRemainingMs(expiresAt) {
  if (!expiresAt) return 0;
  var diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 ? diff : 0;
}

// 格式化剩余时间（用于回收站显示）
function formatRemainingTime(expiresAt) {
  var ms = getRemainingMs(expiresAt);
  if (ms <= 0) return '已过期';
  var days = Math.floor(ms / (24 * 3600 * 1000));
  var hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  var minutes = Math.floor((ms % (3600 * 1000)) / (60 * 1000));
  if (days > 0) return days + '天' + hours + '小时';
  if (hours > 0) return hours + '小时' + minutes + '分钟';
  if (minutes > 0) return minutes + '分钟';
  return '不到1分钟';
}

module.exports = {
  isValidEmail: isValidEmail,
  validatePassword: validatePassword,
  json: json,
  success: success,
  error: error,
  requireAuth: requireAuth,
  generateToken: generateToken,
  getClientIp: getClientIp,
  formatFileSize: formatFileSize,
  getRemainingMs: getRemainingMs,
  formatRemainingTime: formatRemainingTime
};
