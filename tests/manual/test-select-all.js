/**
 * 全选删除测试脚本 - 验证全选文件夹+文件删除
 */
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'd:\\tools\\fileservice\\chrome-win64\\chrome.exe';
const CHROMEDRIVER_PATH = 'd:\\tools\\fileservice\\chromedriver-win64\\chromedriver.exe';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'Test@123456';
const BASE_URL = 'http://localhost:88';
const screenshotsDir = path.join(__dirname, 'screenshots');

async function initDriver() {
    const options = new chrome.Options();
    options.setChromeBinaryPath(CHROME_PATH);
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    options.addArguments('--disable-gpu');
    options.addArguments('--window-size=1920,1080');
    options.addArguments('--disable-blink-features=AutomationControlled');
    const service = new chrome.ServiceBuilder(CHROMEDRIVER_PATH);
    const builder = new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .setChromeService(service);

    const driver = await builder.build();

    // 监听浏览器控制台日志
    await driver.executeScript(`
        window.__browserLogs = [];
        var originalLog = console.log;
        console.log = function() {
            var args = Array.prototype.slice.call(arguments);
            window.__browserLogs.push(args.map(function(a) {
                return typeof a === 'object' ? JSON.stringify(a) : String(a);
            }).join(' '));
            originalLog.apply(console, arguments);
        };
    `);

    return driver;
}

async function takeScreenshot(driver, name) {
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const p = path.join(screenshotsDir, `${name}.png`);
    try {
        fs.writeFileSync(p, await driver.takeScreenshot(), 'base64');
        console.log(`  [截图] ${name}.png`);
    } catch (e) { console.log(`  [截图失败] ${e.message}`); }
}

async function login(driver) {
    await driver.get(`${BASE_URL}/login.html`);
    await driver.sleep(1000);
    const result = await driver.executeAsyncScript(async function(cb) {
        const resp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: process.env.TEST_EMAIL || 'test@example.com', password: process.env.TEST_PASSWORD || 'Test@123456' }),
            credentials: 'include'
        });
        cb({ ok: resp.ok, code: (await resp.json()).code });
    });
    if (result.code === 0) {
        await driver.get(`${BASE_URL}/home.html`);
        await driver.sleep(2000);
        console.log('  [OK] 登录成功');
        return true;
    }
    console.log('  [失败] 登录失败');
    return false;
}

