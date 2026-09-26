# 安全加固手动验证片段（1.2.2 / 1.2.3）

配合 `tests/specs/11-security-regression.spec.js`（自动化，37 条）使用。
自动化用例断言的是"修复后必须拒绝什么"；这里给的是**可以贴到终端里直接看输出**的最小片段，
用于在没有 Playwright 的环境（比如线上灰度机器）上快速复核。

上半部分（FMS-01/03/04/05/06/08/09）是 **1.2.2** 那批；
下半部分「1.2.3 追加」是本轮 app-log / zip-slip / SSRF / 日志注入 / 随机源 / 路径泄露 那批。

前置：把下面两个值填成你自己的。
浏览器登录后按 F12 → Application → Cookies 复制会话 cookie；CSRF 令牌任意一次请求的
响应头 `X-CSRF-Token` 里就有（服务端在**每个**响应上都回显当前会话的令牌，不必去翻 localStorage）。

```bash
BASE=http://127.0.0.1:88
COOKIE='fileservice.sid=s%3A替换成你自己的'
CSRF=$(curl -s -D- -o/dev/null -H "Cookie: $COOKIE" $BASE/api/auth/me | grep -i '^x-csrf-token:' | tr -d '\r' | awk '{print $2}')
echo "CSRF=$CSRF"
```

---

## FMS-03 路径穿越 —— 必须拿不到公共目录之外的文件

```bash
# 期望：非 200，且响应体里没有 SESSION_SECRET / SYSTEM_MASTER_KEY
for u in '/api/files/stream/..%2F..%2F.env' \
         '/api/files/stream/1?public_path=..%2F..%2F.env' \
         '/api/files/thumb/..%2F..%2F.env' \
         '/api/files/video-preview/..%2F..%2F.env'; do
  echo "--- $u"
  curl -s -o- -w '\n[HTTP %{http_code}]\n' -H "Cookie: $COOKIE" "$BASE$u" | grep -E 'SESSION_SECRET|SYSTEM_MASTER_KEY|\[HTTP' || echo '[HTTP 无匹配]'
done
```

> 修复前这四个里有三个**完全没有校验**，会直接把 `.env` 吐出来。

## FMS-04 批量分享 —— 不能引用他人文件 id

```bash
# 期望：code != 0（修复前会返回 code=0 并建立一条指向他人文件的分享）
curl -s -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"target_type":"mixed","target_ids":[<自己的目录id>,<别人的目录id>],"expires_days":1}' \
  $BASE/api/share
```

## FMS-05 公共分享 —— 不能读到自身范围之外

```bash
SHARE=<你的 public 分享 hash>
# 期望：拿不到 OUTSIDE / PREFIX_SIBLING / 他人公共目录里的内容
curl -s -H "Cookie: $COOKIE" "$BASE/api/share/download/$SHARE/..%2F..%2F.env" | head -c 200
curl -s -H "Cookie: $COOKIE" "$BASE/api/share/content/$SHARE?sub_dir=..%2F..%2Fetc"
```

## FMS-08 提取码 —— 不带码读内容必须被拒

```bash
# SHARE_CODE = 设了提取码的分享
curl -s -H "Cookie: $COOKIE" "$BASE/api/share/content/$SHARE_CODE"
# 期望：{"code":401,...}   前端 public/share.html 正是靠 code===401 弹提取码输入框

curl -s -H "Cookie: $COOKIE" "$BASE/api/share/content/$SHARE_CODE?extraction_code=1234"
# 期望：code=0（带对码仍然可用）
```

## FMS-06 WebDAV —— 新链接默认要认证

```bash
# 不传 require_auth：期望 data.require_auth 为真，且匿名打开是 401
TOK=$(curl -s -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"target_path":"<公开目录名>","target_name":"t","target_type":"public","expires_days":1}' \
  $BASE/api/webdav/links | python -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')
curl -s -o/dev/null -w '匿名访问新建链接 → HTTP %{http_code}\n' $BASE/webdav/$TOK   # 期望 401

# 显式 require_auth:false：存量匿名链接行为不变，期望非 401
```

