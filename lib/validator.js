/**
 * 文件/目录名称验证工具
 * 同时兼容 Windows 和 Linux 平台
 */

'use strict';

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

module.exports = {
    validateFileName: validateFileName,
    validateDirName: validateDirName
};
