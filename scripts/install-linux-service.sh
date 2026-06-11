#!/usr/bin/env bash
# ============================================================
# FMS (FileService) - Linux systemd 服务安装脚本
# 使用原生 systemd，无需第三方工具
# 需要 root 或 sudo 权限
# ============================================================

set -euo pipefail

SERVICE_NAME="fms-fileservice"
DISPLAY_NAME="FMS 文件管理系统"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || echo '')"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}.service"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[信息]${NC} $*"; }
warn()  { echo -e "${YELLOW}[警告]${NC} $*"; }
error() { echo -e "${RED}[错误]${NC} $*"; }

# ==================== 检查权限 ====================
if [[ $EUID -ne 0 ]]; then
    error "此脚本需要 root 权限，请使用 sudo 运行"
    echo "  sudo bash scripts/install-linux-service.sh"
    exit 1
fi

# ==================== 检查依赖 ====================
if [[ -z "$NODE_BIN" ]]; then
    error "未找到 Node.js，请先安装"
    echo "  推荐使用 NodeSource: https://github.com/nodesource/distributions"
    echo "  或使用 nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    exit 1
fi

info "Node.js 路径: $NODE_BIN"
info "Node.js 版本: $(node --version)"
info "安装目录: $INSTALL_DIR"

# ==================== 创建运行用户（如不存在） ====================
SERVICE_USER="fms"

if ! id -u "$SERVICE_USER" &>/dev/null; then
    info "创建系统用户: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
    info "用户 $SERVICE_USER 已存在"
fi

# ==================== 安装 npm 依赖 ====================
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
    info "正在安装 npm 依赖..."
    cd "$INSTALL_DIR"
    npm install --production
fi

# ==================== 检查 .env 文件 ====================
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    warn "未找到 .env 文件，将使用默认配置"
    warn "建议先运行: cp .env.example .env 并修改配置"
fi

# ==================== 设置权限 ====================
info "设置目录权限..."
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"

# 确保 data 和 files 目录可写
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/files/download" "$INSTALL_DIR/files/userdata" "$INSTALL_DIR/files/tmp"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR/data" "$INSTALL_DIR/files"

# ==================== 创建 systemd 服务文件 ====================
info "创建 systemd 服务文件..."

cat > "$SERVICE_FILE" << SYSTEMDEOF
[Unit]
Description=$DISPLAY_NAME - 端到端加密文件服务
Documentation=https://github.com/Antruly/FMS-Service
After=network-online.target redis.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN server.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=30
StartLimitInterval=300
StartLimitBurst=5

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$INSTALL_DIR/data $INSTALL_DIR/files $INSTALL_DIR/public $INSTALL_DIR/routes $INSTALL_DIR/lib
ReadOnlyPaths=$INSTALL_DIR

# 资源限制
LimitNOFILE=65536
MemoryHigh=2G
MemoryMax=3G
CPUQuota=200%

# 环境变量
Environment=NODE_ENV=production
Environment=PORT=88

[Install]
WantedBy=multi-user.target
SYSTEMDEOF

# ==================== 重载并启动服务 ====================
info "重载 systemd 配置..."
systemctl daemon-reload

info "启用开机自启..."
systemctl enable "$SERVICE_NAME"

info "启动服务..."
systemctl start "$SERVICE_NAME"

# 等待服务启动
sleep 3

# ==================== 检查状态 ====================
echo ""
echo "============================================================"
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo -e "  ${GREEN}安装成功！服务运行中${NC}"
else
    echo -e "  ${RED}服务启动失败，请检查日志${NC}"
    echo "  journalctl -u $SERVICE_NAME -n 50"
fi
echo "============================================================"
echo "  服务名称: $SERVICE_NAME"
echo "  安装目录: $INSTALL_DIR"
echo "  运行用户: $SERVICE_USER"
echo ""
echo "  常用命令："
echo "    启动服务: sudo systemctl start $SERVICE_NAME"
echo "    停止服务: sudo systemctl stop $SERVICE_NAME"
echo "    重启服务: sudo systemctl restart $SERVICE_NAME"
echo "    查看状态: sudo systemctl status $SERVICE_NAME"
echo "    查看日志: sudo journalctl -u $SERVICE_NAME -f"
echo "    禁用自启: sudo systemctl disable $SERVICE_NAME"
echo ""
echo "  卸载服务:"
echo "    sudo systemctl stop $SERVICE_NAME"
echo "    sudo systemctl disable $SERVICE_NAME"
echo "    sudo rm $SERVICE_FILE"
echo "    sudo systemctl daemon-reload"
echo "============================================================"
