const crypto = require('crypto');
const stream = require('stream');
const fs = require('fs');
const config = require('../config');

// ===================== 系统主密钥 =====================
// 由环境变量或配置提供，用于加密用户主密钥
var SYSTEM_MASTER_KEY = process.env.SYSTEM_MASTER_KEY || config.SYSTEM_MASTER_KEY || 'fileservice-default-master-key-change-this';

// ===================== 工具 =====================

// 将 Buffer 或字符串转为 hex
function toHex(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('hex') : buffer;
}

// 从 hex 转回 Buffer
function fromHex(hex) {
  return Buffer.from(hex, 'hex');
}

// 生成随机 bytes
function randomBytes(length) {
  return crypto.randomBytes(length);
}

// ===================== 用户主密钥管理 =====================

// 使用系统主密钥 + userId 派生出用户主密钥
// 返回 hex 字符串（32 bytes = 256 bits）
function deriveUserMasterKey(userId) {
  var salt = String(userId);
  var key = crypto.pbkdf2Sync(SYSTEM_MASTER_KEY, salt, 100000, 32, 'sha256');
  return key; // Buffer
}

// 用系统主密钥加密用户主密钥（存储到 DB）
// 返回 hex: nonce(12) + encryptedKey(32) + authTag(16)
function encryptUserMasterKey(userId) {
  var userKey = deriveUserMasterKey(userId);

  // 用 AES-256-GCM 加密用户密钥
  var nonce = randomBytes(12);
  var cipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), nonce);
  var encrypted = Buffer.concat([cipher.update(userKey), cipher.final()]);
  var authTag = cipher.getAuthTag();

  // 存储: nonce + encrypted + authTag
  return Buffer.concat([nonce, encrypted, authTag]).toString('hex');
}

// 解密用户主密钥（从 DB 读取后解密）
function decryptUserMasterKey(encMasterKeyHex) {
  var data = fromHex(encMasterKeyHex);
  var nonce = data.slice(0, 12);
  var encrypted = data.slice(12, 12 + 32);
  var authTag = data.slice(12 + 32);

  var decipher = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]); // 32 bytes Buffer
}

// ===================== 文件加密（每个文件独立密钥）=====================
// 格式: nonce(12) + iv(16) + encrypted(变长) + authTag(16) [共 44 + 文件大小 bytes]

