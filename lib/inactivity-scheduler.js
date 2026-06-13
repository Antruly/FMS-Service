/**
 * WebDAV 调度器：不活跃禁用 + 到期提醒（按用户合并发送）
 * 每小时检查一次。
 * 同一用户的所有链接的条件合并为一封邮件。
 * 每个用户每天最多收一封邮件（Redis key: email:{userId}:{YYYY-MM-DD}）。
 *
 * 条件：
 *   - renewal：到期前 30 天可续期（仅 ≥90 天的长期链接，30天链接不发）
 *   - expiring：到期前 3 天
 *   - expired：已过期
 *   - inactive_warn：30 天无访问 → 告警
 *   - inactive_disabled：33 天无访问 → 自动禁用
 */

var log = require('./log');
var inactivityTimer = null;

function getRedis() {
  try {
    var redis = require('./redis');
    return redis.getRedisClient ? redis.getRedisClient() : null;
  } catch(e) { return null; }
}

function checkInactivity() {
  var db, emailLib;
  try { db = require('./db'); } catch(e) { log.error('[Scheduler] db 加载失败'); return; }
  try { emailLib = require('./email'); } catch(e) { log.warn('[Scheduler] 邮件模块未加载'); }
  var redis = getRedis();
  var now = new Date();
  var nowISO = now.toISOString();
  var today = nowISO.substring(0, 10);

  var DAY30 = 30 * 24 * 3600 * 1000;
  var DAY33 = 33 * 24 * 3600 * 1000;
  var DAY3  =  3 * 24 * 3600 * 1000;

  var allLinks;
  try {
    allLinks = db.query(
      'SELECT w.*, u.email, u.nickname, u.email_reminder FROM webdav_links w ' +
      'LEFT JOIN users u ON w.user_id = u.id WHERE u.is_active = 1'
    );
  } catch(e) { log.error('[Scheduler] 查询失败:', e.message); return; }

  // ---- 按用户分组 ----
  var userMap = {}; // { userId: { email, nickname, email_reminder, links: [{item, conditions}] } }
  allLinks.forEach(function(l) {
    var uid = l.user_id;
    if (!userMap[uid]) {
      userMap[uid] = { email: l.email, nickname: l.nickname, email_reminder: l.email_reminder, links: [] };
    }
    var tokenPrefix = (l.token || '').substring(0, 8);
    var userWantsEmail = l.email_reminder && l.email;
    var item = {
      target_name: l.target_name || l.link_name,
      target_path: l.target_path,
      token: l.token,
      expires_at: l.expires_at,
      created_at: l.created_at,
      days_inactive: 0
    };
    var conditions = [];

    // -- 不活跃 --
    if (!l.last_accessed) {
      db.run('UPDATE webdav_links SET last_accessed = ? WHERE id = ?', [nowISO, l.id]);
      l.last_accessed = nowISO;
    }
    var lastAccess = new Date(l.last_accessed);
    item.days_inactive = Math.floor((now - lastAccess) / (24 * 3600 * 1000));

    if (!l.disabled && lastAccess < new Date(now.getTime() - DAY33)) {
      log.info('[Scheduler] ' + tokenPrefix + '... ' + item.days_inactive + '天无访问 → 自动禁用');
      db.run("UPDATE webdav_links SET disabled = 1, disabled_at = ?, disabled_by = 'system' WHERE id = ?",
        [nowISO, l.id]);
      l.disabled = 1;
      if (userWantsEmail) conditions.push('inactive_disabled');
    } else if (!l.disabled && lastAccess < new Date(now.getTime() - DAY30) &&
               (l.expires_at === null || new Date(l.expires_at) > now)) {
      if (userWantsEmail) conditions.push('inactive_warn');
    }

    // -- 到期（仅未禁用的） --
    if (!l.disabled && l.expires_at) {
      var expiresAt = new Date(l.expires_at);
      var remainingMs = expiresAt - now;
      var createdDate = l.created_at ? new Date(l.created_at) : null;
      var totalDays = createdDate ? Math.ceil((expiresAt - createdDate) / (24 * 3600 * 1000)) : 0;

      if (remainingMs <= 0) {
        if (userWantsEmail) conditions.push('expired');
      } else if (remainingMs <= DAY3) {
        if (userWantsEmail) conditions.push('expiring');
      } else if (remainingMs <= DAY30 && totalDays >= 90) {
        if (userWantsEmail) conditions.push('renewal');
      }
    }

    if (conditions.length > 0) {
      userMap[uid].links.push({ item: item, conditions: conditions });
    }
  });

  // ---- 按用户发送合并邮件 ----
  Object.keys(userMap).forEach(function(uid) {
    var user = userMap[uid];
    if (!user.email || user.links.length === 0) return;
    var dailyKey = 'email:' + uid + ':' + today;
    checkAndSend(redis, dailyKey, function() {
      log.info('[Scheduler] 用户 ' + user.email + ' 有 ' + user.links.length + ' 个链接触发提醒');
      if (emailLib) {
        emailLib.sendUserCombinedNotice(user.email, user.links).catch(function(err) {
          log.error('[Scheduler] 发送失败(' + user.email + '):', err.message);
        });
      }
    }, 24 * 3600);
  });

  log.debug('[Scheduler] 检查完成');
}

function checkAndSend(redis, key, fn, ttl) {
  if (!redis) { fn(); return; }
  redis.get(key).then(function(val) {
    if (val) return;
    fn();
    redis.setex(key, ttl, '1').catch(function() {});
  }).catch(function() { fn(); });
}

function startInactivityScheduler() {
  if (inactivityTimer) return;
  var interval = 3600000;
  inactivityTimer = setTimeout(function run() {
    checkInactivity();
    inactivityTimer = setTimeout(run, interval);
  }, 120000);
  log.info('[Scheduler] 已启动（按用户合并，每用户每天最多一封）');
}
function stopInactivityScheduler() {
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
}
function runOnce() { return checkInactivity(); }

module.exports = { startInactivityScheduler, stopInactivityScheduler, runOnce };
