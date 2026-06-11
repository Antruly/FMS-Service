var log = require('../lib/log');
const express = require('express');
const router = express.Router();
const { User } = require('../lib/db');
const { VerifyCode, LoginError, ResetAttempt } = require('../lib/redis');
const emailService = require('../lib/email');
const utils = require('../lib/utils');
const config = require('../config');
const logger = require('../lib/logger');

// ===================== 设备受信/错误追踪 =====================
function markDeviceTrusted(email, deviceId) {
  if (!deviceId) return;
  try { var b = require('../lib/redis').getBackend(); var be = b(); if (be) be.setex('ambush:trusted_device:' + email + ':' + deviceId, 90*24*3600, '1'); } catch(e) {}
}
function isDeviceTrusted(email, deviceId) {
  return new Promise(function(resolve) {
    if (!deviceId) return resolve(false);
    try { var b = require('../lib/redis').getBackend(); var be = b(); if (!be) return resolve(false);
      be.get('ambush:trusted_device:' + email + ':' + deviceId).then(function(r) { resolve(!!r); }).catch(function() { resolve(false); });
    } catch(e) { resolve(false); }
  });
}
function markDeviceError(deviceId) {
  if (!deviceId) return;
  try { var b = require('../lib/redis').getBackend(); var be = b(); if (be) be.setex('ambush:device_error:' + deviceId, 7*24*3600, '1'); } catch(e) {}
}
function checkDeviceError(deviceId) {
  return new Promise(function(resolve) {
    if (!deviceId) return resolve(false);
    try { var b = require('../lib/redis').getBackend(); var be = b(); if (!be) return resolve(false);
      be.get('ambush:device_error:' + deviceId).then(function(r) { resolve(!!r); }).catch(function() { resolve(false); });
    } catch(e) { resolve(false); }
  });
}

// 发验证码前检查是否需要图形验证码
async function requireCaptchaForSendCode(email, deviceId, captchaToken) {
  var trusted = deviceId ? await isDeviceTrusted(email, deviceId) : false;
  var deviceHasErr = deviceId ? await checkDeviceError(deviceId) : false;
  var needCaptcha = !trusted || deviceHasErr;
  if (!needCaptcha) return { ok: true };
  if (!captchaToken) return { ok: false, needCaptcha: true };
  var captchaOk = await VerifyCode.get(captchaToken, 'captcha_ok');
  if (!captchaOk) return { ok: false, needCaptcha: true, message: '图形验证码已过期，请重新验证' };
  // 一次性消费
  await VerifyCode.del(captchaToken, 'captcha_ok');
  return { ok: true };
}

// ===================== 注册 =====================
// 发送注册验证码
router.post('/send-register-code', async function(req, res) {
  try {
    const { email, captchaToken } = req.body;

    if (!email) {
      return utils.error(res, '请输入邮箱地址');
    }

    if (!utils.isValidEmail(email)) {
      return utils.error(res, '邮箱格式不正确');
    }

    // 图形验证码检查
    var deviceId = req.headers['x-device-id'] || '';
    var captchaCheck = await requireCaptchaForSendCode(email, deviceId, captchaToken);
    if (!captchaCheck.ok) {
      return utils.error(res, captchaCheck.message || '需要图形验证码', 400, { needCaptcha: true });
    }

    // 检查是否已注册
    if (User.exists(email)) {
      return utils.error(res, '该邮箱已注册，请直接登录');
    }

    // 检查发送频率
    const canSend = await VerifyCode.canSend(email, 'register');
    if (!canSend) {
      return utils.error(res, '发送太频繁，请60秒后再试');
    }

    // 生成验证码
    const code = VerifyCode.generate();
    await VerifyCode.set(email, 'register', code);
    await VerifyCode.setSendLimit(email, 'register');

    // 发送邮件
    try {
      await emailService.sendVerifyCode(email, code);
      logger.logEmail(email, 'register', true, '', req);
    } catch (e) {
      logger.logEmailError(email, 'register', e.message, req);
      return utils.error(res, '邮件发送失败，请稍后重试');
    }

    utils.success(res, null, '验证码已发送');
  } catch (err) {
    log.error('发送注册验证码错误:', err);
    utils.error(res, '发送失败，请稍后重试');
  }
});

// 注册
router.post('/register', async function(req, res) {
  try {
    // 首次初始化：用户表为空时禁止注册，必须先完成系统初始化
    if (User.count() === 0) {
      return utils.error(res, '请先完成系统初始化');
    }

    const { email, password, code, nickname } = req.body;

    // 参数校验
    if (!email || !password || !code) {
      return utils.error(res, '请填写完整信息');
    }

    if (!utils.isValidEmail(email)) {
      return utils.error(res, '邮箱格式不正确');
    }

    const pwdResult = utils.validatePassword(password);
    if (!pwdResult.valid) {
      return utils.error(res, pwdResult.errors.join('；'));
    }

    // 检查是否已注册
    if (User.exists(email)) {
      return utils.error(res, '该邮箱已注册');
    }

    // 验证验证码
    const valid = await VerifyCode.verify(email, 'register', code);
    if (!valid) {
      return utils.error(res, '验证码错误或已过期');
    }

    // 创建用户
    const userId = User.create(email, password, nickname);
    if (!userId) {
      logger.logRegister(req, false, '创建用户失败');
      return utils.error(res, '注册失败，请稍后重试');
    }

    // 删除验证码
    await VerifyCode.del(email, 'register');

    // 自动登录（先生成新 Session ID 防止会话固定攻击）
    req.session.regenerate(function(err) {
      if (err) {
        log.error('注册后 Session 重建失败:', err);
        return utils.error(res, '注册失败，请稍后重试');
      }
      req.session.userId = userId;
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
      req.session._csrfJustGenerated = true;  // 标记：客户端尚未获取此 token，首次 POST 放行
      const user = User.findById(userId);
      req._user = user;
      logger.logRegister(req, true, '注册并自动登录');
      utils.success(res, { user: user, csrfToken: req.session.csrfToken }, '注册成功');
    });
  } catch (err) {
    log.error('注册错误:', err);
    utils.error(res, '注册失败，请稍后重试');
  }
});