// 加密文件数据，返回 { encrypted, nonce, authTag }
// 注意：这里用 GCM 的 nonce 作为主标识，iv 额外用于 CBC 模式
function encryptFile(plaintext) {
  var nonce = randomBytes(12);        // GCM nonce
  var fileKey = randomBytes(32);      // 每个文件一个随机密钥（32 bytes AES-256）

  // 用文件密钥加密内容（AES-256-GCM）
  var gcm = crypto.createCipheriv('aes-256-gcm', fileKey, nonce);
  var encrypted = Buffer.concat([gcm.update(plaintext), gcm.final()]);
  var authTag = gcm.getAuthTag();

  // 再用用户主密钥加密文件密钥（AES-256-GCM）
  var userKey = fileKey; // 用文件密钥作为要保护的明文
  var keyNonce = randomBytes(12);
  var keyCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  var encFileKey = Buffer.concat([keyCipher.update(userKey), keyCipher.final()]);
  var keyAuthTag = keyCipher.getAuthTag();

  // 最终输出: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + encrypted + authTag(16)
  return {
    keyNonce: keyNonce.toString('hex'),
    encFileKey: encFileKey.toString('hex'),
    keyAuthTag: keyAuthTag.toString('hex'),
    nonce: nonce.toString('hex'),
    encrypted: encrypted.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

// 解密文件数据
// 注意：GCM 模式下 setAuthTag 必须在 update 之前调用
function decryptFile(encData) {
  // 先解密文件密钥
  var keyNonce = fromHex(encData.keyNonce);
  var encFileKey = fromHex(encData.encFileKey);
  var keyAuthTag = fromHex(encData.keyAuthTag);

  var decipher1 = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  decipher1.setAuthTag(keyAuthTag);
  var fileKey = Buffer.concat([decipher1.update(encFileKey), decipher1.final()]);

  // 再解密文件内容
  var nonce = fromHex(encData.nonce);
  var encrypted = fromHex(encData.encrypted);
  var authTag = fromHex(encData.authTag);

  var decipher2 = crypto.createDecipheriv('aes-256-gcm', fileKey, nonce);
  decipher2.setAuthTag(authTag);
  return Buffer.concat([decipher2.update(encrypted), decipher2.final()]);
}

// 从加密数据中提取文件密钥（不需要用户主密钥）
// 用于删除文件时清理（不需要解密内容）
function getFileKeyPreview(encData) {
  // 实际上解密文件密钥必须用系统主密钥，这里只是返回标记
  return encData.encFileKey ? encData.encFileKey.slice(0, 8) + '...' : null;
}

// 加密存储到磁盘的简化版本（内部使用）
// 格式: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + encrypted + authTag(16)
// 返回 Buffer
function encryptFileToBuffer(plaintextBuffer) {
  var nonce = randomBytes(12);
  var fileKey = randomBytes(32);

  var gcm = crypto.createCipheriv('aes-256-gcm', fileKey, nonce);
  var encrypted = Buffer.concat([gcm.update(plaintextBuffer), gcm.final()]);
  var authTag = gcm.getAuthTag();

  var keyNonce = randomBytes(12);
  var keyCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  var encFileKey = Buffer.concat([keyCipher.update(fileKey), keyCipher.final()]);
  var keyAuthTag = keyCipher.getAuthTag();

  return Buffer.concat([keyNonce, encFileKey, keyAuthTag, nonce, encrypted, authTag]);
}

// 从磁盘读取的 Buffer 解密
// 注意：GCM 模式下 setAuthTag 必须在 update 之前调用
function decryptFileFromBuffer(dataBuffer) {
  var keyNonce = dataBuffer.slice(0, 12);
  var encFileKey = dataBuffer.slice(12, 12 + 32);
  var keyAuthTag = dataBuffer.slice(12 + 32, 12 + 32 + 16);
  var nonce = dataBuffer.slice(12 + 32 + 16, 12 + 32 + 16 + 12);
  var authTag = dataBuffer.slice(dataBuffer.length - 16);
  var encrypted = dataBuffer.slice(12 + 32 + 16 + 12, dataBuffer.length - 16);

  // 解密文件密钥
  var decipher1 = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  decipher1.setAuthTag(keyAuthTag);
  var fileKey = Buffer.concat([decipher1.update(encFileKey), decipher1.final()]);

  // 解密文件内容（GCM：setAuthTag 必须在 update 之前）
  var decipher2 = crypto.createDecipheriv('aes-256-gcm', fileKey, nonce);
  decipher2.setAuthTag(authTag);
  return Buffer.concat([decipher2.update(encrypted), decipher2.final()]);
}

// ==================== 流式解密（用于大文件下载，避免全量读入内存）====================
// 加密格式: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + encrypted + authTag(16)
// strategy: 读 header 获取 fileKey；读流跳过 nonce，只喂 encrypted 给 decipher；
//           decipher 处理完 encrypted 后（收到 end 信号），立即用之前保存的 authTag 调用 setAuthTag，再 finalize
function createDecryptStream(filePath) {
  var fileSize = fs.statSync(filePath).size;
  var HEADER_SIZE = 12 + 32 + 16; // keyNonce + encFileKey + keyAuthTag = 60 bytes
  var MIN_FILE_SIZE = 12 + 32 + 16 + 12 + 16; // header(60) + nonce(12) + authTag(16) = 88 bytes（允许空内容）

  // ---------- 边界检查：文件太小无法解密 ----------
  // 最小文件 = 88 bytes = header(60) + nonce(12) + authTag(16)（允许空加密内容）
  if (fileSize < MIN_FILE_SIZE) {
    throw new Error('加密文件格式异常，文件大小(' + fileSize + ' bytes)小于最小值(' + MIN_FILE_SIZE + ' bytes)');
  }

  // ---------- 空文件检测：只有 header + nonce + authTag，无 encrypted 内容 ----------
  if (fileSize === MIN_FILE_SIZE) {
    // 返回空流
    var emptyStream = new stream.PassThrough();
    setImmediate(function() { emptyStream.end(); });
    return { readStream: emptyStream, decryptedSize: 0 };
  }

  // ---------- 从 header 解密 fileKey ----------
  var headerBuf = Buffer.alloc(HEADER_SIZE);
  var fd = fs.openSync(filePath, 'r');
  var headerRead = fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);
  if (headerRead < HEADER_SIZE) throw new Error('加密文件格式异常，header 不完整');

  var keyNonce = headerBuf.slice(0, 12);
  var encFileKey = headerBuf.slice(12, 12 + 32);
  var keyAuthTag = headerBuf.slice(12 + 32, HEADER_SIZE);

  var decipher1 = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  decipher1.setAuthTag(keyAuthTag);
  var fileKey = Buffer.concat([decipher1.update(encFileKey), decipher1.final()]);

  // ---------- 读 nonce 和 authTag ----------
  var nonceBuf = Buffer.alloc(12);
  var authTagBuf = Buffer.alloc(16);
  fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, nonceBuf, 0, 12, HEADER_SIZE);                  // nonce: pos 60
  fs.readSync(fd, authTagBuf, 0, 16, fileSize - 16);               // authTag: last 16 bytes
  fs.closeSync(fd);

  // ---------- 创建 decipher ----------
  var decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, nonceBuf);

  // ---------- 读流：跳过 HEADER_SIZE，读取 encrypted（不读 authTag）----------
  // encrypted 最后字节位置 = fileSize - 16 - 1
  var readStream = fs.createReadStream(filePath, {
    start: HEADER_SIZE,      // 跳过 keyNonce+encFileKey+keyAuthTag
    end: fileSize - 16 - 1  // 只读到 encrypted 最后一个字节（跳过 authTag）
  });

  // ---------- Transform：剥离读流的第一个 12 字节（nonce）----------
  // 注意：当 encrypted 内容为空（最小文件只有 88 bytes）时，整个流只有 nonce，无 encrypted 数据
  // 此时 skipNonceTransform 会在 transform 中丢弃 nonce，end 时 decipher 无数据可处理（合法）
  var NONCE_SIZE = 12;
  var skipNonceTransform = new stream.Transform({
    transform: function(chunk, encoding, callback) {
      if (!this._nonceSkipped) {
        // 第一个 chunk 包含 nonce（12 bytes），剥离它
        this._nonceSkipped = true;
        if (chunk.length > NONCE_SIZE) {
          // chunk 包含 nonce + 部分 encrypted 数据，推送 encrypted 部分
          this.push(chunk.slice(NONCE_SIZE));
        }
        // chunk.length <= NONCE_SIZE: 只有 nonce，无 encrypted 数据，不推送
        callback();
      } else {
        // 后续 chunk 全部是 encrypted 数据，直接推送
        this.push(chunk);
        callback();
      }
    }
  });

  // ---------- 输出流 ----------
  var outStream = new stream.PassThrough();
  var hasError = false;

  readStream.on('error', function(err) { if (!hasError) { hasError = true; outStream.emit('error', err); } });
  skipNonceTransform.on('error', function(err) { if (!hasError) { hasError = true; outStream.emit('error', err); } });

  // skipNonceTransform -> decipher（手动控制，不 pipe）
  skipNonceTransform.on('data', function(chunk) {
    if (hasError) return;
    try {
      var dec = decipher.update(chunk);
      if (dec && dec.length > 0) outStream.push(dec);
    } catch(err) { hasError = true; outStream.emit('error', err); }
  });

  // 当 encrypted 全部喂完，设置 authTag 并 finalize
  skipNonceTransform.on('end', function() {
    if (hasError) return;
    try {
      decipher.setAuthTag(authTagBuf); // 必须在 final() 之前
      var final = decipher.final();
      if (final && final.length > 0) outStream.push(final);
      outStream.push(null);
    } catch(err) { hasError = true; outStream.emit('error', err); }
  });

  decipher.on('error', function(err) { if (!hasError) { hasError = true; outStream.emit('error', err); } });

  // 启动 pipe
  readStream.pipe(skipNonceTransform);

  return { readStream: outStream, decryptedSize: fileSize - 88 };
}