async function testSelectAll() {
    let driver;
    try {
        console.log('='.repeat(60));
        console.log('个人目录全选测试');
        console.log('='.repeat(60));

        driver = await initDriver();
        await driver.manage().setTimeouts({ implicit: 10000 });

        if (!await login(driver)) return;

        // 等待文件列表
        await driver.wait(until.elementLocated(By.id('file-container')), 10000);
        await driver.sleep(1000);

        // 先获取公共目录初始状态
        const pubState = await driver.executeScript(`return window.__fm.getState();`);
        console.log(`\n[公共目录初始状态]`);
        console.log(`  目录类型: ${pubState.dirType}`);
        console.log(`  是否管理员: ${pubState.isAdmin}`);
        console.log(`  文件数量: ${pubState.fileData.length}`);

        // 点击个人文件标签切换到个人目录
        console.log('\n[步骤1] 切换到个人文件目录');
        const personalBtn = await driver.findElement(By.id('nav-personal'));
        await personalBtn.click();
        await driver.sleep(2000);

        // 检查个人目录状态
        const personalState = await driver.executeScript(`return window.__fm.getState();`);
        console.log(`\n[个人目录状态]`);
        console.log(`  目录类型: ${personalState.dirType}`);
        console.log(`  是否管理员: ${personalState.isAdmin}`);
        console.log(`  文件数量: ${personalState.fileData.length}`);
        const dirs = personalState.fileData.filter(f => f.isDirectory);
        const files = personalState.fileData.filter(f => !f.isDirectory);
        console.log(`  文件夹数: ${dirs.length}`);
        console.log(`  文件数: ${files.length}`);
        if (dirs.length > 0) {
            console.log(`  文件夹列表: ${dirs.map(d => `${d.name}(id=${d.id})`).join(', ')}`);
        }
        if (files.length > 0) {
            console.log(`  文件列表: ${files.map(f => `${f.name}(id=${f.id})`).join(', ')}`);
        }

        await takeScreenshot(driver, '01-personal-files');

        // 点击选择按钮
        console.log('\n[步骤2] 点击选择按钮');
        await driver.findElement(By.id('select-btn')).click();
        await driver.sleep(500);

        // 点击全选按钮
        console.log('[步骤3] 点击全选按钮');
        await driver.findElement(By.id('select-all-btn')).click();
        await driver.sleep(1000);

        // 检查选中的状态
        const state1 = await driver.executeScript(`return window.__fm.getState();`);
        console.log(`\n[全选后个人目录状态]`);
        console.log(`  已选数量: ${state1.selectedFiles.length}`);
        console.log(`  已选ID列表: ${state1.selectedFiles.join(', ')}`);
        console.log(`  选择模式: ${state1.isSelectionMode}`);

        const initDirs = dirs.map(d => String(d.id));
        const initFiles = files.map(f => String(f.id));
        const selectedDirs = state1.selectedFiles.filter(id => initDirs.includes(String(id)));
        const selectedFiles = state1.selectedFiles.filter(id => initFiles.includes(String(id)));
        console.log(`  选中的文件夹数: ${selectedDirs.length}`);
        console.log(`  选中的文件数: ${selectedFiles.length}`);

        if (state1.selectedFiles.length === 0) {
            console.log('\n  [错误] 全选后没有选中任何项目！');
        } else {
            console.log('\n  [OK] 全选成功');
        }

        await takeScreenshot(driver, '02-personal-selected');

        // 尝试点击删除按钮
        if (state1.selectedFiles.length > 0) {
            console.log('\n[步骤4] 点击删除按钮前检查 state');

            // 在页面中执行检查
            const debugInfo = await driver.executeScript(`
                var state = window.__fm.getState();
                var selectedFiles = state.selectedFiles;
                var fileData = state.fileData;

                var results = selectedFiles.map(function(id) {
                    var found = fileData.find(function(f) { return String(f.id) === String(id); });
                    return {
                        searchId: id,
                        searchIdType: typeof id,
                        fileId: found ? found.id : null,
                        fileIdType: found ? typeof found.id : null,
                        found: !!found
                    };
                });

                return {
                    selectedFiles: selectedFiles,
                    fileDataIds: fileData.map(function(f) { return String(f.id); }),
                    results: results
                };
            `);

            console.log(`\n  [Debug] selectedFiles: ${JSON.stringify(debugInfo.selectedFiles)}`);
            console.log(`  [Debug] fileData IDs: ${JSON.stringify(debugInfo.fileDataIds)}`);
            console.log(`  [Debug] 查找结果:`);
            debugInfo.results.forEach(function(r) {
                console.log(`    searchId="${r.searchId}"(type=${r.searchIdType}) -> found=${r.found}, fileId=${r.fileId}(type=${r.fileIdType})`);
            });

            // 监听 confirm 对话框
            await driver.executeScript(`
                window.__confirmResult = null;
                window.__originalConfirm = window.confirm;
                window.confirm = function(msg) {
                    window.__confirmResult = msg;
                    console.log('[Confirm拦截]', msg);
                    return false;
                };
            `);

            await driver.findElement(By.id('sel-delete-btn')).click();
            await driver.sleep(1000);

            // 检查 confirm 是否被调用
            const confirmMsg = await driver.executeScript(`return window.__confirmResult;`);
            if (confirmMsg) {
                console.log(`\n  [Confirm提示] ${confirmMsg}`);
                console.log('  [OK] 删除确认对话框已弹出');
            } else {
                console.log('\n  [错误] 删除确认对话框未弹出');
            }

            // 获取浏览器控制台日志
            const browserLogs = await driver.executeScript(`return window.__browserLogs || [];`);
            if (browserLogs.length > 0) {
                console.log('\n  [浏览器控制台日志]');
                browserLogs.forEach(function(log) {
                    if (log.includes('deleteSelectedFiles')) {
                        console.log(`    ${log}`);
                    }
                });
            }

            // 检查是否有 toast 提示
            const toast = await driver.executeScript(`
                var toast = document.querySelector('.toast');
                return toast ? toast.textContent : null;
            `);
            if (toast) {
                console.log(`  [Toast] ${toast}`);
            }
        }

        await takeScreenshot(driver, '03-personal-delete');

        console.log('\n' + '='.repeat(60));
        console.log('测试完成');
        console.log('='.repeat(60));

    } catch (e) {
        console.error('\n[错误]', e.message);
        if (driver) await takeScreenshot(driver, 'error');
    } finally {
        if (driver) {
            await driver.sleep(3000);
            await driver.quit();
        }
    }
}

testSelectAll();
