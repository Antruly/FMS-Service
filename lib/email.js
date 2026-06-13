const nodemailer = require('nodemailer');
const config = require('../config');

const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: config.email.user,
    pass: config.email.authCode
  }
});

function sendEmail(to, subject, html) {
  return transporter.sendMail({
    from: config.email.from + ' <' + config.email.user + '>',
    to: to,
    subject: subject,
    html: html
  }).then(function(info) {
    console.log('[Email] 已发送至:', to, '主题:', subject);
    return true;
  }).catch(function(err) {
    console.error('[Email] 发送失败:', err.message);
    return false;
  });
}

function sendVerifyCode(email, code) {
  const html = `
    <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 30px; background: #f8fafc; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1e293b; font-size: 24px; margin: 0;">验证码</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
        <p style="color: #64748b; font-size: 14px; margin: 0 0 20px;">您的验证码是：</p>
        <div style="font-size: 36px; font-weight: bold; color: #0ea5e9; letter-spacing: 8px; padding: 15px 0; background: linear-gradient(135deg, #0ea5e9, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
          ${code}
        </div>
        <p style="color: #94a3b8; font-size: 12px; margin: 20px 0 0;">验证码将在 <strong>5 分钟</strong>后过期</p>
      </div>
      <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
        如果您没有进行此操作，请忽略此邮件。<br>
        为保障账户安全，请勿将验证码告诉他人。
      </p>
    </div>
  `;
  return sendEmail(email, '【文件管理】您的注册验证码', html);
}

function sendResetPasswordCode(email, code) {
  const html = `
    <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 30px; background: #f8fafc; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1e293b; font-size: 24px; margin: 0;">重置密码</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
        <p style="color: #64748b; font-size: 14px; margin: 0 0 20px;">您正在重置密码，验证码是：</p>
        <div style="font-size: 36px; font-weight: bold; color: #0ea5e9; letter-spacing: 8px; padding: 15px 0; background: linear-gradient(135deg, #0ea5e9, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
          ${code}
        </div>
        <p style="color: #94a3b8; font-size: 12px; margin: 20px 0 0;">验证码将在 <strong>5 分钟</strong>后过期</p>
      </div>
      <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
        如果您没有请求重置密码，请忽略此邮件。<br>
        为保障账户安全，请勿将验证码告诉他人。
      </p>
    </div>
  `;
  return sendEmail(email, '【文件管理】重置密码验证码', html);
}