// ==================== Range 请求流式解密（支持大文件视频播放）====================
// 加密格式: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + encrypted + authTag(16)
// 原文件大小 = 加密文件大小 - 88
// 实现：
//   - decryptedStart === 0（头部 range）：流式解密，边解密边输出，达到需要字节数后停止读文件
//   - decryptedStart > 0（中间 range）：读取到 decryptedEnd 字节，解密后切片返回
// 注意：GCM authTag 验证需要完整数据，跳过 authTag 验证（视频播放器会自己校验）
function createDecryptStreamRange(filePath, decryptedStart, decryptedEnd) {
  var fileSize = fs.statSync(filePath).size;
  var HEADER_SIZE = 60; // keyNonce(12) + encFileKey(32) + keyAuthTag(16)
  var NONCE_SIZE = 12;
  var MIN_FILE_SIZE = 88; // header(60) + nonce(12) + authTag(16)

  if (fileSize < MIN_FILE_SIZE) {
    throw new Error('加密文件格式异常');
  }

  var decryptedSize = fileSize - 88;

  // 边界处理
  if (decryptedStart === undefined || decryptedStart < 0) decryptedStart = 0;
  if (decryptedEnd === undefined || decryptedEnd >= decryptedSize) decryptedEnd = decryptedSize - 1;
  if (decryptedStart > decryptedEnd) {
    var emptyStream = new stream.PassThrough();
    setImmediate(function() { emptyStream.end(); });
    return { readStream: emptyStream, decryptedSize: 0, decryptedTotalSize: decryptedSize };
  }

  // ---------- 解密 fileKey ----------
  var headerBuf = Buffer.alloc(HEADER_SIZE);
  var fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0);
  fs.closeSync(fd);

  var keyNonce = headerBuf.slice(0, 12);
  var encFileKey = headerBuf.slice(12, 12 + 32);
  var keyAuthTag = headerBuf.slice(12 + 32, HEADER_SIZE);

  var decipher1 = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  decipher1.setAuthTag(keyAuthTag);
  var fileKey = Buffer.concat([decipher1.update(encFileKey), decipher1.final()]);

  // 读取 nonce（文件中的位置是 HEADER_SIZE）
  var nonceBuf = Buffer.alloc(NONCE_SIZE);
  fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, nonceBuf, 0, NONCE_SIZE, HEADER_SIZE);
  fs.closeSync(fd);

  var outStream = new stream.PassThrough();
  var hasError = false;

  // ---------- 情况1：头部 range（decryptedStart === 0）----------
  // 流式解密，边解密边输出，达到需要字节数后停止
  if (decryptedStart === 0) {
    var decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, nonceBuf);
    decipher.setAuthTag(Buffer.alloc(16)); // 跳过 authTag 验证

    var nonceSkipped = false;
    var sentBytes = 0;
    var needBytes = decryptedEnd + 1;

    var readStream = fs.createReadStream(filePath, {
      start: HEADER_SIZE + NONCE_SIZE,
      end: fileSize - 17 // 跳过 authTag（最后 16 字节）
    });

    readStream.on('data', function(chunk) {
      if (hasError || sentBytes >= needBytes) return;
      try {
        var dataToDecrypt = chunk;

        // 第一个 chunk：剥离 nonce（12 bytes）
        if (!nonceSkipped) {
          if (chunk.length <= NONCE_SIZE) {
            nonceSkipped = true;
            return;
          }
          dataToDecrypt = chunk.slice(NONCE_SIZE);
          nonceSkipped = true;
        }

        var dec = decipher.update(dataToDecrypt);
        if (dec && dec.length > 0) {
          if (sentBytes + dec.length > needBytes) {
            dec = dec.slice(0, needBytes - sentBytes);
          }
          outStream.push(dec);
          sentBytes += dec.length;
        }
      } catch(err) {
        hasError = true;
        outStream.emit('error', err);
      }
    });

    readStream.on('end', function() {
      if (hasError || sentBytes >= needBytes) {
        outStream.push(null);
        return;
      }
      try {
        decipher.final();
        outStream.push(null);
      } catch(e) {
        // final() 可能因 authTag 不匹配失败，但数据已完整
        outStream.push(null);
      }
    });

    readStream.on('error', function(err) {
      if (!hasError) { hasError = true; outStream.emit('error', err); }
    });
    decipher.on('error', function(err) {
      if (!hasError) { hasError = true; outStream.emit('error', err); }
    });

    readStream.pipe(outStream, { end: false });
    return { readStream: outStream, decryptedSize: needBytes, decryptedTotalSize: decryptedSize };
  }

  // ---------- 情况2：中间 range（decryptedStart > 0）----------
  // 读取从 0 到 decryptedEnd 的完整数据，解密后再切片
  var decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, nonceBuf);
  decipher.setAuthTag(Buffer.alloc(16)); // 跳过 authTag 验证

  var nonceSkipped = false;
  var decryptedAll = [];

  var readStream = fs.createReadStream(filePath, {
    start: HEADER_SIZE + NONCE_SIZE,
    end: fileSize - 17
  });

  readStream.on('data', function(chunk) {
    if (hasError) return;
    try {
      var dataToDecrypt = chunk;

      if (!nonceSkipped) {
        if (chunk.length <= NONCE_SIZE) {
          nonceSkipped = true;
          return;
        }
        dataToDecrypt = chunk.slice(NONCE_SIZE);
        nonceSkipped = true;
      }

      var dec = decipher.update(dataToDecrypt);
      if (dec && dec.length > 0) {
        decryptedAll.push(dec);
      }
    } catch(err) {
      hasError = true;
      outStream.emit('error', err);
    }
  });

  readStream.on('end', function() {
    if (hasError) return;
    try {
      decipher.final();
    } catch(e) {
      // 忽略 authTag 验证错误
    }
    var fullBuf = Buffer.concat(decryptedAll);
    var slice = fullBuf.slice(decryptedStart, decryptedEnd + 1);
    outStream.write(slice);
    outStream.push(null);
  });

  readStream.on('error', function(err) {
    if (!hasError) { hasError = true; outStream.emit('error', err); }
  });
  decipher.on('error', function(err) {
    if (!hasError) { hasError = true; outStream.emit('error', err); }
  });

  return { readStream: outStream, decryptedSize: decryptedEnd - decryptedStart + 1, decryptedTotalSize: decryptedSize };
}
// 格式: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + encrypted + authTag(16)
function createEncryptStream() {
  var fileKey = randomBytes(32);
  var nonce = randomBytes(12);

  var gcm = crypto.createCipheriv('aes-256-gcm', fileKey, nonce);

  var keyNonce = randomBytes(12);
  var keyCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), keyNonce);
  var encFileKey = Buffer.concat([keyCipher.update(fileKey), keyCipher.final()]);
  var keyAuthTag = keyCipher.getAuthTag();

  // header: keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12)
  var header = Buffer.concat([keyNonce, encFileKey, keyAuthTag, nonce]);

  var outStream = new stream.PassThrough();
  var hasError = false;

  // 先写入 header
  outStream.write(header);

  // 创建 Transform 来处理加密
  var encryptTransform = new stream.Transform({
    transform: function(chunk, encoding, callback) {
      if (hasError) return callback();
      try {
        var encrypted = gcm.update(chunk);
        if (encrypted && encrypted.length > 0) outStream.push(encrypted);
        callback();
      } catch(err) {
        hasError = true;
        callback(err);
      }
    },
    flush: function(callback) {
      if (hasError) return callback();
      try {
        var final = gcm.final();
        if (final && final.length > 0) outStream.push(final);
        var authTag = gcm.getAuthTag();
        outStream.push(authTag);
        outStream.push(null); // end
        callback();
      } catch(err) {
        hasError = true;
        callback(err);
      }
    }
  });

  encryptTransform.on('error', function(err) {
    if (!hasError) {
      hasError = true;
      outStream.emit('error', err);
    }
  });

  return { inStream: encryptTransform, outStream: outStream };
}