// ===================== 登录 =====================
// 发送登录验证码（错误3次后）
router.post('/send-login-code', async function(req, res) {
  try {
    const { email, captchaToken } = req.body;

    if (!email) {
      return utils.error(res, '请输入邮箱地址');
    }

    // 检查用户是否存在
    const user = User.findByEmail(email);
    if (!user) {
      return utils.error(res, '用户不存在');
    }

    // 图形验证码检查
    var deviceId = req.headers['x-device-id'] || '';
    var captchaCheck = await requireCaptchaForSendCode(email, deviceId, captchaToken);
    if (!captchaCheck.ok) {
      return utils.error(res, captchaCheck.message || '需要图形验证码', 400, { needCaptcha: true });
    }

    const canSend = await VerifyCode.canSend(email, 'login');
    if (!canSend) {
      return utils.error(res, '发送太频繁，请60秒后再试');
    }

    const code = VerifyCode.generate();
    await VerifyCode.set(email, 'login', code);
    await VerifyCode.setSendLimit(email, 'login');

    try {
      await emailService.sendVerifyCode(email, code);
      logger.logEmail(email, 'login', true, '', req);
    } catch (e) {
      logger.logEmailError(email, 'login', e.message, req);
      return utils.error(res, '邮件发送失败，请稍后重试');
    }

    utils.success(res, null, '验证码已发送');
  } catch (err) {
    log.error('发送登录验证码错误:', err);
    utils.error(res, '发送失败，请稍后重试');
  }
});

// 登录
router.post('/login', async function(req, res) {
  try {
    const { email, password, code, captchaToken } = req.body;

    // 验证码登录不需要密码
    if (!email || (!password && !code)) {
      return utils.error(res, '请填写完整信息');
    }

    // 检查是否被锁定
    const isLocked = await LoginError.isLocked(email);
    if (isLocked) {
      const ttl = await LoginError.getTTL(email);
      logger.logLogin(req, false, '账号被锁定，TTL=' + ttl + 's');
      return utils.error(res, '登录失败次数过多，请 ' + ttl + ' 秒后再试');
    }

    const user = User.findByEmail(email);
    if (!user) {
      await LoginError.inc(email);
      const count = await LoginError.getCount(email);
      if (count >= config.security.maxLoginErrors) {
        logger.logLogin(req, false, '用户不存在，已错误' + count + '次');
        return utils.error(res, '登录失败次数过多，请1分钟后再试');
      }
      logger.logLogin(req, false, '用户不存在');
      return utils.error(res, '邮箱或密码错误');
    }

    // 检查用户封禁状态（包括临时封禁自动解封检查）
    const banInfo = User.isEffectivelyBanned(user.id);
    if (banInfo.banned) {
      let msg = '账号已被封禁';
      if (banInfo.expires_at) {
        const remaining = Math.ceil((new Date(banInfo.expires_at) - new Date()) / 1000 / 60);
        if (remaining > 0) {
          msg += '，将于 ' + remaining + ' 分钟后自动解封';
        } else {
          msg = '账号已解封，请重新登录';
        }
      } else {
        msg += '（永久封禁）';
      }
      if (banInfo.reason) msg += '，原因: ' + banInfo.reason;
      logger.logLogin(req, false, msg);
      return utils.error(res, msg);
    }

    // 图形验证码 token 验证（优先于邮箱验证码）
    var captchaVerified = false;
    if (captchaToken) {
      var captchaOk = await VerifyCode.get(captchaToken, 'captcha_ok');
      if (captchaOk) {
        captchaVerified = true;
        await VerifyCode.del(captchaToken, 'captcha_ok'); // 一次性使用
      }
    }

    // 如果有邮箱验证码要求
    if (code) {
      const valid = await VerifyCode.verify(email, 'login', code);
      if (!valid) {
        logger.logLogin(req, false, '验证码错误');
        return utils.error(res, '验证码错误或已过期');
      }
    } else if (!captchaVerified) {
      // 既无邮箱验证码也无图形验证码 → 检查是否需要验证码
      var isLockedForCaptcha = await LoginError.getCount(email);
      var devId2 = req.headers['x-device-id'] || '';
      var deviceTrusted = devId2 ? await isDeviceTrusted(email, devId2) : false;
      var deviceHasErr = devId2 ? await checkDeviceError(devId2) : false;
      var needShapeCaptcha = !deviceTrusted || deviceHasErr || isLockedForCaptcha >= 1;

      if (needShapeCaptcha && isLockedForCaptcha < config.security.maxLoginErrors) {
        // 需要图形验证码但未提供
        return utils.error(res, '需要图形验证码', 400, { needCaptcha: true, errorCount: isLockedForCaptcha });
      }

      if (isLockedForCaptcha >= config.security.maxLoginErrors) {
        logger.logLogin(req, false, '需要验证码但未提供');
        return utils.error(res, '请输入验证码');
      }

      if (!User.checkPassword(user, password)) {
        await LoginError.inc(email);
        var devId = req.headers['x-device-id'] || '';
        if (devId) markDeviceError(devId);
        const count = await LoginError.getCount(email);
        if (count >= config.security.maxLoginErrors) {
          logger.logLogin(req, false, '密码错误，已错误' + count + '次');
          return utils.error(res, '密码错误次数过多，请输入验证码');
        }
        logger.logLogin(req, false, '密码错误');
        return utils.error(res, '邮箱或密码错误');
      }
    } else if (captchaVerified && !code) {
      // 图形验证码通过，直接验证密码
      if (!User.checkPassword(user, password)) {
        await LoginError.inc(email);
        var devId3 = req.headers['x-device-id'] || '';
        if (devId3) markDeviceError(devId3);
        const count = await LoginError.getCount(email);
        if (count >= config.security.maxLoginErrors) {
          logger.logLogin(req, false, '密码错误，已错误' + count + '次');
          return utils.error(res, '密码错误次数过多，请输入验证码');
        }
        logger.logLogin(req, false, '密码错误');
        return utils.error(res, '邮箱或密码错误');
      }
    }


    // 登录成功（先生成新 Session ID 防止会话固定攻击）
    await LoginError.clear(email);
    User.updateLogin(user.id);

    req.session.regenerate(function(err) {
      if (err) {
        log.error('登录后 Session 重建失败:', err);
        return utils.error(res, '登录失败，请稍后重试');
      }
      req.session.userId = user.id;
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
      req.session._csrfJustGenerated = true;
      req._user = User.findById(user.id);
      logger.logLogin(req, true, '登录成功');
      // 标记设备为受信
      var deviceId = req.headers['x-device-id'] || '';
      if (deviceId) markDeviceTrusted(email, deviceId);
      // Record session for device management
      var rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');
      var deviceId = req.headers['x-device-id'] || '';
      var ua = req.headers['user-agent'] || '';
      var isMobile = /Android|iPhone|iPad/i.test(ua);
      var sessInfo = { ip: rawIp, userAgent: ua, device: isMobile ? '手机' : '电脑', deviceId: deviceId || '' };
      require('../lib/redis').SessionTracker.addSession(user.id, req.sessionID, sessInfo);
      utils.success(res, { user: req._user, csrfToken: req.session.csrfToken }, '登录成功');
    });
  } catch (err) {
    log.error('登录错误:', err);
    utils.error(res, '登录失败，请稍后重试');
  }
});

