/**
 * WebSocket 服务模块
 * 提供实时双向通信，用于推送离线下载进度等实时消息
 */
const WebSocket = require('ws');
const url = require('url');

// WebSocket 服务器实例（可能多个）
var servers = [];

// 心跳定时器列表
var heartbeatIntervals = [];

// 所有连接的客户端，按用户 ID 分组
var clientsByUser = {};

// 扫码登录状态存储
var qrLoginTokens = {};

// 初始化 WebSocket 服务器
function init(targetServer) {
    // 避免重复绑定到同一个 server
    for (var i = 0; i < servers.length; i++) {
        if (servers[i].server === targetServer) {
            console.log('[WS] 该 server 已初始化 WebSocket，跳过');
            return servers[i];
        }
    }

    var wss = new WebSocket.Server({ server: targetServer, path: '/ws' });
    servers.push(wss);

    wss.on('connection', function(ws, req) {
        ws.isAlive = true;
        ws.clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '';
        if (ws.clientIp.indexOf(',') !== -1) ws.clientIp = ws.clientIp.split(',')[0].trim();
        if (ws.clientIp.startsWith('::ffff:')) ws.clientIp = ws.clientIp.substring(7);

        ws.on('pong', function() {
            ws.isAlive = true;
        });

        ws.on('message', function(data) {
            try {
                var msg = JSON.parse(data);
                handleMessage(ws, msg);
            } catch (e) {
                console.error('[WS] 消息解析失败:', e.message);
            }
        });

        ws.on('close', function() {
            removeClient(ws);
        });

        ws.on('error', function(err) {
            console.error('[WS] 连接错误:', err.message);
            removeClient(ws);
        });
    });

    // 心跳检测（每 30 秒检查一次）
    var heartbeatInterval = setInterval(function() {
        wss.clients.forEach(function(ws) {
            if (!ws.isAlive) {
                removeClient(ws);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
    heartbeatIntervals.push(heartbeatInterval);

    wss.on('close', function() {
        clearInterval(heartbeatInterval);
    });

    console.log('[WS] WebSocket 服务器已初始化，路径: /ws');
    return wss;
}

// 处理客户端消息
function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'ping':
            sendToClient(ws, { type: 'pong', timestamp: Date.now() });
            break;

        case 'auth':
            // 客户端发送认证消息，包含 userId
            if (msg.userId) {
                var userId = parseInt(msg.userId, 10);
                ws.userId = userId;

                if (!clientsByUser[userId]) {
                    clientsByUser[userId] = [];
                }
                // 避免重复添加
                var existingIndex = clientsByUser[userId].indexOf(ws);
                if (existingIndex === -1) {
                    clientsByUser[userId].push(ws);
                }

                console.log('[WS] 用户 ' + userId + ' 认证成功，当前连接数: ' + clientsByUser[userId].length);
                sendToClient(ws, { type: 'auth_ok', userId: userId });
            }
            break;

        case 'qr_login_request':
            // 客户端请求生成二维码
            handleQrLoginRequest(ws, msg);
            break;

        case 'qr_login_cancel':
            // 取消扫码登录
            handleQrLoginCancel(ws, msg);
            break;

        case 'qr_login_scan':
            // 手机扫码
            handleQrLoginScan(ws, msg);
            break;

        case 'qr_login_authorize':
            // 手机授权确认
            handleQrLoginAuthorize(ws, msg);
            break;

        case 'qr_login_reject':
            // 手机拒绝授权
            handleQrLoginReject(ws, msg);
            break;

        default:
            break;
    }
}

// 处理扫码登录请求
function handleQrLoginRequest(ws, msg) {
    var token = msg.token;
    if (!token || !qrLoginTokens[token]) {
        sendToClient(ws, { type: 'qr_login_error', message: '无效的token' });
        return;
    }

    var loginInfo = qrLoginTokens[token];
    loginInfo.pcWs = ws;
    loginInfo.status = 'waiting_scan';

    console.log('[WS] qr_login_request received, pcWs SET, token=' + (token ? token.substring(0,8) : 'null'));
    sendToClient(ws, { type: 'qr_login_waiting', token: token });
}

// 取消扫码登录
function handleQrLoginCancel(ws, msg) {
    var token = msg.token;
    if (qrLoginTokens[token]) {
        delete qrLoginTokens[token];
        sendToClient(ws, { type: 'qr_login_cancelled', token: token });
    }
}

// 手机扫码
function handleQrLoginScan(ws, msg) {
    var token = msg.token;
    var userId = msg.userId;

    if (!token) {
        sendToClient(ws, { type: 'qr_login_error', message: '缺少token' });
        return;
    }

    var loginInfo = qrLoginTokens[token];
    if (!loginInfo) {
        sendToClient(ws, { type: 'qr_login_error', message: '二维码已过期，请重新生成' });
        return;
    }

    if (Date.now() > loginInfo.expiresAt) {
        delete qrLoginTokens[token];
        sendToClient(ws, { type: 'qr_login_error', message: '二维码已过期，请重新生成' });
        return;
    }

    // 更新状态
    loginInfo.mobileUserId = userId;
    loginInfo.mobileWs = ws;
    loginInfo.mobileIp = ws.clientIp;
    loginInfo.status = 'waiting_authorize';
    ws.qrLoginToken = token;

    console.log('[WS] 手机扫码，token:', token, 'userId:', userId);

    // 通知电脑端有人扫码了
    if (loginInfo.pcWs) {
        sendToClient(loginInfo.pcWs, {
            type: 'qr_login_scanned',
            token: token,
            userId: userId,
            message: '扫码成功，请在手机上确认登录'
        });
    }

    // 通知手机端等待授权
    sendToClient(ws, { type: 'qr_login_wait_authorize', token: token });
}

// 手机授权确认
function handleQrLoginAuthorize(ws, msg) {
    var token = msg.token;
    var loginInfo = qrLoginTokens[token];

    if (!loginInfo || loginInfo.mobileWs !== ws) {
        sendToClient(ws, { type: 'qr_login_error', message: '授权失败，token不匹配' });
        return;
    }

    loginInfo.status = 'authorized';
    console.log('[WS] 用户授权登录，token:', token, 'userId:', loginInfo.mobileUserId);

    // 通知手机端授权成功
    sendToClient(ws, { type: 'qr_login_authorized', token: token });

    // 通知电脑端授权成功，传递session信息
    if (loginInfo.pcWs) {
        sendToClient(loginInfo.pcWs, {
            type: 'qr_login_success',
            token: token,
            userId: loginInfo.mobileUserId,
            message: '授权成功，正在登录...'
        });
    }

    // 清理token
    setTimeout(function() {
        delete qrLoginTokens[token];
    }, 5000);
}

// 手机拒绝授权
function handleQrLoginReject(ws, msg) {
    var token = msg.token;
    var loginInfo = qrLoginTokens[token];

    if (!loginInfo || loginInfo.mobileWs !== ws) {
        return;
    }

    console.log('[WS] 用户拒绝授权，token:', token);

    // 通知手机端
    sendToClient(ws, { type: 'qr_login_rejected', token: token });

    // 通知电脑端
    if (loginInfo.pcWs) {
        sendToClient(loginInfo.pcWs, {
            type: 'qr_login_rejected',
            token: token,
            message: '登录已取消'
        });
    }

    delete qrLoginTokens[token];
}

// 创建扫码登录token
function createQrLoginToken(token, clientId, userId) {
    qrLoginTokens[token] = {
        clientId: clientId,
        pcUserId: userId || null,
        pcWs: null,
        mobileWs: null,
        mobileUserId: null,
        mobileIp: null,
        status: 'created',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000 // 5分钟过期
    };

    // 清理过期token
    for (var key in qrLoginTokens) {
        if (Date.now() > qrLoginTokens[key].expiresAt) {
            delete qrLoginTokens[key];
        }
    }

    return qrLoginTokens[token];
}

// 获取扫码登录token信息
function getQrLoginToken(token) {
    return qrLoginTokens[token];
}

// 移除客户端
function removeClient(ws) {
    if (ws.userId && clientsByUser[ws.userId]) {
        var index = clientsByUser[ws.userId].indexOf(ws);
        if (index !== -1) {
            clientsByUser[ws.userId].splice(index, 1);
        }
        if (clientsByUser[ws.userId].length === 0) {
            delete clientsByUser[ws.userId];
        }
    }

    // 如果是扫码登录的客户端，通知对方
    if (ws.qrLoginToken && qrLoginTokens[ws.qrLoginToken]) {
        var loginInfo = qrLoginTokens[ws.qrLoginToken];
        if (loginInfo.pcWs === ws && loginInfo.mobileWs) {
            sendToClient(loginInfo.mobileWs, {
                type: 'qr_login_error',
                message: '电脑端已断开连接'
            });
        } else if (loginInfo.mobileWs === ws && loginInfo.pcWs) {
            sendToClient(loginInfo.pcWs, {
                type: 'qr_login_error',
                message: '手机端已断开连接'
            });
        }
        delete qrLoginTokens[ws.qrLoginToken];
    }
}

// 向指定客户端发送消息
function sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
        } catch (e) {
            console.error('[WS] 发送消息失败:', e.message);
        }
    }
}

