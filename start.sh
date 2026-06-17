#!/bin/bash
# FMS 文件管理系统 - Linux 启动脚本
# SSL 配置请在 .env 中设置 SSL_ENABLED=true

cd "$(dirname "$0")"

# 检查 node 是否安装
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js"
    exit 1
fi

# 检查 Redis 是否运行
if command -v redis-cli &> /dev/null; then
    if ! redis-cli ping &> /dev/null; then
        echo "警告: Redis 未运行，请先启动 Redis 服务"
        echo "  Ubuntu/Debian: sudo systemctl start redis-server"
        echo "  CentOS/RHEL:   sudo systemctl start redis"
    fi
fi

echo "启动 FMS 文件管理系统..."
node launcher.js