// 公共回收站文件即将过期提醒（过期前3天）
// files: [{ name, size, remaining_text, expires_at }, ...]
function sendRecycleReminder(email, files, systemUrl) {
  var fileListHtml = files.map(function(f) {
    return '<tr style="border-bottom:1px solid #e2e8f0">' +
      '<td style="padding:10px 12px;color:#334155;font-size:14px">' + escapeHtml(f.name) + '</td>' +
      '<td style="padding:10px 12px;color:#e67e22;font-size:14px;font-weight:600">' + escapeHtml(f.remaining_text) + '</td>' +
      '<td style="padding:10px 12px;color:#94a3b8;font-size:12px">' + (f.expires_at ? new Date(f.expires_at).toLocaleString('zh-CN') : '-') + '</td>' +
    '</tr>';
  }).join('');

  var totalSize = files.reduce(function(s, f) { return s + (f.size || 0); }, 0);
  var sizeStr = totalSize >= 1073741824
    ? (totalSize / 1073741824).toFixed(1) + ' GB'
    : totalSize >= 1048576
      ? (totalSize / 1048576).toFixed(1) + ' MB'
      : (totalSize / 1024).toFixed(1) + ' KB';

  var disableCode = 'STOPREM-' + email.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  var html = `
    <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 30px; background: #f8fafc; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #1e293b; font-size: 22px; margin: 0;">&#9888; 回收站文件即将过期</h1>
      </div>
      <div style="background: white; padding: 24px; border-radius: 8px; margin-bottom: 20px;">
        <p style="color: #64748b; font-size: 14px; margin: 0 0 16px;">
          您有 <strong style="color:#e67e22">${files.length}</strong> 个公共文件即将在 3 天内自动永久删除，
          请尽快处理以避免文件丢失。
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:10px 12px;text-align:left;color:#475569;font-size:12px">文件名</th>
              <th style="padding:10px 12px;text-align:left;color:#475569;font-size:12px">剩余时间</th>
              <th style="padding:10px 12px;text-align:left;color:#475569;font-size:12px">过期时间</th>
            </tr>
          </thead>
          <tbody>
            ${fileListHtml}
          </tbody>
        </table>
        <p style="color:#94a3b8;font-size:12px;margin:0">共 ${files.length} 个文件，总计 ${sizeStr}</p>
      </div>
      <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="color:#9a3412;font-size:13px;margin:0 0 8px">
          <strong>&#9888; 不想再收到此类邮件？</strong>
        </p>
        <p style="color:#7c2d12;font-size:13px;margin:0 0 8px">
          回复此邮件，并在邮件正文中粘贴以下代码即可关闭邮件提醒：
        </p>
        <code style="display:block;background:#fef3c7;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:13px;color:#92400e;word-break:break-all">${disableCode}</code>
        <p style="color:#9a3412;font-size:12px;margin:8px 0 0">关闭后仍可通过网页端管理回收站文件</p>
      </div>
      <div style="text-align:center;margin-bottom:20px">
        <a href="${systemUrl}" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#7c3aed);color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600">立即处理文件</a>
      </div>
      <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">
        此邮件由文件管理系统自动发送，请勿直接回复（回复仅用于取消订阅）。<br>
        如有疑问请联系管理员。
      </p>
    </div>
  `;
  return sendEmail(email, '【文件管理】提醒：' + files.length + ' 个公共文件即将过期', html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 不活跃警告：分享或 WebDAV 27 天无访问，3 天后自动禁用
// item: { target_name, share_hash, token, expires_at, created_at }
// 不活跃警告 / 已禁用通知（仅 WebDAV）
// item: { target_name, target_path, token, expires_at, created_at, days_inactive, is_disabled }
function sendInactivityWarning(email, item, type) {
  var itemName = item.target_name || '未命名';
  var itemPath = item.target_path || '/';
  // 确保路径以 / 开头（个人目录的是纯数字 ID，需要转换显示）
  var displayPath = itemPath;
  if (/^\d+$/.test(displayPath)) {
    displayPath = '个人目录 (ID: ' + displayPath + ')';
  } else if (displayPath[0] !== '/') {
    displayPath = '/' + displayPath;
  }
  var tokenPrefix = item.token ? item.token.substring(0, 8) + '...' : '';
  var itemTypeLabel = 'WebDAV 链接';
  var expiresText = item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN') : '永久有效';
  var createdText = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
  var daysInactive = item.days_inactive || 30;
  var isDisabled = item.is_disabled;

  var title, bodyText;
  if (isDisabled) {
    title = '&#128683; ' + itemTypeLabel + '已被自动禁用';
    bodyText = '您的 ' + itemTypeLabel + ' <strong>' + escapeHtml(itemName) + '</strong> 已连续 ' + daysInactive + ' 天无任何访问，<strong style="color:#dc2626">已被系统自动禁用</strong>。';
  } else {
    title = '&#9888; ' + itemTypeLabel + '即将被自动禁用';
    bodyText = '您的 ' + itemTypeLabel + ' <strong>' + escapeHtml(itemName) + '</strong> 已连续 ' + daysInactive + ' 天无任何访问，系统将在 <strong style="color:#e67e22">3 天后自动禁用</strong>，请及时使用以保持活跃。';
  }

  var html = '<div style="font-family:\'Microsoft YaHei\',Arial,sans-serif;max-width:560px;margin:0 auto;padding:30px;background:#f8fafc;border-radius:12px">' +
    '<div style="text-align:center;margin-bottom:24px"><h1 style="color:#1e293b;font-size:22px;margin:0">' + title + '</h1></div>' +
    '<div style="background:white;padding:24px;border-radius:8px;margin-bottom:20px">' +
    '<p style="color:#64748b;font-size:14px;margin:0 0 16px">' + bodyText + '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<tr style="background:#f1f5f9"><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">名称</td><td style="padding:10px 12px;color:#334155;font-size:14px">' + escapeHtml(itemName) + '</td></tr>' +
    '<tr><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">路径</td><td style="padding:10px 12px;font-family:monospace;color:#334155;font-size:13px">' + escapeHtml(displayPath) + '</td></tr>' +
    '<tr style="background:#f1f5f9"><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">不活跃天数</td><td style="padding:10px 12px;color:#e67e22;font-size:14px;font-weight:600">' + daysInactive + ' 天</td></tr>' +
    '<tr><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">创建时间</td><td style="padding:10px 12px;color:#334155;font-size:14px">' + createdText + '</td></tr>' +
    '<tr style="background:#f1f5f9"><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">过期时间</td><td style="padding:10px 12px;color:#334155;font-size:14px">' + expiresText + '</td></tr>' +
    '</table>' +
    (isDisabled
      ? '<p style="color:#94a3b8;font-size:12px;margin:0">可通过网页端 WebDAV 管理页面手动重新启用。<br>重新启用后时间继续从原过期时间计算，若已到期则无法重新启用。</p>'
      : '<p style="color:#94a3b8;font-size:12px;margin:0">在接下来 3 天内使用该链接即可重置不活跃计时。<br>若被自动禁用，可通过网页端手动重新启用。</p>') +
    '</div>' +
    '<p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">此邮件由文件管理系统自动发送，请勿直接回复。</p>' +
    '</div>';

  return sendEmail(email, '【文件管理】' + itemTypeLabel + (isDisabled ? '已被自动禁用' : '即将被自动禁用'), html);
}

// WebDAV 到期提醒邮件
// stage: 'renewal' (到期前30天可续期) | 'expiring' (到期前3天) | 'expired' (已过期)
// item: { target_name, target_path, token, expires_at, created_at, remaining_days }
function sendExpiryNotice(email, item, stage) {
  var itemName = item.target_name || '未命名';
  var itemPath = item.target_path || '/';
  var displayPath = itemPath;
  if (/^\d+$/.test(displayPath)) {
    displayPath = '个人目录 (ID: ' + displayPath + ')';
  } else if (displayPath[0] !== '/') {
    displayPath = '/' + displayPath;
  }
  var tokenPrefix = item.token ? item.token.substring(0, 8) + '...' : '';
  var expiresText = item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN') : '-';
  var createdText = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
  var remaining = item.remaining_days || 0;
  var itemTypeLabel = 'WebDAV 链接';

  var title, bodyHtml;
  if (stage === 'renewal') {
    title = '&#128260; ' + itemTypeLabel + '可在到期前续期';
    bodyHtml = '<p style="color:#64748b;font-size:14px;margin:0 0 16px">您的 ' + itemTypeLabel + ' <strong>' + escapeHtml(itemName) + '</strong> 将在 <strong style="color:#e67e22">' + remaining + ' 天后</strong>到期，现在可以续期延长至一年。</p>' +
      '<p style="color:#64748b;font-size:14px;margin:0 0 16px">请前往网页端 WebDAV 管理页面点击 <strong style="color:#10b981">"续期"</strong> 按钮即可延长。</p>';
  } else if (stage === 'expiring') {
    title = '&#9200; ' + itemTypeLabel + '即将过期';
    bodyHtml = '<p style="color:#64748b;font-size:14px;margin:0 0 16px">您的 ' + itemTypeLabel + ' <strong>' + escapeHtml(itemName) + '</strong> 将在 <strong style="color:#dc2626">' + remaining + ' 天后</strong>到期，到期后将无法访问。</p>' +
      '<p style="color:#64748b;font-size:14px;margin:0 0 16px">如需继续使用，请及时处理。</p>';
  } else {
    title = '&#10060; ' + itemTypeLabel + '已过期';
    bodyHtml = '<p style="color:#64748b;font-size:14px;margin:0 0 16px">您的 ' + itemTypeLabel + ' <strong>' + escapeHtml(itemName) + '</strong> <strong style="color:#dc2626">已过期</strong>，现已无法访问。</p>' +
      '<p style="color:#64748b;font-size:14px;margin:0 0 16px">请前往网页端删除已过期的链接，或重新创建。</p>';
  }

  var html = '<div style="font-family:\'Microsoft YaHei\',Arial,sans-serif;max-width:560px;margin:0 auto;padding:30px;background:#f8fafc;border-radius:12px">' +
    '<div style="text-align:center;margin-bottom:24px"><h1 style="color:#1e293b;font-size:22px;margin:0">' + title + '</h1></div>' +
    '<div style="background:white;padding:24px;border-radius:8px;margin-bottom:20px">' +
    bodyHtml +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<tr style="background:#f1f5f9"><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">名称</td><td style="padding:10px 12px;color:#334155;font-size:14px">' + escapeHtml(itemName) + '</td></tr>' +
    '<tr><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">路径</td><td style="padding:10px 12px;font-family:monospace;color:#334155;font-size:13px">' + escapeHtml(displayPath) + '</td></tr>' +
    '<tr style="background:#f1f5f9"><td style="padding:10px 12px;color:#475569;font-size:12px;font-weight:600">过期时间</td><td style="padding:10px 12px;color:#334155;font-size:14px">' + expiresText + '</td></tr>' +
    '</table>' +
    '</div>' +
    '<p style="color:#94a3b8;font-size:12px;text-align:center;margin:0">此邮件由文件管理系统自动发送，请勿直接回复。</p>' +
    '</div>';

  var subject = stage === 'renewal' ? '可在到期前续期' : (stage === 'expiring' ? '即将过期' : '已过期');
  return sendEmail(email, '【文件管理】' + itemTypeLabel + subject, html);
}

// 按用户合并：同一用户多个链接的所有条件合并一封
// links: [{ item: {target_name, target_path, token, expires_at, created_at, days_inactive}, conditions: [...] }]
function sendUserCombinedNotice(email, links) {
  // 收集全局 badges
  var allConditions = [];
  links.forEach(function(l) { allConditions = allConditions.concat(l.conditions); });
  // 去重
  var conditionSet = {};
  allConditions.forEach(function(c) { conditionSet[c] = true; });

  var badges = [];
  if (conditionSet.renewal) badges.push('📀 可续期');
  if (conditionSet.expiring) badges.push('⏰ 即将过期');
  if (conditionSet.expired) badges.push('❌ 已过期');
  if (conditionSet.inactive_warn) badges.push('⚠ 即将被禁用');
  if (conditionSet.inactive_disabled) badges.push('🚫 已被自动禁用');

  // 为每个链接构建行
  var linkRows = '';
  links.forEach(function(l) {
    var item = l.item;
    var conds = l.conditions;
    var itemName = item.target_name || '未命名';
    var itemPath = item.target_path || '/';
    var displayPath = itemPath;
    if (/^\d+$/.test(displayPath)) {
      displayPath = '个人目录 (ID:' + displayPath + ')';
    } else if (displayPath[0] !== '/') {
      displayPath = '/' + displayPath;
    }
    var expiresText = item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'}) : '永久';
    var condLabels = [];
    if (conds.indexOf('renewal') !== -1) condLabels.push('可续期');
    if (conds.indexOf('expiring') !== -1) condLabels.push('即将过期');
    if (conds.indexOf('expired') !== -1) condLabels.push('已过期');
    if (conds.indexOf('inactive_warn') !== -1) condLabels.push(item.days_inactive + '天未使用');
    if (conds.indexOf('inactive_disabled') !== -1) condLabels.push('已被禁用');

    linkRows +=
      '<tr>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#334155;font-size:13px;font-weight:600">' + escapeHtml(itemName) + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:monospace;color:#64748b;font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="' + escapeHtml(displayPath) + '">' + escapeHtml(displayPath) + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:11px;white-space:nowrap">' + expiresText + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;white-space:nowrap">' + condLabels.map(function(s) { return '<span style="display:inline-block;background:#f1f5f9;color:#475569;padding:1px 6px;border-radius:3px;margin:1px 2px">' + escapeHtml(s) + '</span>'; }).join('') + '</td>' +
      '</tr>';
  });

  var explodedHtml = '';
  // 全局说明
  if (conditionSet.inactive_disabled) {
    explodedHtml += '<div style="border-left:3px solid #dc2626;padding-left:12px;margin-bottom:10px"><p style="color:#dc2626;font-size:13px;font-weight:600;margin:0 0 2px">🚫 已被自动禁用</p><p style="color:#64748b;font-size:12px;margin:0">长时间无访问的链接已被系统自动禁用，可通过网页端手动重新启用。</p></div>';
  }
  if (conditionSet.inactive_warn) {
    explodedHtml += '<div style="border-left:3px solid #f59e0b;padding-left:12px;margin-bottom:10px"><p style="color:#f59e0b;font-size:13px;font-weight:600;margin:0 0 2px">⚠ 即将被自动禁用</p><p style="color:#64748b;font-size:12px;margin:0">连续 30 天无访问的链接将在 3 天后自动禁用，使用一次即可重置计时。</p></div>';
  }
  if (conditionSet.expired) {
    explodedHtml += '<div style="border-left:3px solid #dc2626;padding-left:12px;margin-bottom:10px"><p style="color:#dc2626;font-size:13px;font-weight:600;margin:0 0 2px">❌ 链接已过期</p><p style="color:#64748b;font-size:12px;margin:0">链接已到期无法访问，可删除后重新创建。</p></div>';
  }
  if (conditionSet.expiring) {
    explodedHtml += '<div style="border-left:3px solid #e67e22;padding-left:12px;margin-bottom:10px"><p style="color:#e67e22;font-size:13px;font-weight:600;margin:0 0 2px">⏰ 即将到期</p><p style="color:#64748b;font-size:12px;margin:0">链接将在几天后到期，届时将无法访问。</p></div>';
  }
  if (conditionSet.renewal) {
    explodedHtml += '<div style="border-left:3px solid #10b981;padding-left:12px;margin-bottom:10px"><p style="color:#10b981;font-size:13px;font-weight:600;margin:0 0 2px">📀 可续期</p><p style="color:#64748b;font-size:12px;margin:0">到期前 30 天内可续期至一年，请在网页端 WebDAV 管理页面操作。</p></div>';
  }

  var title = '【文件管理】WebDAV 链接提醒';
  if (badges.length === 1) title = '【文件管理】' + badges[0];

  var html = '<div style="font-family:\'Microsoft YaHei\',Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">' +
    '<div style="text-align:center;margin-bottom:16px"><h1 style="color:#1e293b;font-size:18px;margin:0">' + badges.join(' · ') + '</h1></div>' +
    explodedHtml +
    '<div style="background:white;padding:16px;border-radius:8px;margin-bottom:12px">' +
    '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr style="background:#f8fafc">' +
    '<th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;font-weight:600">名称</th>' +
    '<th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;font-weight:600">路径</th>' +
    '<th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;font-weight:600;white-space:nowrap">过期时间</th>' +
    '<th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;font-weight:600">状态</th>' +
    '</tr></thead><tbody>' +
    linkRows +
    '</tbody></table>' +
    '</div>' +
    '<p style="color:#94a3b8;font-size:11px;text-align:center;margin:0">此邮件由 FMS 文件管理系统自动发送，请勿直接回复。如有疑问请联系管理员。</p>' +
    '</div>';

  return sendEmail(email, title, html);
}

// 单链接合并（保留兼容，调度器已改用 sendUserCombinedNotice）
// conditions 可包含: 'renewal', 'expiring', 'expired', 'inactive_warn', 'inactive_disabled'
// item: { target_name, target_path, token, expires_at, created_at, days_inactive }
function sendCombinedNotice(email, item, conditions) {
  var itemName = item.target_name || '未命名';
  var itemPath = item.target_path || '/';
  var displayPath = itemPath;
  if (/^\d+$/.test(displayPath)) {
    displayPath = '个人目录 (ID: ' + displayPath + ')';
  } else if (displayPath[0] !== '/') {
    displayPath = '/' + displayPath;
  }
  var expiresText = item.expires_at ? new Date(item.expires_at).toLocaleString('zh-CN') : '永久有效';
  var createdText = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
  var daysInactive = item.days_inactive || 30;

  // 构建各部分内容
  var sections = [];
  var badges = [];

  // 到期相关
  if (conditions.indexOf('renewal') !== -1) {
    badges.push('📀 可续期');
    sections.push(
      '<div style="border-left:3px solid #10b981;padding-left:12px;margin-bottom:12px">' +
      '<p style="color:#10b981;font-size:14px;font-weight:600;margin:0 0 4px">📀 可在到期前续期</p>' +
      '<p style="color:#64748b;font-size:13px;margin:0">可在网页端 WebDAV 管理页面点击 <strong>"续期"</strong> 延长至一年。</p>' +
      '</div>');
  }
  if (conditions.indexOf('expiring') !== -1) {
    badges.push('⏰ 即将过期');
    sections.push(
      '<div style="border-left:3px solid #e67e22;padding-left:12px;margin-bottom:12px">' +
      '<p style="color:#e67e22;font-size:14px;font-weight:600;margin:0 0 4px">⏰ 即将过期</p>' +
      '<p style="color:#64748b;font-size:13px;margin:0">该链接将在 <strong>' + Math.ceil((new Date(item.expires_at) - new Date()) / (24*3600*1000)) + ' 天后</strong>到期，届时将无法访问。</p>' +
      '</div>');
  }
  if (conditions.indexOf('expired') !== -1) {
    badges.push('❌ 已过期');
    sections.push(
      '<div style="border-left:3px solid #dc2626;padding-left:12px;margin-bottom:12px">' +
      '<p style="color:#dc2626;font-size:14px;font-weight:600;margin:0 0 4px">❌ 已过期</p>' +
      '<p style="color:#64748b;font-size:13px;margin:0">该链接已过期，现已无法访问。可删除后重新创建。</p>' +
      '</div>');
  }

  // 不活跃相关
  if (conditions.indexOf('inactive_warn') !== -1) {
    badges.push('⚠ 即将被禁用');
    sections.push(
      '<div style="border-left:3px solid #f59e0b;padding-left:12px;margin-bottom:12px">' +
      '<p style="color:#f59e0b;font-size:14px;font-weight:600;margin:0 0 4px">⚠ 长时间未使用，即将被自动禁用</p>' +
      '<p style="color:#64748b;font-size:13px;margin:0">已连续 <strong>' + daysInactive + ' 天</strong>无访问，若 3 天后仍无访问将被<strong>自动禁用</strong>。使用一次即可重置计时。</p>' +
      '</div>');
  }
  if (conditions.indexOf('inactive_disabled') !== -1) {
    badges.push('🚫 已被自动禁用');
    sections.push(
      '<div style="border-left:3px solid #dc2626;padding-left:12px;margin-bottom:12px">' +
      '<p style="color:#dc2626;font-size:14px;font-weight:600;margin:0 0 4px">🚫 已被系统自动禁用</p>' +
      '<p style="color:#64748b;font-size:13px;margin:0">已连续 <strong>' + daysInactive + ' 天</strong>无访问。可通过网页端手动重新启用，重新启用后时间继续从原过期时间计算。</p>' +
      '</div>');
  }

  var title = '【文件管理】WebDAV 链接提醒';
  if (badges.length === 1) {
    title = '【文件管理】WebDAV ' + badges[0];
  }

  var html = '<div style="font-family:\'Microsoft YaHei\',Arial,sans-serif;max-width:560px;margin:0 auto;padding:30px;background:#f8fafc;border-radius:12px">' +
    '<div style="text-align:center;margin-bottom:20px"><h1 style="color:#1e293b;font-size:20px;margin:0">' + badges.join(' · ') + '</h1></div>' +
    '<div style="background:white;padding:24px;border-radius:8px;margin-bottom:16px">' +
    '<p style="color:#475569;font-size:14px;margin:0 0 16px">WebDAV 链接 <strong>' + escapeHtml(itemName) + '</strong></p>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<tr style="background:#f1f5f9"><td style="padding:8px 12px;color:#64748b;font-size:12px">名称</td><td style="padding:8px 12px;color:#334155;font-size:13px">' + escapeHtml(itemName) + '</td></tr>' +
    '<tr><td style="padding:8px 12px;color:#64748b;font-size:12px">路径</td><td style="padding:8px 12px;font-family:monospace;color:#334155;font-size:12px">' + escapeHtml(displayPath) + '</td></tr>' +
    '<tr style="background:#f1f5f9"><td style="padding:8px 12px;color:#64748b;font-size:12px">过期时间</td><td style="padding:8px 12px;color:#334155;font-size:13px">' + expiresText + '</td></tr>' +
    '</table>' +
    sections.join('') +
    '</div>' +
    '<p style="color:#94a3b8;font-size:11px;text-align:center;margin:0">此邮件由 FMS 文件管理系统自动发送，请勿直接回复。</p>' +
    '</div>';

  return sendEmail(email, title, html);
}

module.exports = { sendEmail, sendVerifyCode, sendResetPasswordCode, sendRecycleReminder, sendInactivityWarning, sendExpiryNotice, sendUserCombinedNotice, sendCombinedNotice, escapeHtml };