## FMS-01 扫码登录接管 —— 全程零凭据，最后一步必须失效

这是本轮最关键的一条。修复前：**不需要任何账号密码**，三步就能把会话变成管理员。

```bash
# ① 免鉴权生成二维码（本来就不需要登录）
GEN=$(curl -s -c /tmp/jar.txt $BASE/api/auth/qr-login/generate)
TOKEN=$(echo "$GEN" | python -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')

# ② 攻击者用自己的 cookie 去轮询状态
curl -s -b /tmp/jar.txt "$BASE/api/auth/qr-login/status?token=$TOKEN"
# 期望：loggedIn 恒为 false；token 不属于本会话时直接报错
# 修复前：WS 里冒充受害者扫码+授权后，这一步会返回 loggedIn:true

# ③ 这个会话到底是谁？—— 决定性的那一行
curl -s -b /tmp/jar.txt $BASE/api/auth/me
# 期望：code != 0（未登录）
# 修复前：uid=1 is_admin=1（管理员）
```

WS 侧的伪造（`{type:'auth',userId:1}` 与 `qr_login_scan`)用 Node 跑更直观：

```bash
node -e "
const WS=require('ws');
const ws=new WS('ws://127.0.0.1:88/ws');
ws.on('open',()=>{ws.send(JSON.stringify({type:'auth',userId:1}));});
ws.on('message',d=>{console.log('←',d.toString());ws.terminate();});
setTimeout(()=>process.exit(0),2500);
"
# 期望：{"type":"auth_error","message":"未登录"}
# 修复前：{"type":"auth_ok","userId":1} —— 无会话即可订阅他人推送
```

## FMS-09 确认页 —— 显示的是「发起登录的设备 IP」

```bash
curl -s -H "Cookie: $COOKIE" "$BASE/api/auth/qr-login/confirm?token=$TOKEN" \
  | python -c 'import sys,re; h=sys.stdin.read(); t=re.sub(r"<[^>]+>"," ",h); print(re.sub(r"\s+"," ",t)[:400])'
# 期望：文案为「发起登录的设备 IP」并带风险提示
# 修复前：显示「登录 IP」，填的却是手机自己的 XFF —— 受害者看到的是自己的 IP，提醒形同虚设
```

---

## 顺带确认的存量兼容（改坏了就是线上事故）

| 场景 | 期望 |
|---|---|
| 完整扫码登录（PC generate → 手机 authorize → PC swap） | 正常拿到会话 |
| 目录分享浏览**自己的**子目录 | 正常列出 |
| 无提取码的公开分享 | 正常打开与下载 |
| 手机端扫码授权（`app.js` 走 `apiPost`） | 不出现 403 |
| 存量 WebDAV 链接（数据库里 `require_auth=0`） | 仍可匿名访问 |

---
---

# 1.2.3 追加：app-log / zip-slip / SSRF / 日志注入 / 随机源 / 路径泄露

> **改前 vs 改后已实测**（同一个 spec、同一批夹具，只换被测进程）：
> 改前 **10 条失败**、改后 **37 条全过**。下面每条都给了"改前是什么样"，
> 照着复跑就能自己分辨"修好了"还是"用例本来就不成立"。

## FMS-10 App 日志上报 —— 匿名必须被拒

```bash
# 期望：{"code":401,...}     ← 注意是 code=401，不是 HTTP 401
# 这个服务的 utils.json() 不设置 HTTP 状态码，一律 HTTP 200 + body.code，断言要看 code
curl -s -X POST $BASE/api/auth/app-log -H 'Content-Type: application/json' \
  -d '{"logs":[{"level":"info","tag":"x","message":"anon"}]}'
echo
# 改前：{"code":0,"message":"ok"} —— 匿名可写，且无条数/长度上限（10MB 请求体全量 forEach 入库）

# 带上会话与 CSRF 后应恢复可用
curl -s -X POST $BASE/api/auth/app-log -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -H 'X-Device-Id: manual-check' \
  -d '{"message":"from manual check"}'
# 期望：{"code":0,...,"data":{"written":1,"failed":0}}
```

