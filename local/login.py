"""
open-webui-to-openai-api — Local credential capture tool
open-webui-to-openai-api —— 本地认证获取端

Open a browser for the user to complete the Open WebUI login manually, capture
the post-login identity credentials (Authorization / Cookie / User-Agent), and
perform a real authentication check against the upstream (to avoid capturing
expired tokens or invalid credentials produced by campus portal redirects).
After verification passes:
打开浏览器让用户手动完成 Open WebUI 登录，捕获登录后的身份凭证（Authorization /
Cookie / User-Agent），向真实上游做一次鉴权验证（防止误抓过期 Token 或被校园网等
门户重定向产生的无效凭证），验证通过后：

1. Save to the local session.json;
1. 保存到本地 session.json；
2. Print the full session.json content in the terminal for copy-paste into the
   Worker admin console.
2. 在终端完整输出 session.json 内容，供复制粘贴到 Worker 管理界面导入。

Usage:
用法：
    python login.py --base-url https://chat.example.com
    python login.py --base-url https://chat.example.com --timeout 900 --headless
    python login.py --base-url https://chat.example.com --lang en

Language priority: --lang flag > system language > English.
语言优先级：--lang 参数 > 系统语言 > 默认英语。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

# Playwright is a required dependency (this tool only does login capture)
# Playwright 是必需依赖（本工具只做登录捕获）
from playwright.async_api import async_playwright

# User-facing message localization (same design as the reference project)
# 用户可见消息的本地化（与参考项目同一套设计）
import lang

logger = logging.getLogger("webui-login")

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# Upstream endpoints only called by the frontend after a successful login,
# used to judge "the user is really logged in"
# 只有登录成功后前端才会去调用的上游接口，用于判定"确实登录了"
AUTHED_PATH_HINTS = (
    "/api/models",
    "/api/chat/completions",
    "/api/chats",
    "/api/v1/",
    "/api/users",
    "/api/folders",
    "/api/knowledge",
)

# Candidate upstream prefixes (Open WebUI >= 0.6 uses /api/v1, legacy uses /api)
# 上游候选前缀（Open WebUI >= 0.6 为 /api/v1，老版本为 /api）
PREFIX_CANDIDATES = ("/api/v1", "/api")


class SessionError(RuntimeError):
    """Error raised during the login process. / 登录过程中的错误。"""


@dataclass
class Session:
    # Captured identity credentials, mirrored from session.json
    # 捕获的身份凭证，与 session.json 一一对应
    authorization: str = ""
    cookie: str = ""
    user_agent: str = ""
    captured_at: float = 0.0
    base_url: str = ""

    def is_usable(self) -> bool:
        # Usable if at least one of Authorization / Cookie is non-empty
        # Authorization / Cookie 至少一项非空即视为可用
        return bool(self.authorization.strip() or self.cookie.strip())

    def to_headers(self) -> Dict[str, str]:
        # Request headers that carry the credentials to the upstream
        # 携带凭证发往上游的请求头
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": self.user_agent or DEFAULT_USER_AGENT,
        }
        if self.authorization:
            headers["Authorization"] = self.authorization
        if self.cookie:
            headers["Cookie"] = self.cookie
        return headers

    def describe(self) -> str:
        """Redacted credential summary, safe for logs/terminal. / 脱敏后的凭证摘要，可安全写入日志/终端。"""
        parts = []
        if self.authorization:
            parts.append(f"token={self.authorization[:16]}…(len={len(self.authorization)})")
        if self.cookie:
            parts.append(f"cookie(len={len(self.cookie)})")
        age = ""
        if self.captured_at:
            age = f" (age={(time.time() - self.captured_at) / 86400:.1f}d)"
        return ", ".join(parts) + age if parts else lang.t("describe_empty")

    def to_dict(self) -> Dict[str, Any]:
        # Serialize into the session.json structure
        # 序列化为 session.json 的结构
        return asdict(self)


def _ci_getter(raw: Dict[str, Any]):
    """Case-insensitive getter. / 大小写不敏感的取值函数。"""
    lowered = {str(k).lower(): v for k, v in raw.items()}

    def get(key: str) -> Any:
        return lowered.get(key.lower())

    return get


def session_from_dict(raw: Dict[str, Any]) -> Session:
    # Build a Session from a dict, tolerating missing fields and key casing
    # 从字典构建 Session，容忍缺失字段与键大小写差异
    get = _ci_getter(raw)
    captured_at = raw.get("captured_at") or raw.get("capturedAt") or 0.0
    try:
        captured_at = float(captured_at)
    except (TypeError, ValueError):
        captured_at = 0.0
    return Session(
        authorization=get("authorization") or "",
        cookie=get("cookie") or "",
        user_agent=get("user_agent") or get("user-agent") or "",
        captured_at=captured_at,
        base_url=str(raw.get("base_url") or ""),
    )


def _normalize_headers(headers: Dict[str, str]) -> Dict[str, str]:
    # Lowercase all header names for case-insensitive lookup
    # 将所有请求头名称转为小写，便于大小写不敏感查找
    return {str(k).lower(): str(v) for k, v in (headers or {}).items()}


def _build_cookie_header(cookies: Any) -> str:
    # Join a Playwright cookie jar into a single "k=v; k=v" header string
    # 将 Playwright Cookie Jar 拼接为 "k=v; k=v" 的请求头字符串
    if isinstance(cookies, str):
        return cookies
    items = []
    for item in cookies or []:
        name = item.get("name")
        value = item.get("value")
        if name is not None and value is not None:
            items.append(f"{name}={value}")
    return "; ".join(items)


def is_login_signal(url: str, headers: Dict[str, str], api_prefix: str) -> bool:
    """
    Decide whether a request indicates "the user is already logged in".
    判断一个请求是否说明"用户已经登录了"。

    - Strong signal: a request to the upstream /api/ carries a non-empty Bearer token;
    - 强信号：发往上游 /api/ 的请求带了非空 Bearer Token；
    - Weak signal: Cookie only — anonymous visits also carry cookies (theme,
      CSRF, etc.), so additionally require the request to hit an endpoint that
      the frontend only calls when logged in.
    - 弱信号：只有 Cookie —— 匿名访问同样会带 Cookie（主题、CSRF 等），
      因此额外要求命中的是必须登录后前端才会调用的接口。
    """
    if not url.startswith(api_prefix):
        return False

    lowered = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    authorization = lowered.get("authorization", "").strip()
    cookie = lowered.get("cookie", "").strip()
    if not authorization and not cookie:
        return False

    if authorization.lower().startswith("bearer ") and len(authorization) > len("bearer "):
        return True
    return bool(cookie) and any(hint in url for hint in AUTHED_PATH_HINTS)


async def credentials_are_valid(base_url: str, session: Session) -> bool:
    """
    Make one real request to the upstream to check whether the captured
    credentials are currently valid.
    对上游做一次真实请求，校验抓到的凭证当前是否有效。

    The capture logic can only see "the request carried credentials", but what
    it carries is not necessarily valid: early in page load the frontend sends
    probing requests with an old token from localStorage; when a captive
    portal (e.g. campus network) is unauthenticated, every request gets
    redirected by the gateway. Therefore credentials must pass one real
    upstream authentication to be considered valid.
    抓取逻辑只能看到"请求带了凭证"，但带的不一定是有效凭证：页面加载早期前端会
    用 localStorage 里的旧 Token 发探测请求；校园网等强制门户未完成认证时任何请求
    都会被网关重定向。因此凭证必须通过上游一次真实鉴权才算有效。
    """
    if not session.is_usable():
        return False
    headers = session.to_headers()
    async with httpx.AsyncClient(
        verify=True,
        follow_redirects=False,  # A portal redirect yields a 3xx, exactly what we treat as invalid / 被门户重定向时拿到 3xx，正好判无效
        timeout=15.0,
    ) as client:
        for prefix in PREFIX_CANDIDATES:
            url = f"{base_url}{prefix}/models"
            try:
                resp = await client.get(url, headers=headers)
            except httpx.RequestError:
                return False
            if resp.status_code == 404:
                continue
            return 200 <= resp.status_code < 300
    return False


async def perform_browser_login(
    base_url: str,
    *,
    headless: bool = False,
    timeout: int = 600,
    quiet_period: float = 6.0,
    verify_ssl: bool = True,
) -> Session:
    """
    Open a browser for manual login, capture the post-login request headers,
    and run a real upstream authentication check.
    打开浏览器让用户手动登录，捕获登录后的请求头，并做真实上游鉴权验证。
    """
    api_prefix = f"{base_url}/api"

    print("=" * 62, flush=True)
    print(lang.t("login_banner_open", url=base_url), flush=True)
    print(lang.t("login_banner_auto"), flush=True)
    print(lang.t("login_banner_portal"), flush=True)
    print(lang.t("login_banner_timeout", timeout=timeout), flush=True)
    print("=" * 62, flush=True)

    captured = Session(base_url=base_url)
    # Set when a login-signal request is captured
    # 捕获到登录信号请求时置位
    event = asyncio.Event()

    async def on_request(request) -> None:
        # Playwright request callback: sniff request headers for credentials
        # Playwright 请求回调：嗅探请求头中的凭证
        try:
            url = str(request.url)
            headers = _normalize_headers(await request.all_headers())
            if not is_login_signal(url, headers, api_prefix):
                return

            authorization = headers.get("authorization", "").strip()
            cookie = headers.get("cookie", "").strip()
            if authorization:
                captured.authorization = authorization
            if cookie:
                captured.cookie = cookie
            captured.user_agent = headers.get("user-agent", "") or DEFAULT_USER_AGENT
            captured.captured_at = time.time()
            event.set()
        except Exception as exc:
            logger.debug(lang.t("capture_error_debug", exc=exc))

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context(ignore_https_errors=not verify_ssl)
        page = await context.new_page()
        page.on("request", on_request)
        try:
            await page.goto(base_url, wait_until="domcontentloaded")
        except Exception as exc:
            logger.warning(lang.t("goto_failed", exc=exc))

        try:
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(event.wait(), timeout=remaining)
                event.clear()
                # Quiet period: login is considered finished only when no newer
                # credentials are captured during this window
                # 静默观察期：期间没有更新的凭证才认为登录流程结束
                try:
                    await asyncio.wait_for(event.wait(), timeout=quiet_period)
                except asyncio.TimeoutError:
                    pass
                # The critical step: captured credentials must pass a real
                # upstream authentication to count as logged in
                # 关键一步：抓到的凭证必须能通过上游真实鉴权才算登录成功
                if await credentials_are_valid(base_url, captured):
                    break
                logger.info(lang.t("validate_failed"))
            await _enrich_from_browser(page, context, captured)
        except asyncio.TimeoutError:
            await browser.close()
            raise SessionError(lang.t("login_timeout", timeout=timeout))
        except SessionError:
            await browser.close()
            raise
        except Exception as exc:
            # E.g. the user closes the browser directly: keep going if we
            # already captured usable credentials
            # 用户直接关掉浏览器等情况：只要抓到了凭证就继续
            if not captured.is_usable():
                await browser.close()
                raise SessionError(lang.t("login_interrupted", exc=exc)) from exc
            logger.warning(lang.t("login_browser_exit", exc=exc))
        finally:
            try:
                if not browser.is_closed():
                    await browser.close()
            except Exception:
                pass

    if not captured.is_usable():
        raise SessionError(lang.t("login_no_creds"))

    return captured


async def _enrich_from_browser(page, context, session: Session) -> None:
    """
    Supplement the capture with the localStorage token and the full cookie jar.
    补充抓取 localStorage 里的 token 与完整 Cookie Jar。

    The Cookie in request headers may be incomplete; Open WebUI also stores
    the JWT in the localStorage `token` key, so reading it directly yields the
    most complete identity information.
    请求头里的 Cookie 可能不完整；Open WebUI 也把 JWT 存在 localStorage 的 `token`
    键里，直接读取能得到最完整的身份信息。
    """
    try:
        token = await page.evaluate(
            "() => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } }"
        )
    except Exception as exc:
        logger.debug(lang.t("localStorage_failed", exc=exc))
        token = ""
    if token and token != "undefined":
        session.authorization = f"Bearer {token}"

    try:
        # Only take cookies of the Open WebUI domain, avoiding cookies from
        # other sites such as the campus portal
        # 只取 Open WebUI 域的 Cookie，避免混入校园网门户等其他站点的 Cookie
        jar = await context.cookies(session.base_url)
        cookie_header = _build_cookie_header(jar)
        if cookie_header:
            session.cookie = cookie_header
    except Exception as exc:
        logger.debug(lang.t("cookies_failed", exc=exc))

    if not session.user_agent:
        try:
            session.user_agent = await page.evaluate("() => navigator.userAgent") or DEFAULT_USER_AGENT
        except Exception:
            session.user_agent = DEFAULT_USER_AGENT
    session.captured_at = time.time()


def save_session(path: Path, session: Session) -> None:
    # Persist session.json to disk
    # 将 session.json 持久化到磁盘
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(session.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # Tighten permissions on POSIX to keep credentials from other local users
    # POSIX 下收敛权限，避免凭证被同机其他用户读取
    if os.name == "posix":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def main(argv: Optional[list[str]] = None) -> int:
    # CLI entry: parse args, run the login flow, save and print session.json
    # 命令行入口：解析参数，执行登录流程，保存并输出 session.json
    # Scan argv for --lang first to honor --lang for the help text as well.
    # 先扫描 argv 中的 --lang，让 --help 的输出也能跟随 --lang。
    cli_args = list(sys.argv[1:]) if argv is None else list(argv)
    for i, token in enumerate(cli_args):
        if token == "--lang" and i + 1 < len(cli_args):
            lang.configure(lang.resolve_language(cli_args[i + 1]))

    # Localize argparse's built-in strings ("show this help message and exit",
    # "usage:", ...) before the parser is constructed.
    # 在创建 parser 前本地化 argparse 内置字符串（"show this help message and
    # exit"、"usage:" 等）。
    lang.install_argparse_translation()

    parser = argparse.ArgumentParser(description=lang.t("cli_description"))
    parser.add_argument(
        "--base-url",
        default=os.getenv("OPEN_WEBUI_BASE_URL", ""),
        help=lang.t("cli_base_url_help"),
    )
    parser.add_argument("--timeout", type=int, default=600, help=lang.t("cli_timeout_help"))
    parser.add_argument("--quiet-period", type=float, default=6.0, help=lang.t("cli_quiet_help"))
    parser.add_argument("--headless", action="store_true", help=lang.t("cli_headless_help"))
    parser.add_argument("--insecure", action="store_true", help=lang.t("cli_insecure_help"))
    parser.add_argument("--output", default="session.json", help=lang.t("cli_output_help"))
    parser.add_argument(
        "--lang",
        choices=(lang.LANG_ZH, lang.LANG_EN, lang.LANG_AUTO),
        default=lang.LANG_AUTO,
        help=lang.t("cli_lang_help"),
    )
    args = parser.parse_args(cli_args)

    base_url = (args.base_url or "").strip().rstrip("/")
    if not base_url:
        parser.error(lang.t("err_base_url_missing"))
    if not base_url.startswith(("http://", "https://")):
        parser.error(lang.t("err_base_url_protocol", base_url=base_url))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        session = asyncio.run(
            perform_browser_login(
                base_url,
                headless=args.headless,
                timeout=args.timeout,
                quiet_period=args.quiet_period,
                verify_ssl=not args.insecure,
            )
        )
    except SessionError as exc:
        print(f"\n{lang.t('error_prefix')} {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"\n{lang.t('error_prefix')} {lang.t('err_login_flow', exc=exc)}", file=sys.stderr)
        return 1

    path = Path(args.output)
    save_session(path, session)
    print(f"\n{lang.t('creds_saved', path=path, desc=session.describe())}", flush=True)

    # Print the full session.json content for copy-paste into the Worker console
    # 终端完整输出 session.json 内容，供复制粘贴到 Worker 管理界面
    content = json.dumps(session.to_dict(), ensure_ascii=False, indent=2)
    print("\n" + "=" * 62, flush=True)
    print(lang.t("copy_hint"), flush=True)
    print("=" * 62, flush=True)
    print(content, flush=True)
    print("=" * 62, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
