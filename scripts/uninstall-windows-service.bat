@echo off
chcp 65001 >nul
setlocal

:: ============================================================
:: FMS (FileService) - Windows 服务卸载脚本
:: 使用 Windows 内置 sc 命令，无需第三方工具
:: 需要以管理员权限运行
:: ============================================================

set "SERVICE_NAME=FMSFileService"

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 此脚本需要管理员权限，请右键以管理员身份运行！
    pause
    exit /b 1
)

:: 检查服务是否存在
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% neq 0 (
    echo [信息] 服务 "%SERVICE_NAME%" 不存在，无需卸载
    pause
    exit /b 0
)

echo [信息] 正在停止服务 %SERVICE_NAME%...
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 3 >nul

echo [信息] 正在删除服务 %SERVICE_NAME%...
sc delete "%SERVICE_NAME%"

if %errorlevel% equ 0 (
    echo ============================================================
    echo   卸载成功！服务 "%SERVICE_NAME%" 已完全移除
    echo ============================================================
) else (
    echo [错误] 服务删除失败，请检查是否具有管理员权限
)

pause