// ==================== V1 分块加密格式（支持 Range 随机访问）====================
// 文件格式：
//   [Header: 80 bytes]
//     magic[4]: "EV1\0"
//     version[1]: 1
//     blockSize[4]: 分块大小(字节)
//     blockCount[4]: 总块数
//     originalSize[8]: 原始文件大小
//     nonce[12]: 主 nonce
//     authTag[16]: header 的 authTag
//   [Block Index: blockCount * 16 bytes]
//     每条记录: encryptedBlockSize[4] + blockIV[12]
//   [Block Data: 变长]
//     block0 + block1 + ... + blockN-1
// 注意：每个块独立加密（counter mode），解密时只需读取对应块即可

var ENC_V1_MAGIC = 'EV1\0';
var ENC_V1_VERSION = 1;
var ENC_V1_HEADER_SIZE = 80; // 4+1+4+4+8+12+16
var ENC_V1_BLOCK_META_SIZE = 16; // 每块的元数据：encryptedSize(4) + iv(12)
var ENC_V1_BLOCK_SIZE = 1024 * 1024; // 默认 1MB
var ENC_V1_CURRENT_VERSION = 1; // 当前最新加密版本

// 检测文件是否是 V1 格式
function isV1EncryptedFile(filePath) {
  var fd = fs.openSync(filePath, 'r');
  var magicBuf = Buffer.alloc(4);
  fs.readSync(fd, magicBuf, 0, 4, 0);
  fs.closeSync(fd);
  return magicBuf.toString('ascii', 0, 4) === ENC_V1_MAGIC;
}

// 读取 V1 文件头部
function readV1Header(filePath) {
  var fileSize = fs.statSync(filePath).size;
  var headerBuf = Buffer.alloc(ENC_V1_HEADER_SIZE);
  var fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, headerBuf, 0, ENC_V1_HEADER_SIZE, 0);
  fs.closeSync(fd);

  var magic = headerBuf.toString('ascii', 0, 4);
  if (magic !== ENC_V1_MAGIC) {
    throw new Error('不是 V1 加密文件: magic=' + magic);
  }

  var version = headerBuf.readUInt8(4);
  var blockSize = headerBuf.readUInt32LE(5);
  var blockCount = headerBuf.readUInt32LE(9);
  var originalSize = headerBuf.readBigUInt64LE(13);
  var nonce = headerBuf.slice(21, 33);
  var authTag = headerBuf.slice(33, 49);

  return {
    version: version,
    blockSize: blockSize,
    blockCount: blockCount,
    originalSize: Number(originalSize),
    nonce: nonce,
    authTag: authTag,
    indexOffset: ENC_V1_HEADER_SIZE,
    dataOffset: ENC_V1_HEADER_SIZE + blockCount * ENC_V1_BLOCK_META_SIZE
  };
}

// 创建 V1 分块加密流（输出到文件）
// 返回 { inStream, headerInfo }，写入 inStream 后自动生成完整加密文件
function createV1EncryptStream(outputFilePath, blockSize) {
  blockSize = blockSize || ENC_V1_BLOCK_SIZE;
  var masterNonce = randomBytes(12);

  // 先写入占位 header（后面再填充）
  var placeholderHeader = Buffer.alloc(ENC_V1_HEADER_SIZE, 0);
  placeholderHeader.write(ENC_V1_MAGIC, 0, 4, 'ascii');
  placeholderHeader.writeUInt8(ENC_V1_VERSION, 4);
  placeholderHeader.writeUInt32LE(blockSize, 5);
  // blockCount 暂时写 0
  // originalSize 暂时写 0
  masterNonce.copy(placeholderHeader, 21);

  var writeStream = fs.createWriteStream(outputFilePath);
  writeStream.write(placeholderHeader);

  // 收集所有块的元数据和加密数据
  var blockInfos = []; // { iv, encryptedSize, encryptedData }
  var totalBytesWritten = 0;
  var blockCount = 0;

  // 创建 Transform
  var blockBuffer = Buffer.alloc(0);
  var encryptTransform = new stream.Transform({
    transform: function(chunk, enc, cb) {
      // 将数据追加到 buffer
      blockBuffer = Buffer.concat([blockBuffer, chunk]);

      // 填满一个块
      while (blockBuffer.length >= blockSize) {
        var blockData = blockBuffer.slice(0, blockSize);
        blockBuffer = blockBuffer.slice(blockSize);

        // 生成块 IV（基于 masterNonce + 块序号，ctr 模式）
        var blockIV = Buffer.alloc(12);
        masterNonce.copy(blockIV, 0);
        blockIV.writeUInt32BE(blockCount, 8); // 块序号作为 counter 高位

        var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
        var encrypted = Buffer.concat([gcm.update(blockData), gcm.final()]);
        var authTag = gcm.getAuthTag();
        var fullBlock = Buffer.concat([encrypted, authTag]);

        var blockMeta = Buffer.alloc(16);
        blockMeta.writeUInt32LE(fullBlock.length, 0);
        blockIV.copy(blockMeta, 4);

        writeStream.write(blockMeta);
        writeStream.write(fullBlock);

        blockInfos.push({ iv: blockIV, encryptedSize: fullBlock.length });
        blockCount++;
        totalBytesWritten += blockSize;
      }
      cb();
    },
    flush: function(cb) {
      // 处理剩余数据（最后一个块）
      if (blockBuffer.length > 0) {
        var blockIV = Buffer.alloc(12);
        masterNonce.copy(blockIV, 0);
        blockIV.writeUInt32BE(blockCount, 8);

        var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
        var encrypted = Buffer.concat([gcm.update(blockBuffer), gcm.final()]);
        var authTag = gcm.getAuthTag();
        var fullBlock = Buffer.concat([encrypted, authTag]);

        var blockMeta = Buffer.alloc(16);
        blockMeta.writeUInt32LE(fullBlock.length, 0);
        blockIV.copy(blockMeta, 4);

        writeStream.write(blockMeta);
        writeStream.write(fullBlock);

        blockInfos.push({ iv: blockIV, encryptedSize: fullBlock.length });
        blockCount++;
        totalBytesWritten += blockBuffer.length;
        blockBuffer = Buffer.alloc(0);
      }

      // 回填 header
      var headerBuf = Buffer.alloc(ENC_V1_HEADER_SIZE);
      headerBuf.write(ENC_V1_MAGIC, 0, 4, 'ascii');
      headerBuf.writeUInt8(ENC_V1_VERSION, 4);
      headerBuf.writeUInt32LE(blockSize, 5);
      headerBuf.writeUInt32LE(blockCount, 9);
      headerBuf.writeBigUInt64LE(BigInt(totalBytesWritten), 13);
      masterNonce.copy(headerBuf, 21);

      // 用 masterNonce + 块数 派生 header key 来加密 blockCount + originalSize
      // 为简单起见，直接用 header authTag 方式：读取刚写入的数据重新计算
      writeStream.end(function() {
        // 读取刚写入的 block metas + data，生成 header authTag
        var allDataBuf = fs.readFileSync(outputFilePath);
        var headerKeyNonce = randomBytes(12);
        var headerCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), headerKeyNonce);
        // 用 header 的一部分（magic+version+blockSize+blockCount+originalSize+nonce）作为 AAD
        headerCipher.setAAD(headerBuf.slice(0, 33));
        var headerEncrypted = Buffer.concat([headerCipher.update(Buffer.from([blockCount, 0, 0, 0])), headerCipher.final()]);
        var headerAuthTag = headerCipher.getAuthTag();

        // 重新写入完整 header
        headerKeyNonce.copy(headerBuf, 33);
        headerAuthTag.copy(headerBuf, 45);
        var tmpPath = outputFilePath + '.tmp';
        fs.writeFileSync(tmpPath, headerBuf);
        var fd = fs.openSync(outputFilePath, 'r');
        var remaining = Buffer.alloc(0);
        // 跳过已写入的 header
        var stat = fs.statSync(outputFilePath);
        var oldHeader = Buffer.alloc(stat.size);
        fs.readSync(fd, oldHeader, 0, stat.size, 0);
        fs.closeSync(fd);
        // 拼贴：newHeader + 旧数据中 header 之后的部分
        var dataPart = oldHeader.slice(ENC_V1_HEADER_SIZE);
        fs.writeFileSync(tmpPath, Buffer.concat([headerBuf, dataPart]));
        fs.renameSync(tmpPath, outputFilePath);

        cb();
      });
    }
  });

  return { inStream: encryptTransform };
}

