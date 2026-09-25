# 安全加固手动验证片段（1.2.2）

配合 `tests/specs/11-security-regression.spec.js`（自动化，20 条）使用。
自动化用例断言的是"修复后必须拒绝什么"；这里给的是**可以贴到终端里直接看输出**的最小片段，
用于在没有 Playwright 的环境（比如线上灰度机器）上快速复核。

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
