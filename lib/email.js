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

module.exports = { sendEmail, sendVerifyCode, sendResetPasswordCode, sendRecycleReminder, escapeHtml };