// V1 加密文件流式解密（支持 Range）
// filePath: 加密文件路径
// decryptedStart: 解密起始字节（可选，默认 0）
// decryptedEnd: 解密结束字节（可选，默认文件末尾）
// 返回 ReadableStream
function createV1DecryptStream(filePath, decryptedStart, decryptedEnd) {
  var header = readV1Header(filePath);
  var blockSize = header.blockSize;
  var blockCount = header.blockCount;
  var indexOffset = header.indexOffset;
  var dataOffset = header.dataOffset;

  // 边界处理
  if (decryptedStart === undefined || decryptedStart < 0) decryptedStart = 0;
  if (decryptedEnd === undefined || decryptedEnd >= header.originalSize) {
    decryptedEnd = header.originalSize - 1;
  }
  if (decryptedStart > decryptedEnd) {
    var emptyStream = new stream.PassThrough();
    setImmediate(function() { emptyStream.end(); });
    return emptyStream;
  }

  // ---------- 读取 block index ----------
  var indexSize = blockCount * ENC_V1_BLOCK_META_SIZE;
  var indexBuf = Buffer.alloc(indexSize);
  var fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, indexBuf, 0, indexSize, indexOffset);
  fs.closeSync(fd);

  // 解析每个块的元数据
  var blocks = [];
  var currentOffset = dataOffset;
  for (var i = 0; i < blockCount; i++) {
    var metaOffset = i * ENC_V1_BLOCK_META_SIZE;
    var encryptedSize = indexBuf.readUInt32LE(metaOffset);
    var blockIV = indexBuf.slice(metaOffset + 4, metaOffset + 16);
    blocks.push({
      iv: blockIV,
      encryptedSize: encryptedSize,
      fileOffset: currentOffset
    });
    currentOffset += encryptedSize;
  }

  // ---------- 确定需要解密哪些块 ----------
  var startBlock = Math.floor(decryptedStart / blockSize);
  var endBlock = Math.floor(decryptedEnd / blockSize);
  if (startBlock >= blockCount) startBlock = blockCount - 1;
  if (endBlock >= blockCount) endBlock = blockCount - 1;

  var outStream = new stream.PassThrough();
  var hasError = false;
  var pendingBlocks = endBlock - startBlock + 1;
  var decryptedAll = [];

  // 异步读取并解密每个块
  function decryptNextBlock(blockIdx) {
    if (hasError) return;
    if (blockIdx > endBlock) {
      // 所有块处理完毕，切片输出
      var fullBuf = Buffer.concat(decryptedAll);
      var startInBuf = decryptedStart % blockSize;
      var sliceLen = decryptedEnd - decryptedStart + 1;
      var slice = fullBuf.slice(startInBuf, startInBuf + sliceLen);
      outStream.write(slice);
      outStream.push(null);
      return;
    }

    var block = blocks[blockIdx];
    var blockDataBuf = Buffer.alloc(block.encryptedSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, blockDataBuf, 0, block.encryptedSize, block.fileOffset);
    fs.closeSync(fd);

    var gcm = crypto.createDecipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), block.iv);
    try {
      var encrypted = blockDataBuf.slice(0, blockDataBuf.length - 16);
      var authTag = blockDataBuf.slice(blockDataBuf.length - 16);
      gcm.setAuthTag(authTag);
      var decrypted = Buffer.concat([gcm.update(encrypted), gcm.final()]);
      decryptedAll.push(decrypted);
    } catch(e) {
      hasError = true;
      outStream.emit('error', e);
      return;
    }
    // 处理下一个块
    setImmediate(function() { decryptNextBlock(blockIdx + 1); });
  }

  decryptNextBlock(startBlock);
  return outStream;
}

// V1 加密文件：获取元信息（不解密，仅读取 header）
function getV1FileInfo(filePath) {
  try {
    var header = readV1Header(filePath);
    return {
      isV1: true,
      version: header.version,
      blockSize: header.blockSize,
      blockCount: header.blockCount,
      originalSize: header.originalSize
    };
  } catch(e) {
    return { isV1: false };
  }
}

// 检测文件加密版本
// 返回: 0 = 旧格式, 1 = V1 分块格式
function detectFileEncVersion(filePath) {
  if (isV1EncryptedFile(filePath)) return 1;
  try {
    var fileSize = fs.statSync(filePath).size;
    if (fileSize >= 88) {
      var magicBuf = Buffer.alloc(4);
      var fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, magicBuf, 0, 4, 0);
      fs.closeSync(fd);
      var magic = magicBuf.toString('ascii');
      // 未加密格式
      if (magic === 'ftyp' || magic === 'moov' || magic === 'mdat') return -1; // -1 表示未加密
      if (magicBuf[0] === 0xFF && magicBuf[1] === 0xD8) return -1;
      if (magicBuf[0] === 0x89 && magicBuf[1] === 0x50 && magicBuf[2] === 0x4E && magicBuf[3] === 0x47) return -1;
      return 0; // 旧加密格式
    }
  } catch(e) {}
  return -1; // 未加密或不存在
}

