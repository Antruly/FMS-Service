/**
 * 文件/目录名称验证工具
 * 同时兼容 Windows 和 Linux 平台
 */

'use strict';

const path = require('path');

/**
 * 检查文件名是否合法
 * @param {string} name - 文件或目录名称
 * @param {Object} options - 配置选项
 * @param {number} options.maxLength - 最大长度（默认 100）
 * @param {boolean} options.allowDots - 是否允许点号（用于文件vs目录的区分）
 * @returns {Object} { valid: boolean, message: string }
 */
function validateFileName(name, options) {
    options = options || {};
    var maxLength = options.maxLength || 100;
    var allowDots = options.allowDots !== false; // 默认允许文件名中有点，但有额外规则

    // 基本类型检查
    if (typeof name !== 'string') {
        return { valid: false, message: '名称类型无效' };
    }

    var trimmed = name.trim();

    // 空检查
    if (!trimmed) {
        return { valid: false, message: '名称不能为空' };
    }

    // 长度检查
    if (trimmed.length > maxLength) {
        return { valid: false, message: '名称过长（最多 ' + maxLength + ' 个字符）' };
    }

    // 长度过短检查（至少1个非空白字符已在上面处理）

    // ========== 字符禁止检查 ==========
    // Windows 和 Linux 都禁止的字符
    // /  Linux 路径分隔符
    // \  Windows 路径分隔符（Linux 上虽可用但文件名中禁止）
    // :  Windows 驱动器/设备分隔符
    // *  通配符（所有平台）
    // ?  通配符（所有平台）
    // "  Windows 引号
    // <  Windows 重定向
    // >  Windows 重定向
    // |  Windows 管道
    var charForbidden = /[\\/:*?"<>|]/;
    if (charForbidden.test(trimmed)) {
        return { valid: false, message: '名称不能包含以下字符: \\ / : * ? " < > |' };
    }

    // ========== Windows 特殊限制 ==========

    // 不能以 . 开头（在 Windows 资源管理器中有特殊行为）
    if (trimmed.startsWith('.')) {
        return { valid: false, message: '名称不能以点号开头' };
    }

    // 不能以 . 结尾（Windows 无法创建以 . 结尾的文件/目录）
    if (trimmed.endsWith('.')) {
        return { valid: false, message: '名称不能以点号结尾' };
    }

    // Windows 保留字（不区分大小写）
    // CON, PRN, AUX, NUL
    // COM1-COM9, LPT1-LPT9
    var upper = trimmed.toUpperCase();
    var reservedNames = [
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    ];
    // 精确匹配保留字，或保留字后跟扩展名（如 CON.txt）
    if (reservedNames.indexOf(upper) >= 0 || /^CON\./.test(upper) || /^PRN\./.test(upper)) {
        return { valid: false, message: '"' + trimmed + '" 是系统保留名称，不能使用' };
    }

    // ========== 全部通过 ==========
    return { valid: true, message: '' };
}

/**
 * 简化的目录名验证（与文件名规则基本相同）
 */
function validateDirName(name) {
    return validateFileName(name, { maxLength: 100 });
}

/**
 * 将用户提供的相对路径解析到基准目录内部，并做包含性校验。
 *
 * 相比手写 `p.indexOf(base) === 0` / `p.startsWith(base)`，本函数额外做对了两件事：
 *   1. 比较时带上 path.sep —— 否则 base 为 /data/public 时 /data/public_evil/x 也会通过（前缀兄弟目录绕过）
 *   2. 先 path.resolve 归一化 —— 否则 ../ 可以向上跳出 base
 *
 * @param {string} baseDir - 基准目录（绝对路径或相对路径均可）
 * @param {string} userPath - 用户可控的相对路径
 * @returns {string|null} 解析后的绝对路径；越界或输入非法时返回 null
 */
function resolveWithin(baseDir, userPath) {
    if (!baseDir || typeof userPath !== 'string' || userPath === '') return null;
    // NUL 字节会在底层 syscall 处截断路径，直接拒绝
    if (userPath.indexOf('\0') !== -1) return null;

    var base = path.resolve(baseDir);
    var target = path.resolve(base, userPath);

    // 允许指向基准目录自身
    if (target === base) return target;

    var prefix = base.endsWith(path.sep) ? base : base + path.sep;
    if (target.indexOf(prefix) !== 0) return null;

    return target;
}

// ==================== 网络地址校验（离线下载 SSRF 防护） ====================
var net = require('net');
var dns = require('dns');

// 统一对外文案。刻意不含任何 IP / 主机名 / 端口，
// 避免把服务端解析出来的内网拓扑回显给调用方。
var BLOCKED_TARGET_MESSAGE = '目标地址不允许访问（内网/回环/保留地址已被拦截）';

// 禁止访问的 IPv4 网段（基址, 前缀长度）
var BLOCKED_V4 = [
    ['0.0.0.0', 8],         // 未指定 / 本网络
    ['10.0.0.0', 8],        // 私网
    ['100.64.0.0', 10],     // CGNAT
    ['127.0.0.0', 8],       // 环回
    ['169.254.0.0', 16],    // 链路本地（含 169.254.169.254 云元数据）
    ['172.16.0.0', 12],     // 私网
    ['192.0.0.0', 24],      // IETF 协议分配
    ['192.0.2.0', 24],      // TEST-NET-1
    ['192.88.99.0', 24],    // 6to4 中继（已废弃）
    ['192.168.0.0', 16],    // 私网
    ['198.18.0.0', 15],     // 基准测试
    ['198.51.100.0', 24],   // TEST-NET-2
    ['203.0.113.0', 24],    // TEST-NET-3
    ['224.0.0.0', 4],       // 组播
    ['240.0.0.0', 4]        // 保留 / 广播
];

// 禁止访问的 IPv6 前缀（前 32 个 hex 字符的规范形态, 前缀长度）
// 表中前缀长度均 <= 96，所以只看前 96 bit 即可覆盖
var BLOCKED_V6 = [
    ['000000000000000000000000', 96],  // ::/96（含 ::、::1、IPv4-compatible）
    ['0064ff9b0000000000000000', 96],  // 64:ff9b::/96 NAT64
    ['010000000000000000000000', 64],  // 100::/64 discard-only
    ['200100000000000000000000', 32],  // 2001::/32 Teredo
    ['20010db80000000000000000', 32],  // 2001:db8::/32 文档用
    ['200200000000000000000000', 16],  // 2002::/16 6to4
    ['fc0000000000000000000000', 7],   // fc00::/7 ULA
    ['fe8000000000000000000000', 10],  // fe80::/10 链路本地
    ['fec000000000000000000000', 10],  // fec0::/10 站点本地（已废弃）
    ['ff0000000000000000000000', 8]    // ff00::/8 组播
];

function v4ToInt(ip) {
    var p = String(ip).split('.');
    if (p.length !== 4) return -1;
    var n = 0;
    for (var i = 0; i < 4; i++) {
        var x = parseInt(p[i], 10);
        // 严格匹配十进制十进制写法：'01' / '0x1' / ' 1' 都不接受（失败关闭）
        if (!(x >= 0 && x <= 255) || String(x) !== p[i]) return -1;
        n = n * 256 + x;
    }
    return n;
}

function inV4Range(n, base, bits) {
    var b = v4ToInt(base);
    if (b < 0) return false;
    var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

// 把 IPv6 字面量展开成 32 个 hex 字符（去掉 : 与 :: 的压缩）；解析失败返回 null
function v6ToHex32(ip) {
    var h = String(ip);
    var lastColon = h.lastIndexOf(':');
    if (lastColon < 0) return null;
    var tail = h.slice(lastColon + 1);
    if (tail.indexOf('.') !== -1) {         // 内嵌 IPv4，如 ::ffff:127.0.0.1
        var oct = tail.split('.');
        if (oct.length !== 4) return null;
        var num = [];
        for (var i = 0; i < 4; i++) {
            var v = parseInt(oct[i], 10);
            if (!(v >= 0 && v <= 255) || String(v) !== oct[i]) return null;
            num.push(v);
        }
        h = h.slice(0, lastColon + 1)
          + ((num[0] << 8) | num[1]).toString(16) + ':'
          + ((num[2] << 8) | num[3]).toString(16);
    }
    var dbl = h.indexOf('::');
    var head, rest;
    if (dbl === -1) { head = h.split(':'); rest = []; }
    else { head = h.slice(0, dbl).split(':'); rest = h.slice(dbl + 2).split(':'); }
    if (head.length === 1 && head[0] === '') head = [];
    if (rest.length === 1 && rest[0] === '') rest = [];
    var missing = 8 - head.length - rest.length;
    if (dbl === -1 ? missing !== 0 : missing < 1) return null;
    var groups = head.concat(new Array(missing).fill('0')).concat(rest);
    if (groups.length !== 8) return null;
    var out = '';
    for (var j = 0; j < 8; j++) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(groups[j])) return null;
        out += ('0000' + groups[j].toLowerCase()).slice(-4);
    }
    return out;
}