// 向指定用户的所有连接发送消息
function sendToUser(userId, data) {
    var clients = clientsByUser[userId] || [];
    var sent = 0;
    clients.forEach(function(ws) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(data));
                sent++;
            } catch (e) {
                console.error('[WS] 发送消息失败:', e.message);
            }
        }
    });
    return sent;
}

// 推送离线下载任务更新
// type: 'created' | 'started' | 'progress' | 'completed' | 'failed'
function pushOfflineUpdate(userId, taskId, type, data) {
    var payload = {
        type: 'offline_task',
        action: type,
        taskId: taskId,
        data: data,
        timestamp: Date.now()
    };
    var clients = clientsByUser[userId] || [];
    var sent = sendToUser(userId, payload);
    if (sent === 0) {
        console.log('[WS] 用户 ' + userId + ' 不在线，跳过推送');
    }
    return sent;
}

// 广播消息给所有在线用户
function broadcast(data) {
    var count = 0;
    Object.keys(clientsByUser).forEach(function(userId) {
        count += sendToUser(userId, data);
    });
    return count;
}

// 获取在线用户数
function getOnlineCount() {
    return Object.keys(clientsByUser).length;
}

// 获取 WebSocket 服务器实例列表
function getWSS() {
    return servers;
}

// 关闭所有 WebSocket 服务器
function closeAll() {
    heartbeatIntervals.forEach(function(t) { clearInterval(t); });
    heartbeatIntervals = [];
    servers.forEach(function(s) { s.close(); });
    servers = [];
}

