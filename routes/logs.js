var log = require('../lib/log');
/**
 * 日志管理 API 路由（仅管理员可用）
 */
const express = require('express');
const router = express.Router();
const { ActionLog, EmailLog, User, query } = require('../lib/db');
const utils = require('../lib/utils');
const logger = require('../lib/logger');

// ==================== 中间件 ====================

// 仅管理员可访问
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return utils.error(res, '请先登录', 401);
  }
  var user = User.findById(req.session.userId);
  if (!user) { req.session.destroy(function() {}); return utils.error(res, '请先登录', 401); }
  if (!user.is_active) { req.session.destroy(function() {}); return utils.error(res, '账号已被禁用', 403); }
  req._user = user;
  if (!user.is_admin) {
    return utils.error(res, '权限不足，仅管理员可访问', 403);
  }
  next();
}

// ==================== 操作日志 ====================

// 获取操作日志列表
router.get('/actions', requireAdmin, function(req, res) {
  try {
    var opts = {
      userId: req.query.userId ? Number(req.query.userId) : null,
      email: req.query.email || null,
      action: req.query.action || null,
      status: req.query.status || null,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
      order: req.query.order || 'DESC'
    };

    // 安全限制 limit
    if (opts.limit > 500) opts.limit = 500;
    if (opts.limit < 1) opts.limit = 100;

    var result = ActionLog.list(opts);

    // 格式化数据
    var formattedData = result.data.map(function(item) {
      return {
        id: item.id,
        userId: item.user_id,
        email: item.email,
        action: item.action,
        actionText: actionTextMap[item.action] || item.action,
        targetType: item.target_type,
        targetName: item.target_name,
        targetId: item.target_id,
        ip: item.ip,
        userAgent: item.user_agent,
        status: item.status,
        detail: item.detail,
        createdAt: formatTimestamp(item.created_at) || '(时间缺失)'
      };
    });

    utils.success(res, {
      data: formattedData,
      total: result.total,
      limit: opts.limit,
      offset: opts.offset
    });
  } catch (err) {
    log.error('[Logs] 获取操作日志失败:', err);
    utils.error(res, '获取日志失败');
  }
});

// 获取操作类型统计
router.get('/actions/stats', requireAdmin, function(req, res) {
  try {
    // 今日数量
    var today = query('SELECT COUNT(*) as count FROM action_logs WHERE date(created_at) = date("now")');
    var todayCount = today && today[0] ? today[0].count : 0;

    // 本周数量
    var week = query('SELECT COUNT(*) as count FROM action_logs WHERE created_at >= datetime("now", "-7 days")');
    var weekCount = week && week[0] ? week[0].count : 0;

    // 本月数量
    var month = query('SELECT COUNT(*) as count FROM action_logs WHERE created_at >= datetime("now", "-30 days")');
    var monthCount = month && month[0] ? month[0].count : 0;

    // 按操作类型统计（最近30天）
    var byAction = query(
      'SELECT action, COUNT(*) as count FROM action_logs WHERE created_at >= datetime("now", "-30 days") GROUP BY action ORDER BY count DESC'
    );

    // 按状态统计（最近30天）
    var byStatus = query(
      'SELECT status, COUNT(*) as count FROM action_logs WHERE created_at >= datetime("now", "-30 days") GROUP BY status ORDER BY count DESC'
    );

    // 按用户统计（最近30天）
    var byUser = query(
      'SELECT email, COUNT(*) as count FROM action_logs WHERE created_at >= datetime("now", "-30 days") GROUP BY email ORDER BY count DESC LIMIT 10'
    );

    utils.success(res, {
      today: todayCount,
      week: weekCount,
      month: monthCount,
      byAction: byAction || [],
      byStatus: byStatus || [],
      byUser: byUser || []
    });
  } catch (err) {
    log.error('[Logs] 获取操作统计失败:', err);
    utils.error(res, '获取统计失败');
  }
});