function v6PrefixMatch(hex32, prefixHex, bits) {
    var nibbles = bits >> 2;
    if (hex32.slice(0, nibbles) !== prefixHex.slice(0, nibbles)) return false;
    var rem = bits & 3;
    if (rem === 0) return true;
    var shift = 4 - rem;
    return (parseInt(hex32.charAt(nibbles), 16) >> shift)
        === (parseInt(prefixHex.charAt(nibbles), 16) >> shift);
}

/**
 * 判断一个「地址字面量」是否禁止访问。
 *
 * 刻意返回三种值，让调用方能区分"不是 IP"（该转而走 DNS）与"是 IP 但被禁"。
 *
 * @param {string} ip - IP 字面量，允许带 [] 包裹、%zone、::ffff: 前缀
 * @returns {boolean|null} true=禁止 / false=允许 / null=不是合法 IP 字面量
 */
function isBlockedIpLiteral(ip) {
    if (typeof ip !== 'string') return null;
    var host = ip.trim();
    if (host.length >= 2 && host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
        host = host.slice(1, -1);       // URL.hostname 对 IPv6 带方括号
    }
    var zone = host.indexOf('%');       // fe80::1%eth0
    if (zone !== -1) host = host.slice(0, zone);

    var kind = net.isIP(host);
    if (kind === 4) {
        var n = v4ToInt(host);
        if (n < 0) return true;         // 解不出来 → 失败关闭
        for (var i = 0; i < BLOCKED_V4.length; i++) {
            if (inV4Range(n, BLOCKED_V4[i][0], BLOCKED_V4[i][1])) return true;
        }
        return false;
    }
    if (kind === 6) {
        var hex = v6ToHex32(host);
        if (!hex) return true;          // 失败关闭
        // IPv4-mapped（::ffff:a.b.c.d）：拆出后两段按 IPv4 规则判。
        // 必须做在展开后的 hex 上 —— ::ffff:127.0.0.1 会被 URL 归一化成 ::ffff:7f00:1
        if (hex.slice(0, 24) === '00000000000000000000ffff') {
            var a = parseInt(hex.slice(24, 28), 16);
            var b = parseInt(hex.slice(28, 32), 16);
            var bn = v4ToInt([a >> 8, a & 255, b >> 8, b & 255].join('.'));
            if (bn < 0) return true;
            for (var k = 0; k < BLOCKED_V4.length; k++) {
                if (inV4Range(bn, BLOCKED_V4[k][0], BLOCKED_V4[k][1])) return true;
            }
            return false;
        }
        for (var m = 0; m < BLOCKED_V6.length; m++) {
            if (v6PrefixMatch(hex, BLOCKED_V6[m][0], BLOCKED_V6[m][1])) return true;
        }
        return false;
    }
    return null;                        // 不是 IP 字面量
}

