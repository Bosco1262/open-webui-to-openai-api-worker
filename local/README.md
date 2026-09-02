# 本地认证获取端

用于在本地获取 Open WebUI 的登录凭证（`session.json`），随后将其粘贴到 Worker 管理界面导入。

## 安装

需要 Python 3.9+：

```bash
cd local
pip install -r requirements.txt
playwright install chromium
```

## 使用

```bash
python login.py --base-url https://your-open-webui.example.com
```

运行后：

1. 会自动打开一个 Chromium 浏览器窗口；
2. 在窗口中手动完成 Open WebUI 登录（若跳转到校园网/公司网认证页，请先完成网络认证）；
3. 脚本后台捕获登录凭证，并**向真实上游做一次鉴权验证**（防止误抓过期 Token 或门户重定向产生的无效凭证）；
4. 验证通过后自动关闭浏览器，将 `session.json` 保存到当前目录，并在终端**完整输出 JSON 内容**：

```
==============================================================
  请复制下方全部 JSON 内容，粘贴到 Worker 管理界面的『导入 Session』中。
==============================================================
{
  "authorization": "Bearer eyJhbGciOiJIUzI1NiIs...",
  "cookie": "token=eyJ...; oauth_id_token=...; oauth_session_id=...",
  "user_agent": "Mozilla/5.0 ...",
  "captured_at": 1788268041.75,
  "base_url": "https://your-open-webui.example.com"
}
==============================================================
```

5. 复制以上 JSON 内容 → 打开 Worker 管理界面 `/admin` → **导入 Session** 卡片 → 粘贴并导入。

## 常用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--base-url` | 环境变量 `OPEN_WEBUI_BASE_URL` | Open WebUI 地址，需含 `http(s)://` 前缀 |
| `--timeout` | `600` | 最长等待登录的秒数 |
| `--quiet-period` | `6` | 捕获凭证后的静默观察期（秒） |
| `--headless` | `false` | 以无头模式启动浏览器 |
| `--output` | `session.json` | 输出文件路径 |
| `--insecure` | `false` | 跳过上游 HTTPS 证书校验（慎用） |

```bash
python login.py --base-url https://chat.example.com --timeout 900
python login.py --base-url https://chat.example.com --output my-session.json
```

## 说明

- 凭证通过真实上游鉴权后才算登录成功，避免把"过期 Token 探测请求"或"校园网未认证跳转"误存为有效凭证。
- `session.json` 已加入 `.gitignore`，请勿提交到版本库。
- 当 Open WebUI 的 JWT 过期（通常数天，取决于服务端 `JWT_EXPIRES_IN`），重新运行本工具刷新即可。