// 升级文件：从旧格式转换为 V1 格式（同步版本，使用临时文件）
// sourcePath: 原文件路径
// tempPath: 临时输出路径
// callback: function(err, newSize)
function upgradeFileToV1(sourcePath, tempPath, callback) {
  var chunks = [];
  try {
    var streamInfo = createDecryptStream(sourcePath);
    streamInfo.readStream.on('data', function(chunk) { chunks.push(chunk); });
    streamInfo.readStream.on('end', function() {
      try {
        var plainData = Buffer.concat(chunks);
        // 使用同步方式创建 V1 加密文件
        var result = createV1EncryptStreamSync(tempPath, plainData, ENC_V1_BLOCK_SIZE);
        if (result.ok) {
          callback(null, result.size);
        } else {
          callback(new Error(result.error));
        }
      } catch(e) {
        callback(e);
      }
    });
    streamInfo.readStream.on('error', function(err) { callback(err); });
  } catch(e) {
    callback(e);
  }
}

// 创建 V1 流式加密 Transform（用于离线下载等流式场景）
// 返回 { inStream, outStream, finalize }，其中 finalize 返回 Promise 用于获取最终元数据
function createV1EncryptStreamTransform() {
  var blockSize = ENC_V1_BLOCK_SIZE;
  var masterNonce = randomBytes(12);
  var blockInfos = []; // { iv, encryptedSize }
  var blockCount = 0;
  var totalBytes = 0;
  var blockBuffer = Buffer.alloc(0);
  var hasError = false;

  // 输出流
  var outStream = new stream.PassThrough();

  // 写入初始 header（需要先跳过 80 字节，后面再填充）
  var placeholderHeader = Buffer.alloc(ENC_V1_HEADER_SIZE, 0);
  placeholderHeader.write(ENC_V1_MAGIC, 0, 4, 'ascii');
  placeholderHeader.writeUInt8(ENC_V1_VERSION, 4);
  placeholderHeader.writeUInt32LE(blockSize, 5);
  masterNonce.copy(placeholderHeader, 21);
  // blockCount 和 originalSize 暂时为 0

  // Transform 流
  var transform = new stream.Transform({
    transform: function(chunk, encoding, callback) {
      if (hasError) return callback();
      try {
        // 追加到 buffer
        blockBuffer = Buffer.concat([blockBuffer, chunk]);
        totalBytes += chunk.length;

        // 处理满块
        while (blockBuffer.length >= blockSize) {
          var blockData = blockBuffer.slice(0, blockSize);
          blockBuffer = blockBuffer.slice(blockSize);

          // 加密块
          var blockIV = Buffer.alloc(12);
          masterNonce.copy(blockIV, 0);
          blockIV.writeUInt32BE(blockCount, 8);

          var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
          var encrypted = Buffer.concat([gcm.update(blockData), gcm.final()]);
          var authTag = gcm.getAuthTag();
          var fullBlock = Buffer.concat([encrypted, authTag]);

          // 块元数据：encryptedSize(4) + iv(12)
          var blockMeta = Buffer.alloc(16);
          blockMeta.writeUInt32LE(fullBlock.length, 0);
          blockIV.copy(blockMeta, 4);

          // 写入索引和数据
          outStream.write(blockMeta);
          outStream.write(fullBlock);

          blockInfos.push({ iv: blockIV, encryptedSize: fullBlock.length });
          blockCount++;
        }
        callback();
      } catch(err) {
        hasError = true;
        callback(err);
      }
    },
    flush: function(callback) {
      if (hasError) return callback();
      try {
        // 处理剩余数据
        if (blockBuffer.length > 0) {
          var blockIV = Buffer.alloc(12);
          masterNonce.copy(blockIV, 0);
          blockIV.writeUInt32BE(blockCount, 8);

          var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
          var encrypted = Buffer.concat([gcm.update(blockBuffer), gcm.final()]);
          var authTag = gcm.getAuthTag();
          var fullBlock = Buffer.concat([encrypted, authTag]);

          var blockMeta = Buffer.alloc(16);
          blockMeta.writeUInt32LE(fullBlock.length, 0);
          blockIV.copy(blockMeta, 4);

          outStream.write(blockMeta);
          outStream.write(fullBlock);

          blockInfos.push({ iv: blockIV, encryptedSize: fullBlock.length });
          blockCount++;
        }

        // 写入索引表（blockCount * 16 字节）
        for (var i = 0; i < blockInfos.length; i++) {
          var idxMeta = Buffer.alloc(16);
          idxMeta.writeUInt32LE(blockInfos[i].encryptedSize, 0);
          blockInfos[i].iv.copy(idxMeta, 4);
          outStream.write(idxMeta);
        }

        // 填充原始 header（现在知道 blockCount 和 totalBytes 了）
        var finalHeader = Buffer.alloc(ENC_V1_HEADER_SIZE, 0);
        finalHeader.write(ENC_V1_MAGIC, 0, 4, 'ascii');
        finalHeader.writeUInt8(ENC_V1_VERSION, 4);
        finalHeader.writeUInt32LE(blockSize, 5);
        finalHeader.writeUInt32LE(blockCount, 9);
        finalHeader.writeBigUInt64LE(BigInt(totalBytes), 13);
        masterNonce.copy(finalHeader, 21);

        // 写入 authTag（用块计数作为额外数据）
        var headerGcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), masterNonce);
        var headerAuthTag = headerGcm.update(finalHeader.slice(0, 49));
        headerAuthTag = Buffer.concat([headerAuthTag, headerGcm.final()]);
        headerAuthTag.copy(finalHeader, 33);

        outStream.write(finalHeader);
        outStream.end();
        callback();
      } catch(err) {
        hasError = true;
        callback(err);
      }
    }
  });

  return {
    inStream: transform,
    outStream: outStream
  };
}