/**
 * 构造一个可直接塞进 http.request / https.request 的 `lookup` 选项。
 *
 * 关键性质：校验发生在「即将建立 TCP 连接的那一刻」，检查的是真正要连的地址，
 * 所以不存在「先解析校验、再解析连接」的 TOCTOU，天然免疫 DNS rebinding。
 *
 * ⚠️ 局限：net 在 hostname 本身是 IP 字面量时会跳过解析、直接连接，
 * **此时本函数根本不会被调用** —— 所以调用方必须另外做一道同步的字面量校验
 * （见 routes/file.js 的 checkOfflineTargetLiteral），两层缺一不可。
 *
 * @param {Object} [opts]
 * @param {function(string, number): boolean} [opts.isAddressAllowed]
 *        单地址放行判定，默认「非禁止段即放行」
 * @returns {function} lookup(hostname, options, callback)
 */
function createGuardedLookup(opts) {
    opts = opts || {};
    var isAddressAllowed = opts.isAddressAllowed || function (addr) {
        return isBlockedIpLiteral(addr) === false;
    };

    return function guardedLookup(hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        options = options || {};
        var wantAll = !!options.all;    // autoSelectFamily 生效时 Node 会传 all:true
        var wantFamily = (options.family === 4 || options.family === 6) ? options.family : 0;

        // 自己全查（A + AAAA），不受上游 family 限制 ——
        // 这样即使上游只要 IPv4，AAAA 里的内网地址也照样会被看见并拦掉
        dns.lookup(hostname, { all: true }, function (err, addresses) {
            // 原样透传 DNS 错误（内容形如 getaddrinfo ENOTFOUND <用户自己填的主机名>，
            // 不含服务端解析结果，不泄露内网拓扑），保留可诊断性
            if (err) return callback(err);
            if (!Array.isArray(addresses) || addresses.length === 0) {
                return callback(new Error('目标主机无法解析'));
            }
            // 1) 任一解析结果被禁 → 整体拒绝。防 rebinding 的关键：
            //    不能"挑一个合法的连"，否则 DNS 同时返回公网+内网地址就能绕过
            for (var i = 0; i < addresses.length; i++) {
                if (!isAddressAllowed(addresses[i].address, addresses[i].family)) {
                    var blocked = new Error(BLOCKED_TARGET_MESSAGE);
                    blocked.code = 'ERR_SSRF_BLOCKED';
                    return callback(blocked);
                }
            }
            // 2) 挑真正要连的地址：优先满足上游 family（本项目固定传 4）
            var pick = null;
            for (var j = 0; j < addresses.length; j++) {
                if (wantFamily === 0 || addresses[j].family === wantFamily) { pick = addresses[j]; break; }
            }
            if (!pick) {
                // 与"只有 AAAA 记录 + family:4"的既有行为等价（今天也是失败，只是文案不同）
                var noFam = new Error('目标主机没有可用的 IPv' + wantFamily + ' 地址');
                noFam.code = 'ERR_SSRF_NO_FAMILY';
                return callback(noFam);
            }
            if (wantAll) return callback(null, addresses);
            callback(null, pick.address, pick.family);
        });
    };
}

