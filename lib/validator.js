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

module.exports = {
    validateFileName: validateFileName,
    validateDirName: validateDirName,
    resolveWithin: resolveWithin
};