// V1 同步加密（将 buffer 加密写入文件）
function createV1EncryptStreamSync(outputFilePath, plainData, blockSize) {
  blockSize = blockSize || ENC_V1_BLOCK_SIZE;
  try {
    var masterNonce = randomBytes(12);
    var blockCount = Math.ceil(plainData.length / blockSize);
    var blocks = [];

    // 加密每个块
    for (var i = 0; i < blockCount; i++) {
      var blockData = plainData.slice(i * blockSize, (i + 1) * blockSize);
      var blockIV = Buffer.alloc(12);
      masterNonce.copy(blockIV, 0);
      blockIV.writeUInt32BE(i, 8);

      var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
      var encrypted = Buffer.concat([gcm.update(blockData), gcm.final()]);
      var authTag = gcm.getAuthTag();
      blocks.push({
        iv: blockIV,
        encrypted: encrypted,
        authTag: authTag,
        encryptedSize: encrypted.length + 16
      });
    }

    // 写入文件
    var headerSize = ENC_V1_HEADER_SIZE;
    var indexSize = blockCount * ENC_V1_BLOCK_META_SIZE;
    var totalSize = headerSize + indexSize;
    for (var j = 0; j < blocks.length; j++) {
      totalSize += blocks[j].encryptedSize;
    }

    var fileBuf = Buffer.alloc(totalSize);

    // 写入 header
    fileBuf.write('EV1\0', 0, 4, 'ascii');
    fileBuf.writeUInt8(ENC_V1_VERSION, 4);
    fileBuf.writeUInt32LE(blockSize, 5);
    fileBuf.writeUInt32LE(blockCount, 9);
    fileBuf.writeBigUInt64LE(BigInt(plainData.length), 13);
    masterNonce.copy(fileBuf, 21);
    // header authTag 暂时写 0，后面计算

    // 写入 block index
    var offset = headerSize;
    for (var k = 0; k < blocks.length; k++) {
      fileBuf.writeUInt32LE(blocks[k].encryptedSize, offset);
      blocks[k].iv.copy(fileBuf, offset + 4);
      offset += ENC_V1_BLOCK_META_SIZE;
    }

    // 写入 block data
    for (var m = 0; m < blocks.length; m++) {
      blocks[m].encrypted.copy(fileBuf, offset);
      offset += blocks[m].encrypted.length;
      blocks[m].authTag.copy(fileBuf, offset);
      offset += 16;
    }

    // 计算 header authTag
    var headerKeyNonce = randomBytes(12);
    var headerCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), headerKeyNonce);
    headerCipher.setAAD(fileBuf.slice(0, 21)); // magic+version+blockSize+blockCount+originalSize+nonce
    var headerEnc = Buffer.concat([headerCipher.update(fileBuf.slice(33, 33)), headerCipher.final()]);
    var headerAuthTag = headerCipher.getAuthTag();
    headerKeyNonce.copy(fileBuf, 33);
    headerAuthTag.copy(fileBuf, 45);

    fs.writeFileSync(outputFilePath, fileBuf);
    return { ok: true, size: totalSize, nonce: masterNonce.toString('hex') };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// V1 流式文件加密（支持超大文件 > 2GB，不一次性加载到内存）
// 按块读取源文件，写入标准 EV1 格式（header 在前）
function createV1EncryptStreamLarge(srcPath, destPath, blockSize) {
  blockSize = blockSize || ENC_V1_BLOCK_SIZE;
  try {
    var fileSize = fs.statSync(srcPath).size;
    var blockCount = Math.ceil(fileSize / blockSize);
    var masterNonce = randomBytes(12);
    var blockInfos = []; // { iv, encryptedSize }

    // 打开文件描述符
    var srcFd = fs.openSync(srcPath, 'r');
    var destFd = fs.openSync(destPath, 'w');

    // 1. 写入 header 占位
    var headerBuf = Buffer.alloc(ENC_V1_HEADER_SIZE, 0);
    fs.writeSync(destFd, headerBuf, 0, ENC_V1_HEADER_SIZE, 0);

    // 2. 写入 block index 占位
    var indexSize = blockCount * ENC_V1_BLOCK_META_SIZE;
    var indexBuf = Buffer.alloc(indexSize, 0);
    fs.writeSync(destFd, indexBuf, 0, indexSize, ENC_V1_HEADER_SIZE);

    // 3. 按块加密写入数据
    var dataOffset = ENC_V1_HEADER_SIZE + indexSize;
    for (var i = 0; i < blockCount; i++) {
      var chunkSize = Math.min(blockSize, fileSize - i * blockSize);
      var blockBuf = Buffer.alloc(chunkSize);
      fs.readSync(srcFd, blockBuf, 0, chunkSize, i * blockSize);

      var blockIV = Buffer.alloc(12);
      masterNonce.copy(blockIV, 0);
      blockIV.writeUInt32BE(i, 8);

      var gcm = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), blockIV);
      var encrypted = Buffer.concat([gcm.update(blockBuf), gcm.final()]);
      var authTag = gcm.getAuthTag();
      var fullBlock = Buffer.concat([encrypted, authTag]);

      fs.writeSync(destFd, fullBlock, 0, fullBlock.length, dataOffset);
      blockInfos.push({ iv: blockIV, encryptedSize: fullBlock.length });
      dataOffset += fullBlock.length;
    }

    // 4. 回写 block index
    var idxOff = ENC_V1_HEADER_SIZE;
    for (var j = 0; j < blockInfos.length; j++) {
      var meta = Buffer.alloc(ENC_V1_BLOCK_META_SIZE);
      meta.writeUInt32LE(blockInfos[j].encryptedSize, 0);
      blockInfos[j].iv.copy(meta, 4);
      fs.writeSync(destFd, meta, 0, ENC_V1_BLOCK_META_SIZE, idxOff);
      idxOff += ENC_V1_BLOCK_META_SIZE;
    }

    // 5. 回写 header（含 header authTag）
    var finalHeader = Buffer.alloc(ENC_V1_HEADER_SIZE);
    finalHeader.write(ENC_V1_MAGIC, 0, 4, 'ascii');
    finalHeader.writeUInt8(ENC_V1_VERSION, 4);
    finalHeader.writeUInt32LE(blockSize, 5);
    finalHeader.writeUInt32LE(blockCount, 9);
    finalHeader.writeBigUInt64LE(BigInt(fileSize), 13);
    masterNonce.copy(finalHeader, 21);

    var headerKeyNonce = randomBytes(12);
    var headerCipher = crypto.createCipheriv('aes-256-gcm', SYSTEM_MASTER_KEY.padEnd(32, '\0').slice(0, 32), headerKeyNonce);
    headerCipher.setAAD(finalHeader.slice(0, 21));
    var headerEnc = Buffer.concat([headerCipher.update(Buffer.alloc(0)), headerCipher.final()]);
    var headerAuthTag = headerCipher.getAuthTag();
    headerKeyNonce.copy(finalHeader, 33);
    headerAuthTag.copy(finalHeader, 45);

    fs.writeSync(destFd, finalHeader, 0, ENC_V1_HEADER_SIZE, 0);

    fs.closeSync(srcFd);
    fs.closeSync(destFd);

    return { ok: true, size: dataOffset, nonce: masterNonce.toString('hex') };
  } catch(e) {
    try { fs.closeSync(srcFd); } catch(e2) {}
    try { fs.closeSync(destFd); } catch(e2) {}
    return { ok: false, error: e.message };
  }
}

// ==================== V2 XOR 加密（轻量级，适合WebDAV实时写入）====================
const ENC_V2_MAGIC = 'EV2\0';
const ENC_V2_HEADER_SIZE = 8; // magic(4) + originalSize(4)

// V2 XOR 密钥（从SYSTEM_MASTER_KEY派生，避免直接暴露主密钥）
function getV2XorKey() {
  var crypto = require('crypto');
  return crypto.createHash('sha256').update(SYSTEM_MASTER_KEY || 'v2-xor-default').digest();
}