// 获取所有操作类型（用于筛选下拉）
router.get('/actions/types', requireAdmin, function(req, res) {
  try {
    var actions = ActionLog.getActions();
    var formatted = (actions || []).map(function(item) {
      return {
        action: item.action,
        text: actionTextMap[item.action] || item.action
      };
    });
    utils.success(res, formatted);
  } catch (err) {
    utils.error(res, '获取类型失败');
  }
});

// 清理操作日志
router.delete('/actions', requireAdmin, function(req, res) {
  try {
    var days = req.query.days ? Number(req.query.days) : 90;
    if (days < 1) days = 1;
    if (days > 365) days = 365;

    if (req.query.clearAll === 'true') {
      // 清空全部
      var result = ActionLog.clearAll();
      logger.logAdmin(req, 'clear_action_logs', 'action_logs', '全部', '', '清空全部操作日志');
      utils.success(res, null, '已清空全部操作日志，共删除 ' + result.changes + ' 条');
    } else {
      // 按天数清理
      var result = ActionLog.deleteOld(days);
      logger.logAdmin(req, 'delete_action_logs', 'action_logs', days + '天前', '', '清理 ' + days + ' 天前的日志');
      utils.success(res, null, '已清理 ' + days + ' 天前的操作日志');
    }
  } catch (err) {
    log.error('[Logs] 清理操作日志失败:', err);
    utils.error(res, '清理失败');
  }
});

// ==================== 邮件日志 ====================

// 获取邮件发送日志列表
router.get('/emails', requireAdmin, function(req, res) {
  try {
    var opts = {
      toEmail: req.query.email || null,
      template: req.query.template || null,
      status: req.query.status || null,
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0
    };

    if (opts.limit > 500) opts.limit = 500;
    if (opts.limit < 1) opts.limit = 100;

    var result = EmailLog.list(opts);

    var formattedData = result.data.map(function(item) {
      return {
        id: item.id,
        toEmail: item.to_email,
        template: item.template,
        templateText: emailTemplateTextMap[item.template] || item.template,
        status: item.status,
        error: item.error,
        ip: item.ip,
        createdAt: formatTimestamp(item.created_at) || '(时间缺失)'
      };
    });

    utils.success(res, {
      data: formattedData,
      total: result.total,
      limit: opts.limit,
      offset: opts.offset
    });
  } catch (err) {
    log.error('[Logs] 获取邮件日志失败:', err);
    utils.error(res, '获取日志失败');
  }
});

// 获取邮件类型统计
router.get('/emails/stats', requireAdmin, function(req, res) {
  try {
    var today = query('SELECT COUNT(*) as count FROM email_logs WHERE date(created_at) = date("now")');
    var todayCount = today && today[0] ? today[0].count : 0;

    var week = query('SELECT COUNT(*) as count FROM email_logs WHERE created_at >= datetime("now", "-7 days")');
    var weekCount = week && week[0] ? week[0].count : 0;

    var month = query('SELECT COUNT(*) as count FROM email_logs WHERE created_at >= datetime("now", "-30 days")');
    var monthCount = month && month[0] ? month[0].count : 0;

    var byTemplate = query(
      'SELECT template, COUNT(*) as count FROM email_logs WHERE created_at >= datetime("now", "-30 days") GROUP BY template ORDER BY count DESC'
    );

    var byStatus = query(
      'SELECT status, COUNT(*) as count FROM email_logs WHERE created_at >= datetime("now", "-30 days") GROUP BY status ORDER BY count DESC'
    );

    var failed = query(
      'SELECT COUNT(*) as count FROM email_logs WHERE status = "error" AND created_at >= datetime("now", "-30 days")'
    );
    var failedCount = failed && failed[0] ? failed[0].count : 0;

    utils.success(res, {
      today: todayCount,
      week: weekCount,
      month: monthCount,
      failed: failedCount,
      byTemplate: byTemplate || [],
      byStatus: byStatus || []
    });
  } catch (err) {
    log.error('[Logs] 获取邮件统计失败:', err);
    utils.error(res, '获取统计失败');
  }
});