单次上报上限 50 条（超出截断并如实告知，不再静默丢弃）：

```bash
node -e "
const body=JSON.stringify({logs:Array.from({length:600},(_,i)=>({level:'info',tag:'t',message:'m'+i}))});
fetch('$BASE/api/auth/app-log',{method:'POST',headers:{'Cookie':process.env.C,'X-CSRF-Token':process.env.T,'Content-Type':'application/json','X-Device-Id':'manual-check'},body})
  .then(r=>r.json()).then(j=>console.log('written='+j.data.written,'\nmsg='+j.message));
" C="$COOKIE" T="$CSRF"
# 期望：written=50，msg 里带「已截断」
# 改前：written 无此字段（全部 600 条入库）
```

## FMS-17 调试路由 —— 不得泄露服务器绝对路径

```bash
curl -s -o- -w '\n[HTTP %{http_code}]\n' $BASE/api/admin/version/test
# 期望：[HTTP 404]（整条路由已删除）
# 改前：[HTTP 200] + {"code":0,...,"dir":"C:\\nodjs\\file_server\\files\\app"}
```

## FMS-11 升级包 zip-slip —— 恶意条目不得写到目标目录之外

这条**没法用 HTTP 直接测**（`extractRelease` 是内部函数），用 Node 调：

```bash
node -e "
const AdmZip=require('adm-zip'),fs=require('fs'),os=require('os'),path=require('path');
const up=require('./lib/upgrade');
const base=path.join(os.tmpdir(),'fms-slip-check'),dir=path.join(base,'extract');
fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
const zip=new AdmZip();zip.addFile('good.txt',Buffer.from('ok'));
zip.getEntries()[0].entryName='good.txt';
zip.addFile('../../pwned.txt',Buffer.from('x'));
const all=zip.getEntries();all[all.length-1].entryName='../../pwned.txt';   // addFile 会净化，写盘前改回原样
const zp=path.join(base,'evil.zip');zip.writeZip(zp);
up.extractRelease(zp,dir).then(n=>{
  console.log('解出',n,'个文件');
  console.log('目标目录内 good.txt :',fs.existsSync(path.join(dir,'good.txt')));
  console.log('目标目录外 pwned.txt:',fs.existsSync(path.join(base,'..','pwned.txt')),'← 必须为 false');
  fs.rmSync(path.join(base,'..','pwned.txt'),{force:true});fs.rmSync(base,{recursive:true,force:true});
});
"
# 期望：解出 1 个文件；目标目录外 pwned.txt = false；日志里有「拒绝越界条目: ../../pwned.txt」
# 改前：解出 2 个文件，pwned.txt 真的落到了目标目录的上一级（实测复现）
```

## FMS-11 同族：升级包的下载目标路径同样会越界（本轮顺手修）

`lib/upgrade.js` 里同一个文件还有一处同族写法：
`startAutoDownload()` 的 `destName` 来自远端升级清单或管理端传入的 `version`，
`path.join(destDir, destName)` 同样不带包含性校验。管理端那条路径是可达的：

```bash
# 需要管理员会话。version 会被拼成 'FMS-Service-v' + version + '.apk' 当作下载目标文件名
curl -s -X POST $BASE/api/version/app/download -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/x.apk","version":"../../../../pwn"}'
# 改前：destName = 'FMS-Service-v../../../../pwn.apk' → path.join 归一化后写到 files/app 之外
# 改后：resolveWithin 判为越界 → 退回默认名 FMS-Service-v../../../../pwn.apk（仍越界）
#       → 再判一次 → 放弃下载并 resetDownloadState（失败关闭），日志留一条 error
```