function notifyQrScanned(token, userEmail) {
    var info = qrLoginTokens[token];
    console.log('[WS] notifyQrScanned token=' + (token ? token.substring(0,8) : 'null') + ' exists=' + !!info);
    if (!info) return false;
    // Only first scan wins - prevent photo-replay attacks
    if (info.status === 'scanned' || info.status === 'authorized') {
        console.log('[WS] Token already scanned, rejecting duplicate scan by ' + userEmail);
        return false;
    }
    info.status = 'scanned';
    info.scannedBy = userEmail;
    var msg = { type: 'qr_login_scanned', data: { token: token, scannedBy: userEmail, status: 'scanned' } };
    console.log('[WS] pcWs=' + !!info.pcWs + ' pcUserId=' + info.pcUserId + ' clientsByUser=' + (info.pcUserId ? (clientsByUser[info.pcUserId] || []).length : 0));
    if (info.pcWs && info.pcWs.readyState === 1) {
        sendToClient(info.pcWs, msg);
        console.log('[WS] Sent qr_login_scanned to pcWs');
    }
    if (info.pcUserId) {
        sendToUser(info.pcUserId, msg);
        console.log('[WS] Sent qr_login_scanned to userId=' + info.pcUserId);
    }
}

function notifyQrAuthorized(token, userId, swapKey) {
    var info = qrLoginTokens[token];
    if (!info) return;
    info.status = 'authorized';
    info.mobileUserId = userId;
    info.swapKey = swapKey;
    var msg = { type: 'qr_login_success', data: { token: token, userId: userId, swapKey: swapKey, status: 'authorized' } };
    if (info.pcWs) { sendToClient(info.pcWs, msg); }
    if (info.pcUserId) { sendToUser(info.pcUserId, msg); }
    console.log('[WS] QR authorized -> qr_login_success token=' + token.substring(0,8));
}

module.exports = {
    init: init,
    sendToUser: sendToUser,
    sendToClient: sendToClient,
    pushOfflineUpdate: pushOfflineUpdate,
    broadcast: broadcast,
    getOnlineCount: getOnlineCount,
    getWSS: getWSS,
    closeAll: closeAll,
    // 扫码登录相关
    createQrLoginToken: createQrLoginToken,
    getQrLoginToken: getQrLoginToken,
    notifyQrScanned: notifyQrScanned,
    notifyQrAuthorized: notifyQrAuthorized,
    _getAllTokens: function() { return qrLoginTokens; }
};