// 获取邮件类型（用于筛选）
router.get('/emails/types', requireAdmin, function(req, res) {
  try {
    var templates = EmailLog.getTemplates();
    var formatted = (templates || []).map(function(item) {
      return {
        template: item.template,
        text: emailTemplateTextMap[item.template] || item.template
      };
    });
    utils.success(res, formatted);
  } catch (err) {
    utils.error(res, '获取类型失败');
  }
});

// 清理邮件日志
router.delete('/emails', requireAdmin, function(req, res) {
  try {
    var days = req.query.days ? Number(req.query.days) : 180;
    if (days < 1) days = 1;
    if (days > 365) days = 365;

    if (req.query.clearAll === 'true') {
      var result = EmailLog.clearAll();
      logger.logAdmin(req, 'clear_email_logs', 'email_logs', '全部', '', '清空全部邮件日志');
      utils.success(res, null, '已清空全部邮件日志，共删除 ' + result.changes + ' 条');
    } else {
      var result = EmailLog.deleteOld(days);
      logger.logAdmin(req, 'delete_email_logs', 'email_logs', days + '天前', '', '清理 ' + days + ' 天前的日志');
      utils.success(res, null, '已清理 ' + days + ' 天前的邮件日志');
    }
  } catch (err) {
    log.error('[Logs] 清理邮件日志失败:', err);
    utils.error(res, '清理失败');
  }
});

function formatTimestamp(ts) {
  if (!ts) return '';
  // 如果是 ISO UTC 格式 ("2026-04-07T09:24:01.000Z")
  if (typeof ts === 'string' && ts.indexOf('T') !== -1) {
    // 直接格式化为北京时间字符串
    var d = new Date(ts);
    var cstMs = d.getTime() + 8 * 3600 * 1000;
    var cst = new Date(cstMs);
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    return cst.getUTCFullYear() + '-' + pad(cst.getUTCMonth() + 1) + '-' + pad(cst.getUTCDate())
      + ' ' + pad(cst.getUTCHours()) + ':' + pad(cst.getUTCMinutes()) + ':' + pad(cst.getUTCSeconds());
  }
  // 已经是格式化字符串（如旧数据 "2026-04-07 09:24:01"），直接返回
  return String(ts);
}
var actionTextMap = {
  'login': '登录',
  'login_fail': '登录失败',
  'logout': '登出',
  'register': '注册',
  'register_fail': '注册失败',
  'upload': '上传文件',
  'download': '下载文件',
  'delete': '删除',
  'create_dir': '创建目录',
  'rename': '重命名',
  'move': '移动',
  'public_upload': '上传公共文件',
  'public_download': '下载公共文件',
  'public_delete': '删除公共文件/目录',
  'recycle_delete': '移入回收站',
  'recycle_restore': '恢复文件',
  'recycle_purge': '永久删除',
  'recycle_empty': '清空回收站',
  'change_password': '修改密码',
  'admin_update_quota': '管理员修改配额',
  'admin_set_admin': '管理员设置管理员',
  'admin_set_active': '管理员设置用户状态',
  'admin_update_perms': '管理员更新权限',
  'admin_delete_user': '管理员删除用户',
  'admin_clear_action_logs': '管理员清空操作日志',
  'admin_delete_action_logs': '管理员清理操作日志',
  'admin_clear_email_logs': '管理员清空邮件日志',
  'admin_delete_email_logs': '管理员清理邮件日志'
};

// 邮件模板 -> 中文描述
var emailTemplateTextMap = {
  'register': '注册验证码',
  'login': '登录验证码',
  'reset': '密码重置验证码',
  'notify': '通知邮件'
};

module.exports = router;
