#!/bin/bash
# FMS 文件管理系统 - Linux 停止脚本

echo "正在停止 FMS 文件管理系统..."

# 方式1: 通过 launcher 子进程查找
LAUNCHER_PID=$(pgrep -f "node launcher.js" 2>/dev/null)
if [ -n "$LAUNCHER_PID" ]; then
    echo "找到 Launcher 进程 (PID: $LAUNCHER_PID)，发送 SIGTERM..."
    kill -TERM $LAUNCHER_PID 2>/dev/null
    sleep 2
fi

# 方式2: 查找所有 node server.js 进程
SERVER_PIDS=$(pgrep -f "node.*server.js" 2>/dev/null)
if [ -n "$SERVER_PIDS" ]; then
    echo "找到 Server 进程: $SERVER_PIDS"
    for pid in $SERVER_PIDS; do
        kill -TERM $pid 2>/dev/null
    done
    sleep 1
fi

# 方式3: 通过端口查找
if command -v lsof &> /dev/null; then
    PORT_PIDS=$(lsof -ti:88 2>/dev/null)
    if [ -n "$PORT_PIDS" ]; then
        echo "端口 88 仍被占用 (PID: $PORT_PIDS)，强制终止..."
        for pid in $PORT_PIDS; do
            kill -KILL $pid 2>/dev/null
        done
    fi
elif command -v fuser &> /dev/null; then
    fuser -k 88/tcp 2>/dev/null && echo "端口 88 已释放"
fi

echo "FMS 已停止"