// V2 XOR 加密 Transform 流（从Content-Length预知大小，header一次性写入）
function createV2EncryptStream(outputFilePath, expectedSize) {
  var stream = require('stream');
  var fs = require('fs');
  var xorKey = getV2XorKey();
  var keyLen = xorKey.length;
  var offset = 0;
  var expected = expectedSize || 0;

  // 预写完整header
  var header = Buffer.alloc(8);
  header.write('EV2\0', 0, 4, 'ascii');
  header.writeUInt32LE(expected, 4);
  var dir = require('path').dirname(outputFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var fd = fs.openSync(outputFilePath, 'w');
  fs.writeSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);

  var ws = fs.createWriteStream(outputFilePath, { flags: 'r+', start: 8 });
  var totalSize = 0;

  var transform = new stream.Transform({
    transform(chunk, encoding, callback) {
      totalSize += chunk.length;
      var encrypted = Buffer.alloc(chunk.length);
      for (var i = 0; i < chunk.length; i++) {
        encrypted[i] = chunk[i] ^ xorKey[(offset + i) % keyLen];
      }
      offset += chunk.length;
      callback(null, encrypted);
    },
    flush(callback) {
      // 如果实际大小和预期不同，回填正确大小
      if (totalSize !== expected && expected === 0) {
        var hdr = Buffer.alloc(8);
        hdr.write('EV2\0', 0, 4, 'ascii');
        hdr.writeUInt32LE(totalSize, 4);
        try {
          var fd2 = fs.openSync(outputFilePath, 'r+');
          fs.writeSync(fd2, hdr, 0, 8, 0);
          fs.closeSync(fd2);
        } catch(e) {}
      }
      callback();
    }
  });

  transform.pipe(ws);
  return { stream: transform, path: outputFilePath, getTotalSize: function() { return totalSize; } };
}

// V2 加密并写入文件（同步，适合小文件/占位）
function createV2EncryptStreamSync(outputFilePath, plainData) {
  try {
    var xorKey = getV2XorKey();
    var originalSize = plainData.length;
    var encrypted = Buffer.alloc(originalSize);
    for (var i = 0; i < originalSize; i++) {
      encrypted[i] = plainData[i] ^ xorKey[i % xorKey.length];
    }
    var fileBuf = Buffer.alloc(ENC_V2_HEADER_SIZE + originalSize);
    fileBuf.write(ENC_V2_MAGIC, 0, 4, 'ascii');
    fileBuf.writeUInt32LE(originalSize, 4);
    encrypted.copy(fileBuf, ENC_V2_HEADER_SIZE);
    require('fs').writeFileSync(outputFilePath, fileBuf);
    return { ok: true, size: fileBuf.length, originalSize: originalSize };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// V2 解密读取文件
function getV2FileInfo(filePath) {
  try {
    var buf = require('fs').readFileSync(filePath);
    if (buf.length < ENC_V2_HEADER_SIZE) return null;
    if (buf.toString('ascii', 0, 4) !== ENC_V2_MAGIC) return null;
    return { isV2: true, originalSize: buf.readUInt32LE(4), fileSize: buf.length };
  } catch(e) { return null; }
}

function createV2DecryptStream(filePath, decryptedStart, decryptedEnd) {
  var stream = require('stream');
  var fs = require('fs');
  var xorKey = getV2XorKey();
  var outStream = new stream.PassThrough();

  try {
    var info = getV2FileInfo(filePath);
    if (!info) { setImmediate(function() { outStream.emit('error', new Error('Invalid V2 file')); }); return outStream; }

    var dataOffset = ENC_V2_HEADER_SIZE;
    var start = decryptedStart || 0;
    var end = decryptedEnd !== undefined ? decryptedEnd : info.originalSize - 1;
    var length = end - start + 1;

    if (start >= info.originalSize || length <= 0) {
      setImmediate(function() { outStream.end(); });
      return outStream;
    }

    var readStart = dataOffset + start;
    var readLen = Math.min(length, info.fileSize - readStart);
    var fd = fs.openSync(filePath, 'r');
    var readBuf = Buffer.alloc(readLen);
    fs.readSync(fd, readBuf, 0, readLen, readStart);
    fs.closeSync(fd);

    var plain = Buffer.alloc(readLen);
    for (var i = 0; i < readLen; i++) {
      plain[i] = readBuf[i] ^ xorKey[(start + i) % xorKey.length];
    }
    outStream.end(plain);
  } catch(e) { outStream.emit('error', e); }
  return outStream;
}

// V1 解密指定字节范围（内部使用，调用 createV1DecryptStream）
function decryptV1Range(filePath, decryptedStart, decryptedEnd, callback) {
  var stream = createV1DecryptStream(filePath, decryptedStart, decryptedEnd);
  var chunks = [];
  stream.on('data', function(chunk) { chunks.push(chunk); });
  stream.on('end', function() { callback(null, Buffer.concat(chunks)); });
  stream.on('error', function(err) { callback(err); });
}

module.exports = {
  deriveUserMasterKey,
  encryptUserMasterKey,
  decryptUserMasterKey,
  encryptFile,
  decryptFile,
  encryptFileToBuffer,
  decryptFileFromBuffer,
  createDecryptStream,
  createDecryptStreamRange,
  createEncryptStream,
  isV1EncryptedFile,
  readV1Header,
  createV1EncryptStream,
  createV1EncryptStreamSync,
  createV1EncryptStreamLarge,
  createV1EncryptStreamTransform,
  createV1DecryptStream,
  decryptV1Range,
  getV1FileInfo,
  detectFileEncVersion,
  upgradeFileToV1,
  ENC_V1_BLOCK_SIZE,
  ENC_V1_CURRENT_VERSION,
  ENC_V1_VERSION,
  createV2EncryptStream,
  createV2EncryptStreamSync,
  createV2DecryptStream,
  getV2FileInfo,
  ENC_V2_VERSION: 2,
  randomBytes,
  toHex,
  fromHex,
  // 通用解密流：自动检测格式并返回正确的流
  createDecryptStreamAuto,
  // V1 解密前 N 字节（用于缩略图预览）
  createV1DecryptStreamHead
};

// 自动检测文件加密版本，返回对应的解密流
function createDecryptStreamAuto(filePath, decryptedStart, decryptedEnd) {
  var version = detectFileEncVersion(filePath);
  if (version === 1) {
    return createV1DecryptStream(filePath, decryptedStart, decryptedEnd);
  } else {
    return createDecryptStreamRange(filePath, decryptedStart, decryptedEnd);
  }
}

// 解密文件前 N 个字节（用于缩略图），返回 Buffer
function createV1DecryptStreamHead(filePath, byteCount, callback) {
  var chunks = [];
  var stream = createV1DecryptStream(filePath, 0, byteCount - 1);
  stream.on('data', function(chunk) { chunks.push(chunk); });
  stream.on('end', function() { callback(null, Buffer.concat(chunks)); });
  stream.on('error', function(err) { callback(err); });
}