// 获取登录错误次数（用于前端判断是否显示验证码）
router.get('/login-error-count', async function(req, res) {
  try {
    const { email } = req.query;
    var deviceId = req.headers['x-device-id'] || req.query.device_id || '';
    if (!email) {
      return utils.success(res, { count: 0, needCaptcha: false });
    }
    const count = await LoginError.getCount(email);
    // 检查设备是否受信 + 设备是否有错误记录
    var trusted = deviceId ? await isDeviceTrusted(email, deviceId) : false;
    var deviceHasError = deviceId ? await checkDeviceError(deviceId) : false;
    // 新设备 或 设备有错误记录 或 错误>=1 → 需要验证码
    var needCaptcha = !trusted || deviceHasError || count >= 1;
    utils.success(res, {
      count: count,
      needCaptcha: needCaptcha,
      isNewDevice: !trusted
    });
  } catch (err) {
    utils.success(res, { count: 0, needCaptcha: false });
  }
});

// ===================== 找回密码 =====================
// 发送重置密码验证码
router.post('/send-reset-code', async function(req, res) {
  try {
    const { email, captchaToken } = req.body;

    if (!email) {
      return utils.error(res, '请输入邮箱地址');
    }

    if (!utils.isValidEmail(email)) {
      return utils.error(res, '邮箱格式不正确');
    }

    // 图形验证码检查
    var deviceId = req.headers['x-device-id'] || '';
    var captchaCheck = await requireCaptchaForSendCode(email, deviceId, captchaToken);
    if (!captchaCheck.ok) {
      return utils.error(res, captchaCheck.message || '需要图形验证码', 400, { needCaptcha: true });
    }

    // 必须验证是已注册用户才会发送验证码
    const user = User.findByEmail(email);
    if (!user) {
      return utils.error(res, '该邮箱未注册，请先注册');
    }

    const canSend = await VerifyCode.canSend(email, 'reset');
    if (!canSend) {
      return utils.error(res, '发送太频繁，请60秒后再试');
    }

    const code = VerifyCode.generate();
    await VerifyCode.set(email, 'reset', code);
    await VerifyCode.setSendLimit(email, 'reset');

    try {
      await emailService.sendResetPasswordCode(email, code);
      logger.logEmail(email, 'reset', true, '', req);
    } catch (e) {
      logger.logEmailError(email, 'reset', e.message, req);
      return utils.error(res, '邮件发送失败，请稍后重试');
    }

    utils.success(res, null, '验证码已发送');
  } catch (err) {
    log.error('发送重置验证码错误:', err);
    utils.error(res, '发送失败，请稍后重试');
  }
});

// 重置密码
router.post('/reset-password', async function(req, res) {
  try {
    const { email, password, code } = req.body;

    if (!email || !password || !code) {
      return utils.error(res, '请填写完整信息');
    }

    // 检查验证次数是否超限（1分钟3次）
    const isLimited = await ResetAttempt.isLimited(email);
    if (isLimited) {
      const ttl = await ResetAttempt.getTTL(email);
      return utils.error(res, '验证失败次数过多，请在 ' + ttl + ' 秒后再试');
    }

    const pwdResult = utils.validatePassword(password);
    if (!pwdResult.valid) {
      return utils.error(res, pwdResult.errors.join('；'));
    }

    const valid = await VerifyCode.verify(email, 'reset', code);
    if (!valid) {
      // 验证失败，记录错误次数
      await ResetAttempt.inc(email);
      const count = await ResetAttempt.getCount(email);
      const remaining = 3 - count;
      if (remaining > 0) {
        return utils.error(res, '验证码错误或已过期，剩余 ' + remaining + ' 次验证机会');
      } else {
        const ttl = await ResetAttempt.getTTL(email);
        return utils.error(res, '验证失败次数过多，请在 ' + ttl + ' 秒后再试');
      }
    }

    // 验证成功，清除错误计数
    await ResetAttempt.clear(email);
    User.updatePassword(email, password);
    await VerifyCode.del(email, 'reset');

    utils.success(res, null, '密码重置成功，请使用新密码登录');
  } catch (err) {
    log.error('重置密码错误:', err);
    utils.error(res, '操作失败，请稍后重试');
  }
});