影响面比 zip-slip 小（`requireAdmin` 之后才可达），但它和 zip-slip 是同一个缺陷族、
同一个文件，所以一并收敛；没有单独编号。

## FMS-12/13 离线下载 SSRF

目标端口刻意避开服务自身的端口，用 `18898`（未放行）与 `18899`（允许清单内，需自建）。

```bash
# ① IP 字面量形态：创建阶段就该被拒（这是"lookup 钩子漏掉字面量"的那条必须补的前置校验）
for u in 'http://127.0.0.1:18898/api/version/latest' 'http://[::1]:18898/' \
         'http://[::ffff:7f00:1]:18898/' 'http://169.254.169.254/' 'http://10.0.0.1/'; do
  printf '%-45s -> ' "$u"
  curl -s -X POST $BASE/api/offline/create -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" \
    -H 'Content-Type: application/json' -d "{\"url\":\"$u\"}" | head -c 120; echo
done
# 期望：全部 code != 0，message 含「不允许访问」
# 改前：code=0 建任务成功，随后真的去连 127.0.0.1:18898

# ② 域名形态：靠 lookup 钩子在连接期拦（创建时不解析，避免阻塞）
#    127.0.0.1.nip.io 之类会解析到环回；若环境无外网 DNS，这条改用 hosts 造一个环回域名
```

**重定向的每一跳都要重新校验**（FMS-13）—— 自建一个 302 服务，让它跳到**未放行**的地址：

```bash
node -e "
const http=require('http');
http.createServer((q,s)=>{s.writeHead(302,{Location:'http://127.0.0.1:18898/api/version/latest'});s.end();})
  .listen(18899,()=>console.log('302 fixture on 18899'));
" &
# 服务端用 OFFLINE_DOWNLOAD_ALLOWED_HOSTS=127.0.0.1:18899 启动，然后：
curl -s -X POST $BASE/api/offline/create -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:18899/"}'
# 再把返回的 id 拿去 POST /api/offline/<id>/start，然后 GET /api/offline/<id> 看 error
# 期望：status=failed，error 含「不允许访问」（第一跳放行、第二跳被拒）
# 改前：status=failed，但 error 是「请求失败: connect ECONNREFUSED 127.0.0.1:18898」
#       —— 注意这个区别：改前的 failed 是"连不上"，不是"被拦住"，它确实把请求发出去了
```

> ⚠️ **允许清单必须支持 `host:port` 精确匹配**，不能只比 host。
> 否则放行 `127.0.0.1:18899` 就等于把整个 `127.0.0.1` 放开了，上面这条根本测不出来。
> 配置项：`OFFLINE_DOWNLOAD_ALLOWED_HOSTS`（逗号分隔，空 = 全部拦）。
> 内网部署若需要"从本站地址下载"，把服务自身的 `host:port` 显式写进去即可。

## FMS-14 操作日志 order 注入

```bash
# 必须先取 DESC 基线，再逐行比对 —— 只断言"不报 500"是测不出来的
curl -s "$BASE/api/logs/actions?limit=5&order=DESC" -H "Cookie: $COOKIE" \
  | python -c 'import sys,json;d=json.load(sys.stdin)["data"];print("基线 DESC:",[r["id"] for r in d["data"]])'
for p in 'id%20DESC%23' 'id%3B%20DROP%20TABLE%20users' '(SELECT%201)' 'RANDOM()'; do
  printf '%-26s -> ' "$p"
  curl -s "$BASE/api/logs/actions?limit=5&order=$p" -H "Cookie: $COOKIE" \
    | python -c 'import sys,json;d=json.load(sys.stdin);print("code=%s"%d["code"],[r["id"] for r in d["data"]["data"]])'
done
# 期望：每个载荷的结果集与 DESC 基线**完全一致**（被降级成 DESC）
# 改前：基线是 [98,97,96,95,94]，载荷全部返回 [] —— 语句报语法错，
#       lib/db.js 的 query() 把异常吞了返回空数组，HTTP 上照样是 200/code=0，
#       所以"不报 500"这条断言在改前也是通过的，必须靠比对结果集才能复现
```

