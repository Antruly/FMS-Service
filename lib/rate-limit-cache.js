// ==================== 频率限制规则缓存 ====================
// 避免每次请求都查询数据库，规则变更时通过 reload() 刷新

var cache = {
  authenticated: [],   // { window_seconds, max_requests, ban_duration_seconds }
  anonymous: [],
  whitelist: []        // [ { path } ]
};

var loaded = false;

/**
 * 从数据库加载规则到内存缓存
 */
function loadRules() {
  try {
    var db = require('./db');
    var rules = db.RateLimitRules.getAll();
    var auth = [], anon = [];
    rules.forEach(function(r) {
      if (!r.is_enabled) return;
      var entry = {
        id: r.id,
        window_seconds: r.window_seconds,
        max_requests: r.max_requests,
        ban_duration_seconds: r.ban_duration_seconds,
        sort_order: r.sort_order
      };
      if (r.user_type === 'authenticated') {
        auth.push(entry);
      } else if (r.user_type === 'anonymous') {
        anon.push(entry);
      }
    });
    // 按 sort_order 升序排列（阈值从低到高）
    auth.sort(function(a, b) { return a.sort_order - b.sort_order; });
    anon.sort(function(a, b) { return a.sort_order - b.sort_order; });
    cache.authenticated = auth;
    cache.anonymous = anon;

    // 加载白名单
    var whitelist = db.RateLimitWhitelist.getEnabled();
    cache.whitelist = whitelist.map(function(w) { return w.path; });

    loaded = true;
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('[RateLimitCache] 已加载 ' + auth.length + ' 条已登录规则, ' + anon.length + ' 条未登录规则, ' + cache.whitelist.length + ' 条白名单');
    }
  } catch (e) {
    console.error('[RateLimitCache] 加载失败:', e.message);
  }
}

/**
 * 获取指定用户类型的规则列表（按阈值从低到高排序，0=永久在最后）
 */
function getRules(userType) {
  if (!loaded) loadRules();
  return cache[userType] || [];
}

/**
 * 获取白名单路径列表
 */
function getWhitelist() {
  if (!loaded) loadRules();
  return cache.whitelist;
}

/**
 * 检查路径是否在白名单中
 */
function isWhitelisted(requestPath) {
  var wl = getWhitelist();
  for (var i = 0; i < wl.length; i++) {
    var p = wl[i];
    if (p === requestPath) return true;
    // 支持前缀匹配：配置 /api/ 可匹配所有 /api/* 路径
    if (p.endsWith('/') && requestPath.startsWith(p)) return true;
    // 精确匹配
    if (requestPath === p) return true;
  }
  return false;
}

/**
 * 强制重新加载规则（API 修改规则后调用）
 */
function reload() {
  loaded = false;
  loadRules();
}

// 暴露 reload 给 API 路由使用
global.__rateLimitReload = reload;

module.exports = {
  loadRules: loadRules,
  getRules: getRules,
  getWhitelist: getWhitelist,
  isWhitelisted: isWhitelisted,
  reload: reload
};