/**
 * 解析「host 或 host:port」形式的允许清单。
 * @param {string[]|string} raw - 逗号分隔字符串或已切分的数组
 * @returns {Array<{host: string, port: number}>} port 为 0 表示匹配任意端口
 */
function parseHostAllowlist(raw) {
    var items = Array.isArray(raw) ? raw : String(raw || '').split(',');
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var s = String(items[i] || '').trim();
        if (!s || s.charAt(0) === '#') continue;
        var host = s, port = 0;
        if (s.charAt(0) === '[') {                      // [::1]:8080
            var close = s.indexOf(']');
            if (close > 0) {
                host = s.slice(1, close);
                var after = s.slice(close + 1);
                if (after.charAt(0) === ':') port = parseInt(after.slice(1), 10) || 0;
            }
        } else {
            var idx = s.lastIndexOf(':');
            if (idx > 0 && s.indexOf(':') === idx) {    // 只切一次，避免误伤裸 IPv6
                var p = parseInt(s.slice(idx + 1), 10);
                if (p > 0 && p <= 65535) { host = s.slice(0, idx); port = p; }
            }
        }
        host = host.trim().toLowerCase().replace(/\.$/, '');   // 去尾部点：localhost. == localhost
        if (host) out.push({ host: host, port: port });
    }
    return out;
}

/**
 * 允许清单命中判定。条目不带 port 时匹配任意端口。
 * @param {Array} list - parseHostAllowlist 的返回值
 * @param {string} hostname - 已剥掉方括号的主机名
 * @param {number} port - 实际端口
 * @returns {boolean}
 */
function isHostAllowlisted(list, hostname, port) {
    if (!Array.isArray(list) || list.length === 0) return false;
    var h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    var p = parseInt(port, 10) || 0;
    for (var i = 0; i < list.length; i++) {
        if (list[i].host !== h) continue;
        if (list[i].port === 0 || list[i].port === p) return true;
    }
    return false;
}

module.exports = {
    validateFileName: validateFileName,
    validateDirName: validateDirName,
    resolveWithin: resolveWithin,
    isBlockedIpLiteral: isBlockedIpLiteral,
    createGuardedLookup: createGuardedLookup,
    parseHostAllowlist: parseHostAllowlist,
    isHostAllowlisted: isHostAllowlisted,
    BLOCKED_TARGET_MESSAGE: BLOCKED_TARGET_MESSAGE
};