## FMS-15 分享码 / WebDAV token 的随机源

```bash
# 形状断言（长度 + 字符集）—— 这一条只能防回归，证明不了"真的用了 CSPRNG"
curl -s -X POST $BASE/api/share -H "Cookie: $COOKIE" -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -d '{"target_type":"file","target_ids":[<自己的文件id>],"expires_days":1}' \
  | python -c 'import sys,json,re;d=json.load(sys.stdin)["data"];h=d["share_hash"];
print("share_hash=%r len=%d 落在字符集内=%s"%(h,len(h),bool(re.fullmatch(r"[A-HJ-NP-Za-km-z2-9]+",h))))'
# 期望：len=8，True    改前：长度也对（Math.random 也生成 8 位），所以这条**本来就是防回归不是复现**
```

> 真正"换成 CSPRNG"这件事**无法由黑盒测试证明**：`Math.random()` 与 `crypto.randomBytes()`
> 产出的字符串在长度和字符集上完全一样。证明只能靠代码审查 ——
> 看 `lib/db.js` 里 `randomString()` 用的是 `crypto.randomBytes` + 拒绝采样，
> 以及三处调用点（分享码 8 / 提取码 4 / WebDAV token 32）。这里如实标注，不假装测到了。

## 同族路径校验 —— 前缀兄弟目录不得绕过

```bash
# WebDAV MOVE 的 Destination 指向兄弟目录：
# 旧写法用 indexOf(baseDir) !== 0 判包含性，缺 path.sep，
# 所以 /dav/<base>_evil/ 能通过校验（请求随后因为源文件不存在返回 404，
# 但"通过校验"本身就是洞：换个真实存在的源就是一次跨目录移动）
curl -s -o/dev/null -w 'MOVE 到兄弟目录 → HTTP %{http_code}\n' -X MOVE \
  "$BASE/webdav/$TOK/<真实存在的文件>" -H "Destination: $BASE/webdav/$TOK/../<base>_evil/pwn.txt"
# 期望：403    改前：404

# 反向回归：公共 WebDAV 根目录必须仍能 PROPFIND（根路径是空值，别被新校验误伤成 403）
curl -s -o/dev/null -w '根 PROPFIND → HTTP %{http_code}\n' -X PROPFIND "$BASE/webdav/$TOK"
# 期望：207
```

---

## 1.2.3 的存量兼容（改坏了就是线上事故）

| 场景 | 期望 |
|---|---|
| 已登录的 App 端继续上报日志（带会话 + CSRF） | 正常，`code:0` |
| 管理端读 App 日志（`GET /api/auth/admin/app-logs`） | 正常返回（**修复前这个接口一直 500**，见下） |
| 升级包解出正常的目录结构（无 `..` 条目） | 与之前完全一致 |
| 公共目录里的正常子目录浏览 / 新建 / 重命名 / 删除 | 与之前完全一致 |
| 根目录分享的 WebDAV 链接（`target_path` 为空） | 仍能 PROPFIND（空值特判的回归点） |
| 存量分享码 / WebDAV token | 不受影响（字符集与长度都没变） |
| 公网 URL 的离线下载 | 仍能下载（**需外网，手工确认**） |

> **顺带修掉的一个存量 bug**：`GET /api/auth/admin/app-logs` 原先读 `req.user`，
> 而那个字段只有各路由文件自己的 `requireAdmin` 中间件才会赋值，`routes/auth.js` 里没有这个中间件，
> 所以该接口一直是 `TypeError: Cannot read properties of undefined (reading 'is_admin')` → 500，
> 管理端根本读不出 App 日志。现在改为从会话取 userId 再查库判定。
