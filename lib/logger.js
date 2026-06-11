/**
 * 日志服务 - 提供统一的日志记录接口
 */
const { ActionLog, EmailLog } = require('./db');
const { formatFileSize: formatSize } = require('./utils');

// 从请求中提取客户端信息
function getClientInfo(req) {
  var ip = '';
  var userAgent = '';

  if (req) {
    ip = req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || req.ip || '';
    // 简单处理，多个 IP 时取第一个
    if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
    // 移除 IPv6 前缀
    if (ip.startsWith('::ffff:')) ip = ip.substring(7);
    userAgent = req.headers['user-agent'] || '';
    // 截断过长的 user-agent
    if (userAgent.length > 300) userAgent = userAgent.substring(0, 300);
  }

  return { ip: ip, userAgent: userAgent };
}

// 获取当前用户信息（从 req.session）
function getUserInfo(req) {
  if (!req || !req.session) return { userId: 0, email: '' };
  // 需要在路由中已经 attach 了完整 user 信息
  if (req._user) {
    return { userId: req._user.id, email: req._user.email };
  }
  return { userId: req.session.userId || 0, email: '' };
}

// ==================== 操作日志 ====================

// 记录用户操作
function log(req, action, targetType, targetName, targetId, detail) {
  var client = getClientInfo(req);
  var user = getUserInfo(req);

  ActionLog.log(
    user.userId,
    user.email,
    action,
    targetType || '',
    targetName || '',
    targetId || '',
    client.ip,
    client.userAgent,
    'success',
    detail || ''
  );
}

// 记录操作失败
function logError(req, action, targetType, targetName, targetId, detail) {
  var client = getClientInfo(req);
  var user = getUserInfo(req);

  ActionLog.log(
    user.userId,
    user.email,
    action,
    targetType || '',
    targetName || '',
    targetId || '',
    client.ip,
    client.userAgent,
    'error',
    detail || ''
  );
}

// 记录登录
function logLogin(req, success, reason) {
  var client = getClientInfo(req);
  var user = { userId: 0, email: '' };
  // 从 req.body.email 捕获邮箱（登录时 session 尚未建立，req._user 也没有）
  if (req && req.body && req.body.email) {
    user.email = req.body.email;
  }
  // 若 session 已建立（有 req._user），优先使用
  if (req && req._user && req._user.email) {
    user.email = req._user.email;
  }
  if (success) {
    ActionLog.log(0, user.email, 'login', 'user', '', '', client.ip, client.userAgent, 'success', reason || '');
  } else {
    ActionLog.log(0, user.email, 'login_fail', 'user', '', '', client.ip, client.userAgent, 'error', reason || '');
  }
}

// 记录登出
function logLogout(req) {
  log(req, 'logout', 'user', '', '', '');
}

// 记录注册
function logRegister(req, success, reason) {
  var client = getClientInfo(req);
  if (success) {
    ActionLog.log(0, '', 'register', 'user', '', '', client.ip, client.userAgent, 'success', reason || '');
  } else {
    ActionLog.log(0, '', 'register_fail', 'user', '', '', client.ip, client.userAgent, 'error', reason || '');
  }
}

// 记录文件上传
function logUpload(req, fileName, fileSize, success, reason) {
  var detail = fileSize ? '大小: ' + formatSize(fileSize) : '';
  if (reason) detail += (detail ? ' | ' : '') + reason;
  if (success) {
    log(req, 'upload', 'file', fileName, '', detail);
  } else {
    logError(req, 'upload', 'file', fileName, '', detail || reason);
  }
}

// 记录文件下载
function logDownload(req, fileName, fileId, success, reason) {
  if (success) {
    log(req, 'download', 'file', fileName, String(fileId), '');
  } else {
    logError(req, 'download', 'file', fileName, String(fileId), reason || '');
  }
}

// 记录文件删除
function logDelete(req, fileName, fileId, isDirectory, success, reason) {
  var targetType = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'delete', targetType, fileName, String(fileId), '');
  } else {
    logError(req, 'delete', targetType, fileName, String(fileId), reason || '');
  }
}

// 记录目录创建
function logCreateDir(req, dirName, success, reason) {
  if (success) {
    log(req, 'create_dir', 'directory', dirName, '', '');
  } else {
    logError(req, 'create_dir', 'directory', dirName, '', reason || '');
  }
}

// 记录公共文件上传
function logPublicUpload(req, fileName, fileSize, success, reason) {
  var detail = fileSize ? '大小: ' + formatSize(fileSize) : '';
  if (reason) detail += (detail ? ' | ' : '') + reason;
  if (success) {
    log(req, 'public_upload', 'public_file', fileName, '', detail);
  } else {
    logError(req, 'public_upload', 'public_file', fileName, '', detail || reason);
  }
}

// 记录公共文件/目录删除
function logPublicDelete(req, name, isDir, success, reason) {
  var targetType = isDir ? 'public_directory' : 'public_file';
  if (success) {
    log(req, 'public_delete', targetType, name, '', '');
  } else {
    logError(req, 'public_delete', targetType, name, '', reason || '');
  }
}

// 记录公共文件下载
function logPublicDownload(req, fileName, success, reason) {
  if (success) {
    log(req, 'public_download', 'public_file', fileName, '', '');
  } else {
    logError(req, 'public_download', 'public_file', fileName, '', reason || '');
  }
}

// 记录回收站软删除
function logRecycleDelete(req, fileName, isDirectory, success, reason) {
  var targetType = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'recycle_delete', targetType, fileName, '', '移入回收站，30天后自动清理');
  } else {
    logError(req, 'recycle_delete', targetType, fileName, '', reason || '');
  }
}