// ===================== 个人信息修改 =====================
// 修改密码（需要旧密码验证）
router.post('/change-password', utils.requireAuth, function(req, res) {
  try {
    var user = User.findById(req.session.userId);
    if (!user) return utils.error(res, '用户不存在', 401);
    req._user = user;

    var { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return utils.error(res, '请填写完整信息');
    }

    var pwdResult = utils.validatePassword(newPassword);
    if (!pwdResult.valid) {
      return utils.error(res, pwdResult.errors.join('；'));
    }

    var result = User.changePassword(req.session.userId, oldPassword, newPassword);
    if (!result.ok) {
      logger.logChangePassword(req, false, result.message);
      return utils.error(res, result.message);
    }

    logger.logChangePassword(req, true);
    utils.success(res, null, '密码修改成功');
  } catch (err) {
    log.error('修改密码错误:', err);
    utils.error(res, '操作失败，请稍后重试');
  }
});

// 获取当前用户信息
router.get('/me', utils.requireAuth, function(req, res) {
  try {
    var user = User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return utils.error(res, '用户不存在', 401);
    }
    utils.success(res, { user: user });
  } catch (err) {
    log.error('获取用户信息错误:', err);
    utils.error(res, '获取用户信息失败');
  }
});

// ===================== 用户信息 =====================
// 获取当前用户信息
router.get('/me', utils.requireAuth, function(req, res) {
  try {
    const user = User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return utils.error(res, '用户不存在', 401);
    }
    utils.success(res, { user: user });
  } catch (err) {
    log.error('获取用户信息错误:', err);
    utils.error(res, '获取用户信息失败');
  }
});

// 登出
router.post('/logout', function(req, res) {
  req.session.destroy(function() {
    utils.success(res, null, '已退出登录');
  });
});

// ===================== 扫码登录 =====================
// 引入WebSocket模块
const wsModule = require('../lib/ws');

// 生成扫码登录二维码（限制频率：每IP每30秒最多3次）
var qrGenLimits = {};
router.get('/qr-login/generate', async function(req, res) {
  try {
    var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    var now = Date.now();
    if (!qrGenLimits[ip]) qrGenLimits[ip] = [];
    qrGenLimits[ip] = qrGenLimits[ip].filter(function(t) { return now - t < 30000; });
    if (qrGenLimits[ip].length >= 10) return utils.error(res, '请求太频繁，请30秒后再试');
    qrGenLimits[ip].push(now);

    const token = utils.generateToken(32);
    const clientId = req.sessionID || 'anonymous_' + Date.now();
    const userId = req.session && req.session.userId ? req.session.userId : null;

    // 通过WebSocket模块创建token（传入userId以便后续通知PC）
    wsModule.createQrLoginToken(token, clientId, userId);

    // 生成二维码内容
    const baseUrl = (config.app && config.app.baseUrl) || (req.protocol + '://' + req.get('host'));
    const qrContent = baseUrl + '/api/auth/qr-login/scan?token=' + token;

    utils.success(res, {
      token: token,
      qrContent: qrContent,
      expiresIn: 60
    });
  } catch (err) {
    log.error('生成二维码登录错误:', err);
    utils.error(res, '生成二维码失败');
  }
});

// 查询扫码登录状态（电脑端轮询）
router.get('/qr-login/status', function(req, res) {
  try {
    const { token } = req.query;
    if (!token) {
      return utils.error(res, '缺少token参数');
    }

    const loginInfo = wsModule.getQrLoginToken(token);
    if (!loginInfo) {
      return utils.error(res, '二维码已过期或不存在');
    }

    if (Date.now() > loginInfo.expiresAt) {
      return utils.error(res, '二维码已过期');
    }

    // Return full status info for PC to display
    var statusData = {
      loggedIn: false,
      status: loginInfo.status,
      scannedBy: loginInfo.scannedBy || null,
      expiresIn: Math.max(0, Math.floor((loginInfo.expiresAt - Date.now()) / 1000))
    };

    if (loginInfo.status === 'authorized') {
      var authUser = User.findById(loginInfo.mobileUserId);
      if (authUser) {
        statusData.loggedIn = true;
        statusData.user = authUser;
        // CRITICAL: Actually switch the PC's session to the scanned user
        if (req.session) {
          req.session.userId = loginInfo.mobileUserId;
          req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
        }
        // One-time use: clear the token to prevent reuse
        loginInfo.status = 'consumed';
      }
    }

    return utils.success(res, statusData, statusData.loggedIn ? '登录成功' : '');
  } catch (err) {
    log.error('查询扫码登录状态错误:', err);
    utils.error(res, '查询状态失败');
  }
});

// 扫码页面（手机扫码后访问）
router.get('/qr-login/scan', function(req, res) {
  const { token } = req.query;
  if (!token) {
    return res.redirect('/login.html');
  }

  const loginInfo = wsModule.getQrLoginToken(token);
  if (!loginInfo || Date.now() > loginInfo.expiresAt) {
    return res.redirect('/login.html?error=expired');
  }

  // 返回授权确认页面
  res.send(getAuthPageHtml(token));
});