// 记录回收站恢复
function logRecycleRestore(req, fileName, isDirectory, success, reason) {
  var targetType = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'recycle_restore', targetType, fileName, '', '从回收站恢复');
  } else {
    logError(req, 'recycle_restore', targetType, fileName, '', reason || '');
  }
}

// 记录永久删除
function logRecyclePurge(req, fileName, isDirectory, success, reason) {
  var targetType = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'recycle_purge', targetType, fileName, '', '永久删除');
  } else {
    logError(req, 'recycle_purge', targetType, fileName, '', reason || '');
  }
}

// 记录清空回收站
function logRecycleEmpty(req, fileCount, dirCount, success, reason) {
  var detail = '清空回收站，共 ' + fileCount + ' 个文件，' + dirCount + ' 个目录';
  if (success) {
    log(req, 'recycle_empty', 'bin', '', '', detail);
  } else {
    logError(req, 'recycle_empty', 'bin', '', '', reason || detail);
  }
}

// 记录恢复公共文件/目录
function logPublicRestore(req, name, isDirectory, success, reason) {
  var type = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'public_restore', type, name, '', '从公共回收站恢复');
  } else {
    logError(req, 'public_restore', type, name, '', reason || '');
  }
}

// 记录永久删除公共回收站文件/目录
function logPublicPurge(req, name, isDirectory, success, reason) {
  var type = isDirectory ? 'directory' : 'file';
  if (success) {
    log(req, 'public_purge', type, name, '', '从公共回收站永久删除');
  } else {
    logError(req, 'public_purge', type, name, '', reason || '');
  }
}

// 记录清空公共回收站
function logPublicEmpty(req, fileCount, dirCount) {
  var detail = '清空公共回收站，共 ' + fileCount + ' 个文件，' + dirCount + ' 个目录';
  log(req, 'public_recycle_empty', 'bin', '', '', detail);
}

// 记录扫码登录
function logScanLogin(req, success, reason, userId) {
  var client = getClientInfo(req);
  if (success) {
    ActionLog.log(userId || 0, '', 'scan_login', 'user', '', '', client.ip, client.userAgent, 'success', reason || '');
  } else {
    ActionLog.log(0, '', 'scan_login_fail', 'user', '', '', client.ip, client.userAgent, 'error', reason || '');
  }
}

// 记录密码修改
function logChangePassword(req, success, reason) {
  if (success) {
    log(req, 'change_password', 'user', '', '', '');
  } else {
    logError(req, 'change_password', 'user', '', '', reason || '');
  }
}

// 记录文件重命名
function logRename(req, oldName, newName, targetId, success, reason) {
  if (success) {
    log(req, 'rename', 'file', oldName + ' -> ' + newName, String(targetId), '');
  } else {
    logError(req, 'rename', 'file', oldName + ' -> ' + newName, String(targetId), reason || '');
  }
}

// 记录目录重命名
function logRenameDir(req, oldName, newName, targetId, success, reason) {
  if (success) {
    log(req, 'rename', 'directory', oldName + ' -> ' + newName, String(targetId), '');
  } else {
    logError(req, 'rename', 'directory', oldName + ' -> ' + newName, String(targetId), reason || '');
  }
}

// 记录文件移动
function logMove(req, targetType, targetName, targetId, detail) {
  log(req, 'move', targetType, targetName, String(targetId), detail || '');
}

// 记录管理员操作
function logAdmin(req, action, targetType, targetName, targetId, detail) {
  var fullAction = 'admin_' + action;
  if (detail) {
    log(req, fullAction, targetType, targetName, targetId, detail);
  } else {
    log(req, fullAction, targetType, targetName, targetId, '');
  }
}

// 记录分享操作
function logShare(req, action, targetType, targetName, targetId) {
  log(req, action, targetType, targetName, String(targetId), '');
}

// ==================== 邮件日志 ====================

// 记录邮件发送（req 可能为 null，如定时任务场景）
function logEmail(toEmail, template, success, error, req) {
  var ip = '';
  if (req) {
    var info = getClientInfo(req);
    ip = info.ip;
  }
  EmailLog.log(toEmail, template, success ? 'success' : 'error', error || '', ip);
}

// 记录邮件发送失败
function logEmailError(toEmail, template, error, req) {
  logEmail(toEmail, template, false, error, req);
}

// ==================== 暴露给路由调用的完整接口 ====================
module.exports = {
  // 工具
  getClientInfo: getClientInfo,
  getUserInfo: getUserInfo,
  formatSize: formatSize,

  // 操作日志
  log: log,
  logError: logError,

  // 具体操作日志
  logLogin: logLogin,
  logLogout: logLogout,
  logRegister: logRegister,
  logUpload: logUpload,
  logDownload: logDownload,
  logDelete: logDelete,
  logCreateDir: logCreateDir,
  logRename: logRename,
  logRenameDir: logRenameDir,
  logMove: logMove,
  logPublicUpload: logPublicUpload,
  logPublicDelete: logPublicDelete,
  logPublicDownload: logPublicDownload,
  logRecycleDelete: logRecycleDelete,
  logRecycleRestore: logRecycleRestore,
  logRecyclePurge: logRecyclePurge,
  logRecycleEmpty: logRecycleEmpty,
  logPublicRestore: logPublicRestore,
  logPublicPurge: logPublicPurge,
  logPublicEmpty: logPublicEmpty,
  logChangePassword: logChangePassword,
  logAdmin: logAdmin,

  // 分享日志
  logShare: logShare,

  // 邮件日志
  logEmail: logEmail,
  logEmailError: logEmailError,

  // 扫码登录日志
  logScanLogin: logScanLogin
};