// 手机端APP扫码后直接访问此页面（已登录，仅弹一次确认）
router.get('/qr-login/confirm', utils.requireAuth, function(req, res) {
  var token = req.query.token;
  if (!token) return res.redirect('/login.html');
  var loginInfo = wsModule.getQrLoginToken(token);
  if (!loginInfo || Date.now() > loginInfo.expiresAt) return res.redirect('/login.html?error=expired');

  var User = require('../lib/db').User;
  var user = User.findById(req.session.userId);
  var nick = user ? (user.nickname || user.email.split('@')[0]) : '';
  var email = user ? user.email : '';
  var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');

  // 通知PC端已扫码（仅第一个扫码者有效，但同一用户重复加载页面允许）
  var alreadyScanned = loginInfo.status === 'scanned' || loginInfo.status === 'authorized';
  var sameUser = loginInfo.scannedBy === (nick || email);
  if (alreadyScanned && !sameUser) {
    return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已失效</title><style>*{margin:0;padding:0}body{font-family:sans-serif;background:#0d1117;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}.card{background:#1c2128;border:1px solid #30363d;border-radius:16px;padding:40px;max-width:360px}h2{color:#e6edf3;margin-bottom:8px}p{color:#8b949e;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">&#9888;</div><h2>二维码已失效</h2><p>该二维码已被其他用户扫码</p></div></body></html>');
  }
  if (!alreadyScanned) {
    wsModule.notifyQrScanned(token, nick || email);
  }

  // 返回暗色主题确认页面
  res.send(getConfirmPageHtmlV2(token, nick, email, ip));
});

// 手机端授权确认（POST - 兼容旧的手机浏览器扫码流程）
router.post('/qr-login/confirm', utils.requireAuth, function(req, res) {
  try {
    const { token } = req.body;
    if (!token) {
      return utils.error(res, '缺少token');
    }

    const loginInfo = wsModule.getQrLoginToken(token);
    if (!loginInfo) {
      return utils.error(res, '二维码已过期');
    }

    // 获取客户端IP
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const cleanIp = clientIp.split(',')[0].trim().replace('::ffff:', '');

    // 获取用户信息
    const user = User.findById(req.session.userId);

    // 返回授权页面HTML
    res.send(getConfirmPageHtml(token, user, cleanIp, req.get('user-agent') || ''));
  } catch (err) {
    log.error('授权确认错误:', err);
    utils.error(res, '处理失败');
  }
});

// 获取授权确认页面HTML
function getConfirmPageHtmlV2(token, nickname, email, ip) {
  var nowStr = new Date().toLocaleString("zh-CN");
  return "<!DOCTYPE html>\n<html lang=\"zh-CN\"><head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">\n<title>登录确认</title>\n<style>\n" +
    "*{margin:0;padding:0;box-sizing:border-box}\n" +
    "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;background:#0d1117;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}\n" +
    ".card{background:#1c2128;border:1px solid #30363d;border-radius:20px;padding:40px 32px;max-width:400px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}\n" +
    ".icon{width:72px;height:72px;background:linear-gradient(135deg,#1976D2,#2196F3);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:36px;box-shadow:0 8px 30px rgba(25,118,210,.3)}\n" +
    "h2{color:#e6edf3;font-size:22px;margin-bottom:6px}\n" +
    ".sub{color:#8b949e;font-size:14px;margin-bottom:20px}\n" +
    ".rows{background:#0d1117;border-radius:12px;padding:16px;margin-bottom:20px;text-align:left}\n" +
    ".row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #21262d}\n" +
    ".row:last-child{border-bottom:none}\n" +
    ".rl{color:#8b949e;font-size:13px}.rv{color:#e6edf3;font-size:13px;font-weight:500}\n" +
    ".warn{background:#3b2300;border:1px solid #d29922;border-radius:8px;padding:10px;margin-bottom:20px;font-size:12px;color:#d29922}\n" +
    ".btns{display:flex;gap:10px}\n" +
    ".btn{flex:1;padding:12px 16px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}\n" +
    ".btn-no{background:#21262d;color:#8b949e}.btn-no:hover{background:#30363d}\n" +
    ".btn-yes{background:linear-gradient(135deg,#1976D2,#2196F3);color:#fff;box-shadow:0 4px 12px rgba(25,118,210,.3)}.btn-yes:hover{box-shadow:0 6px 20px rgba(25,118,210,.5)}\n" +
    ".ok{display:none;color:#2ea043;font-size:15px;font-weight:500;margin-top:12px}\n" +
    "</style>\n</head>\n<body>\n<div class=\"card\">\n<div class=\"icon\">&#128274;</div>\n<h2>PC 端登录确认</h2>\n<p class=\"sub\">" + nickname + " 正尝试从 PC 端登录</p>\n" +
    "<div class=\"rows\">\n" +
    "<div class=\"row\"><span class=\"rl\">账号</span><span class=\"rv\">" + email + "</span></div>\n" +
    "<div class=\"row\"><span class=\"rl\">登录 IP</span><span class=\"rv\">" + ip + "</span></div>\n" +
    "<div class=\"row\"><span class=\"rl\">时间</span><span class=\"rv\">" + nowStr + "</span></div>\n" +
    "</div>\n" +
    "<div class=\"warn\">&#9888; 如非本人操作请点击拒绝并修改密码</div>\n" +
    "<div class=\"btns\" id=\"btns\"><button class=\"btn btn-no\" onclick=\"reject()\">拒绝</button><button class=\"btn btn-yes\" onclick=\"confirm()\">确认登录</button></div>\n" +
    "<div class=\"ok\" id=\"ok\">&#10004; 授权成功！窗口将自动关闭</div>\n" +
    "</div>\n<script>\n" +
    "var token=\"" + token + "\";\n" +
    "function confirm(){var b=document.getElementById(\"btns\");var o=document.getElementById(\"ok\");fetch(\"/api/auth/qr-login/authorize\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token:token}),credentials:\"include\"}).then(function(r){return r.json()}).then(function(d){if(d.code===0){b.style.display=\"none\";o.style.display=\"block\";setTimeout(function(){window.close()},800)}else{alert(d.message||\"授权失败\")}}).catch(function(){alert(\"网络错误\")})}\n" +
    "function reject(){var b=document.getElementById(\"btns\");fetch(\"/api/auth/qr-login/reject\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({token:token}),credentials:\"include\"}).then(function(){b.style.display=\"none\";setTimeout(function(){window.close()},500)})}\n" +
    "setTimeout(reject,300000);\n" +
    "</script>\n</body>\n</html>";
}


function getAuthPageHtml(token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>扫码登录 - FileService</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1976D2, #2196F3);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #1976D2, #2196F3);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h2 { color: #333; margin-bottom: 8px; font-size: 24px; }
    p { color: #666; margin-bottom: 24px; font-size: 14px; }
    .btn {
      display: inline-block;
      padding: 14px 40px;
      background: linear-gradient(135deg, #1976D2, #2196F3);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.3s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(25,118,210,0.4);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#128247;</div>
    <h2>扫码确认登录</h2>
    <p>请确认你已登录FileService账号，然后点击下方按钮继续</p>
    <a href="/api/auth/qr-login/confirm?token=${token}" class="btn">确认登录</a>
  </div>
</body>
</html>`;
}

// 授权处理
router.post('/qr-login/authorize', utils.requireAuth, function(req, res) {
  try {
    const { token } = req.body;
    if (!token) {
      return utils.error(res, '缺少token');
    }

    const loginInfo = wsModule.getQrLoginToken(token);
    if (!loginInfo) {
      return utils.error(res, '二维码已过期');
    }
    // Only the first scanner can authorize
    if (loginInfo.status === 'authorized' || loginInfo.status === 'consumed') {
      return utils.error(res, '该二维码已被其他用户授权，无法重复操作');
    }

    loginInfo.status = 'authorized';
    loginInfo.mobileUserId = req.session.userId;
    // Generate one-time login swap key for PC
    var swapKey = require('crypto').randomBytes(24).toString('hex');
    loginInfo.swapKey = swapKey;
    wsModule.notifyQrAuthorized(token, req.session.userId, swapKey);

    logger.logScanLogin(req, true, '扫码登录成功', req.session.userId);
    utils.success(res, null, '授权成功');
  } catch (err) {
    log.error('扫码授权错误:', err);
    utils.error(res, '授权失败');
  }
});

// 拒绝授权
router.post('/qr-login/reject', utils.requireAuth, function(req, res) {
  try {
    const { token } = req.body;
    if (token) {
      const loginInfo = wsModule.getQrLoginToken(token);
      if (loginInfo) {
        loginInfo.status = 'rejected';
      }
    }
    utils.success(res, null, '已拒绝');
  } catch (err) {
    utils.error(res, '处理失败');
  }
});

// ===================== 设备管理 =====================
var SessionTracker = require('../lib/redis').SessionTracker;

// GET /api/auth/devices  获取当前用户所有活跃会话
router.get('/devices', utils.requireAuth, function(req, res) {
  var userId = req.session.userId;
  SessionTracker.listSessions(userId).then(function(sessions) {
    var currentSid = req.sessionID;
    var list = sessions.map(function(s) {
      var isCurrent = s._sid === currentSid;
      var online = Date.now() - s.lastSeen < 5 * 60 * 1000;
      return {
        sid: s._sid,
        ip: s.ip,
        device: s.device,
        deviceId: s.deviceId ? s.deviceId.substring(0, 16) : '',
        userAgent: s.ua ? s.ua.substring(0, 80) : '',
        loginAt: s.loginAt,
        online: online,
        isCurrent: isCurrent
      };
    });
    utils.success(res, { devices: list, total: list.length });
  }).catch(function() { utils.error(res, '获取设备列表失败'); });
});

// POST /api/auth/devices/logout  强制下线指定设备
router.post('/devices/logout', utils.requireAuth, function(req, res) {
  var targetSid = req.body.sid;
  if (!targetSid) return utils.error(res, '缺少设备ID');
  if (targetSid === req.sessionID) return utils.error(res, '不能下线当前设备');

  var userId = req.session.userId;
  // Destroy the target session in Redis
  var getSessionStore = require('../lib/redis').getSessionStore;
  var store = getSessionStore();
  if (store && store.destroy) {
    store.destroy(targetSid, function(err) {
      if (err) return utils.error(res, '操作失败');
      SessionTracker.removeSession(userId, targetSid);
      utils.success(res, null, '设备已下线');
    });
  } else {
    // Memory store fallback
    SessionTracker.removeSession(userId, targetSid);
    utils.success(res, null, '设备已下线');
  }
});

// GET /api/auth/login-history  获取最近登录记录
router.get('/login-history', utils.requireAuth, function(req, res) {
  var userId = req.session.userId;
  var ActionLog = require('../lib/db').ActionLog;
  var logs = ActionLog.list({ userId: userId, action: 'login', limit: 20 });
  utils.success(res, { history: logs.data || [], total: logs.total || 0 });
});

// POST /api/auth/qr-login/swap - PC uses swapKey to login as the scanned user
router.post('/qr-login/swap', function(req, res) {
  var swapKey = req.body.swapKey;
  if (!swapKey) return utils.error(res, '缺少令牌');
  var wsModule = require('../lib/ws');
  var tokens = wsModule._getAllTokens();
  var matched = null;
  for (var key in tokens) {
    if (tokens[key].swapKey === swapKey && tokens[key].status === 'authorized') {
      matched = tokens[key];
      break;
    }
  }
  if (!matched) return utils.error(res, '令牌无效或已过期');
  // Security: swapKey is one-time use, already consumed
  if (matched.status === 'consumed') return utils.error(res, '令牌已被使用');
  // Security: swapKey expires after 3 minutes
  if (Date.now() - matched.createdAt > 3 * 60 * 1000) return utils.error(res, '令牌已过期');
  // Security: mobileUserId must be set by authorize (not forgeable)
  if (!matched.mobileUserId) return utils.error(res, '未授权的令牌');
  var User = require('../lib/db').User;
  var scanUser = User.findById(matched.mobileUserId);
  if (!scanUser) return utils.error(res, '用户不存在');

  // Directly set userId (don't regenerate - keeps existing cookie working)
  req.session.userId = matched.mobileUserId;
  req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
  req.session._csrfJustGenerated = true; // QR login 后首次 POST 允许通过
  // Clear any stale admin flags
  if (req.session.is_admin) delete req.session.is_admin;
  // Force save
  req.session.save(function(err) {
    if (err) { log.error('[Swap] Session save error:', err); }
    matched.status = 'consumed';
    matched.swapKey = null;
    log.info('[Swap] PC logged in as userId=' + matched.mobileUserId + ' email=' + scanUser.email);
    utils.success(res, {
      user: { id: scanUser.id, email: scanUser.email, nickname: scanUser.nickname, is_admin: scanUser.is_admin },
      csrfToken: req.session.csrfToken
    }, '登录成功');
  });
});

// ===================== 图形点选验证码 =====================
var crypto = require('crypto');

// 生成随机 SVG 图形验证码
router.get('/captcha/generate', function(req, res) {
  var shapes = [
    { name: 'triangle',  svg: '<polygon points="0,-20 17,15 -17,15" fill="COLOR" transform="translate(X,Y) rotate(R)"/>' },
    { name: 'square',    svg: '<rect x="-18" y="-18" width="36" height="36" rx="3" fill="COLOR" transform="translate(X,Y) rotate(R)"/>' },
    { name: 'circle',    svg: '<circle r="18" fill="COLOR" transform="translate(X,Y)"/>' },
    { name: 'star',      svg: '<polygon points="0,-22 6,-8 22,-8 10,3 14,18 0,10 -14,18 -10,3 -22,-8 -6,-8" fill="COLOR" transform="translate(X,Y) rotate(R)"/>' },
    { name: 'diamond',   svg: '<rect x="-18" y="-18" width="36" height="36" rx="3" fill="COLOR" transform="translate(X,Y) rotate(45)"/>' },
    { name: 'hexagon',   svg: '<polygon points="0,-20 17,-10 17,10 0,20 -17,10 -17,-10" fill="COLOR" transform="translate(X,Y) rotate(R)"/>' },
    { name: 'cross',     svg: '<path d="M-8,-22 L8,-22 L8,-8 L22,-8 L22,8 L8,8 L8,22 L-8,22 L-8,8 L-22,8 L-22,-8 L-8,-8 Z" fill="COLOR" transform="translate(X,Y)"/>' },
    { name: 'heart',     svg: '<path d="M0,8 C-8,-6 -24,-14 -24,-2 C-24,10 0,22 0,22 C0,22 24,10 24,-2 C24,-14 8,-6 0,8 Z" fill="COLOR" transform="translate(X,Y)"/>' },
  ];
  var colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];

  // 随机选3个形状和颜色
  var selected = [];
  var usedShapes = {}, usedColors = {};
  for (var i = 0; i < 3; i++) {
    var s, c;
    do { s = Math.floor(Math.random() * shapes.length); } while (usedShapes[s]);
    do { c = Math.floor(Math.random() * colors.length); } while (usedColors[c]);
    usedShapes[s] = true; usedColors[c] = true;
    selected.push({ shape: shapes[s], color: colors[c], r: Math.random() * 60 - 30 });
  }
  // 打乱点击顺序（避免总是从左到右）
  for (var i = selected.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = selected[i]; selected[i] = selected[j]; selected[j] = tmp;
  }
  // 分配 x/y 坐标：完全随机打乱位置
  var positions = [
    { x: 80 + Math.random() * 30,  y: 60 + Math.random() * 60 },
    { x: 170 + Math.random() * 30, y: 60 + Math.random() * 60 },
    { x: 260 + Math.random() * 30, y: 60 + Math.random() * 60 }
  ];
  for (var pi = positions.length - 1; pi > 0; pi--) {
    var pj = Math.floor(Math.random() * (pi + 1));
    var pt = positions[pi]; positions[pi] = positions[pj]; positions[pj] = pt;
  }
  for (var si = 0; si < 3; si++) {
    selected[si].x = positions[si].x;
    selected[si].y = positions[si].y;
  }

  // 生成 SVG
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" style="background:#f0f4f8;border-radius:8px">';
  svg += '<rect width="320" height="180" fill="#f0f4f8" rx="8"/>';
  // 干扰点
  for (var i = 0; i < 50; i++) {
    svg += '<circle cx="' + Math.random()*320 + '" cy="' + Math.random()*180 + '" r="' + (1+Math.random()*2) + '" fill="#ccc"/>';
  }
  selected.forEach(function(item) {
    svg += item.shape.svg.replace('COLOR', item.color).replace(/X/g, item.x).replace(/Y/g, item.y).replace(/R/g, item.r);
  });

  // 生成点击顺序说明（中文名称）
  var nameMap = { triangle: '三角形', square: '正方形', circle: '圆形', star: '五角星', diamond: '菱形', hexagon: '六边形', cross: '十字形', heart: '心形' };
  var instruction = selected.map(function(s, i) { return (i+1) + '、' + nameMap[s.shape.name]; }).join(' ');

  svg += '<text x="160" y="175" text-anchor="middle" font-size="11" fill="#666" font-family="sans-serif">请按顺序点击: ' + instruction + '</text>';
  svg += '</svg>';

  // 存入 Redis（5分钟有效）
  var token = crypto.randomBytes(16).toString('hex');
  var VerifyCode = require('../lib/redis').VerifyCode;
  VerifyCode.set(token, 'captcha', JSON.stringify(selected.map(function(s) { return { shape: s.shape.name, x: s.x, y: s.y, color: s.color }; })));

  res.json({ code: 0, data: { token: token, svg: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), instruction: instruction } });
});

// 验证点击位置
router.post('/captcha/verify', function(req, res) {
  var token = req.body.token;
  var clicks = req.body.clicks; // [{x, y}, ...]
  if (!token || !clicks || clicks.length < 3) return res.json({ code: 1, message: '参数错误' });

  var VerifyCode = require('../lib/redis').VerifyCode;
  VerifyCode.get(token, 'captcha').then(function(data) {
    if (!data) return res.json({ code: 1, message: '验证码已过期' });
    try {
      var expected = JSON.parse(data);
      var ok = true;
      for (var i = 0; i < 3; i++) {
        var cx = clicks[i] ? parseFloat(clicks[i].x) : 0;
        var cy = clicks[i] ? parseFloat(clicks[i].y) : 0;
        var ex = expected[i].x, ey = expected[i].y;
        var dist = Math.sqrt((cx-ex)*(cx-ex) + (cy-ey)*(cy-ey));
        if (dist > 30) { ok = false; break; } // 30px 容差
      }
      VerifyCode.del(token, 'captcha');
      if (ok) {
        // 设置 captcha_ok 标记，供登录接口验证（5分钟有效）
        VerifyCode.set(token, 'captcha_ok', '1');
      }
      res.json({ code: ok ? 0 : 1, message: ok ? '验证通过' : '点击位置不正确', data: { success: ok } });
    } catch(e) { res.json({ code: 1, message: '验证失败' }); }
  }).catch(function() { res.json({ code: 1, message: '验证失败' }); });
});

// ==================== App 日志上报 ====================
// POST /api/auth/app-log  移动端日志上报
router.post('/app-log', function(req, res) {
  var deviceId = (req.headers['x-device-id'] || '').substring(0, 64);
  var userId = req.session && req.session.userId ? req.session.userId : 0;
  var logs = req.body.logs || [];
  var level = req.body.level || 'info';
  var tag = req.body.tag || 'app';
  var message = req.body.message || '';
  var metadata = req.body.metadata || '';

  try {
    var db = require('../lib/db');
    // 支持批量日志
    if (Array.isArray(logs) && logs.length > 0) {
      logs.forEach(function(log) {
        db.run('INSERT INTO app_logs (user_id, device_id, level, tag, message, metadata) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, deviceId, log.level || 'info', log.tag || 'app', log.message || '', log.metadata || '']);
      });
    } else if (message) {
      db.run('INSERT INTO app_logs (user_id, device_id, level, tag, message, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, deviceId, level, tag, message, typeof metadata === 'object' ? JSON.stringify(metadata) : metadata]);
    }
  } catch(e) {
    // 静默失败，不影响用户体验
  }
  res.json({ code: 0, message: 'ok' });
});

// GET /api/admin/app-logs  查看App日志（管理员）
router.get('/admin/app-logs', utils.requireAuth, function(req, res) {
  var user = req.user;
  if (!user.is_admin) return res.status(403).json({ code: 403, message: '需要管理员权限' });
  var limit = parseInt(req.query.limit, 10) || 50;
  var offset = parseInt(req.query.offset, 10) || 0;
  var userId = parseInt(req.query.user_id, 10) || 0;

  var db = require('../lib/db');
  var where = '';
  var params = [];
  if (userId > 0) { where = 'WHERE user_id = ?'; params.push(userId); }
  var logs = db.query(
    'SELECT * FROM app_logs ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
    params.concat([limit, offset])
  );
  var total = db.get('SELECT COUNT(*) as cnt FROM app_logs ' + where, params);
  res.json({ code: 0, data: { logs: logs, total: total ? total.cnt : 0 } });
});

// ===================== 系统初始化（首次启动） =====================

// POST /api/auth/setup — 首次启动创建管理员（仅 users 表为空时可用）
router.post('/setup', async function(req, res) {
  try {
    // 安全检查：仅当用户表为空时允许初始化
    if (User.count() > 0) {
      return res.status(403).json({ code: 403, message: '系统已初始化', data: null });
    }

    var email = (req.body.email || '').trim().toLowerCase();
    var password = req.body.password || '';

    // 参数校验
    if (!email || !password) {
      return res.status(400).json({ code: 400, message: '请填写邮箱和密码', data: null });
    }

    if (!utils.isValidEmail(email)) {
      return res.status(400).json({ code: 400, message: '邮箱格式不正确', data: null });
    }

    var pwdResult = utils.validatePassword(password);
    if (!pwdResult.valid) {
      return res.status(400).json({ code: 400, message: pwdResult.errors.join('；'), data: null });
    }

    // 创建管理员用户（无需验证码）
    var userId = User.create(email, password, email.split('@')[0]);
    if (!userId) {
      return res.status(500).json({ code: 500, message: '创建用户失败，请稍后重试', data: null });
    }

    // 设为管理员
    User.setAdmin(userId, 1);

    // 自动登录
    req.session.regenerate(function(err) {
      if (err) {
        log.error('初始化 Session 重建失败:', err);
        return res.status(500).json({ code: 500, message: '初始化失败，请稍后重试', data: null });
      }
      req.session.userId = userId;
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
      req.session._csrfJustGenerated = true;
      var user = User.findById(userId);
      log.info('[Setup] 系统初始化完成，管理员: ' + email);
      res.json({ code: 0, message: '初始化成功', data: { user: user, csrfToken: req.session.csrfToken } });
    });
  } catch (err) {
    log.error('初始化错误:', err);
    res.status(500).json({ code: 500, message: '初始化失败，请稍后重试', data: null });
  }
});

module.exports = router;
