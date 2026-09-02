"""
open-webui-to-openai-api — 本地认证获取端

打开浏览器让用户手动完成 Open WebUI 登录，捕获登录后的身份凭证（Authorization /
Cookie / User-Agent），向真实上游做一次鉴权验证（防止误抓过期 Token 或被校园网等
门户重定向产生的无效凭证），验证通过后：

1. 保存到本地 session.json；
2. 在终端完整输出 session.json 内容，供复制粘贴到 Worker 管理界面导入。

用法：
    python login.py --base-url https://chat.example.com
    python login.py --base-url https://chat.example.com --timeout 900 --headless
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

# Playwright 是必需依赖（本工具只做登录捕获）
from playwright.async_api import async_playwright

logger = logging.getLogger("webui-login")

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

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

# 上游候选前缀（Open WebUI >= 0.6 为 /api/v1，老版本为 /api）
PREFIX_CANDIDATES = ("/api/v1", "/api")


class SessionError(RuntimeError):
    """登录过程中的错误。"""


@dataclass
class Session:
    authorization: str = ""
    cookie: str = ""
    user_agent: str = ""
    captured_at: float = 0.0
    base_url: str = ""

    def is_usable(self) -> bool:
        return bool(self.authorization.strip() or self.cookie.strip())

    def to_headers(self) -> Dict[str, str]:
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
        """脱敏后的凭证摘要，可安全写入日志/终端。"""
        parts = []
        if self.authorization:
            parts.append(f"token={self.authorization[:16]}…(len={len(self.authorization)})")
        if self.cookie:
            parts.append(f"cookie(len={len(self.cookie)})")
        age = ""
        if self.captured_at:
            age = f" (age={(time.time() - self.captured_at) / 86400:.1f}d)"
        return ", ".join(parts) + age if parts else "<empty>"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _ci_getter(raw: Dict[str, Any]):
    """大小写不敏感的取值函数。"""
    lowered = {str(k).lower(): v for k, v in raw.items()}

    def get(key: str) -> Any:
        return lowered.get(key.lower())

    return get


def session_from_dict(raw: Dict[str, Any]) -> Session:
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
    return {str(k).lower(): str(v) for k, v in (headers or {}).items()}


def _build_cookie_header(cookies: Any) -> str:
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
    判断一个请求是否说明"用户已经登录了"。

    - 强信号：发往上游 /api/ 的请求带了非空 Bearer Token；
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
    对上游做一次真实请求，校验抓到的凭证当前是否有效。

    抓取逻辑只能看到"请求带了凭证"，但带的不一定是有效凭证：页面加载早期前端会
    用 localStorage 里的旧 Token 发探测请求；校园网等强制门户未完成认证时任何请求
    都会被网关重定向。因此凭证必须通过上游一次真实鉴权才算有效。
    """
    if not session.is_usable():
        return False
    headers = session.to_headers()
    async with httpx.AsyncClient(
        verify=True,
        follow_redirects=False,  # 被门户重定向时拿到 3xx，正好判无效
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
    打开浏览器让用户手动登录，捕获登录后的请求头，并做真实上游鉴权验证。
    """
    api_prefix = f"{base_url}/api"

    print("=" * 62, flush=True)
    print(f"  即将打开浏览器，请在窗口中登录：{base_url}", flush=True)
    print("  登录成功后脚本会自动抓取凭证并关闭浏览器（无需任何额外操作）。", flush=True)
    print("  若浏览器跳到校园网 / 公司网认证页，请先完成网络认证再回到登录。", flush=True)
    print(f"  最长等待 {timeout} 秒。", flush=True)
    print("=" * 62, flush=True)

    captured = Session(base_url=base_url)
    event = asyncio.Event()

    async def on_request(request) -> None:
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
            logger.debug("抓取请求头时出错：%s", exc)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context(ignore_https_errors=not verify_ssl)
        page = await context.new_page()
        page.on("request", on_request)
        try:
            await page.goto(base_url, wait_until="domcontentloaded")
        except Exception as exc:
            logger.warning("打开首页失败（%s），如已登录可忽略。", exc)

        try:
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(event.wait(), timeout=remaining)
                event.clear()
                # 静默观察期：期间没有更新的凭证才认为登录流程结束
                try:
                    await asyncio.wait_for(event.wait(), timeout=quiet_period)
                except asyncio.TimeoutError:
                    pass
                # 关键一步：抓到的凭证必须能通过上游真实鉴权才算登录成功
                if await credentials_are_valid(base_url, captured):
                    break
                logger.info("抓到的凭证未通过上游校验（可能是过期 Token，或校园网等门户尚未完成网络认证），继续等待登录...")
            await _enrich_from_browser(page, context, captured)
        except asyncio.TimeoutError:
            await browser.close()
            raise SessionError(
                f"登录超时（{timeout} 秒），未捕获到有效凭证，请重试。\n"
                f"如果浏览器跳到了校园网 / 公司网认证页，请先完成网络认证，"
                f"再回到 Open WebUI 完成登录。"
            )
        except SessionError:
            await browser.close()
            raise
        except Exception as exc:
            # 用户直接关掉浏览器等情况：只要抓到了凭证就继续
            if not captured.is_usable():
                await browser.close()
                raise SessionError(f"浏览器登录中断：{exc}") from exc
            logger.warning("浏览器异常退出（%s），使用已抓到的凭证继续。", exc)
        finally:
            try:
                if not browser.is_closed():
                    await browser.close()
            except Exception:
                pass

    if not captured.is_usable():
        raise SessionError("未能捕获到任何凭证，请检查是否在浏览器中完成了登录。")

    return captured


async def _enrich_from_browser(page, context, session: Session) -> None:
    """
    补充抓取 localStorage 里的 token 与完整 Cookie Jar。

    请求头里的 Cookie 可能不完整；Open WebUI 也把 JWT 存在 localStorage 的 `token`
    键里，直接读取能得到最完整的身份信息。
    """
    try:
        token = await page.evaluate(
            "() => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } }"
        )
    except Exception as exc:
        logger.debug("读取 localStorage 失败：%s", exc)
        token = ""
    if token and token != "undefined":
        session.authorization = f"Bearer {token}"

    try:
        # 只取 Open WebUI 域的 Cookie，避免混入校园网门户等其他站点的 Cookie
        jar = await context.cookies(session.base_url)
        cookie_header = _build_cookie_header(jar)
        if cookie_header:
            session.cookie = cookie_header
    except Exception as exc:
        logger.debug("读取 Cookie Jar 失败：%s", exc)

    if not session.user_agent:
        try:
            session.user_agent = await page.evaluate("() => navigator.userAgent") or DEFAULT_USER_AGENT
        except Exception:
            session.user_agent = DEFAULT_USER_AGENT
    session.captured_at = time.time()


def save_session(path: Path, session: Session) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(session.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # POSIX 下收敛权限，避免凭证被同机其他用户读取
    if os.name == "posix":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Open WebUI 本地认证获取端：浏览器登录并输出 session.json",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("OPEN_WEBUI_BASE_URL", ""),
        help="Open WebUI 地址，需包含 https:// 前缀（必填，或设环境变量 OPEN_WEBUI_BASE_URL）",
    )
    parser.add_argument("--timeout", type=int, default=600, help="最长等待秒数（默认 600）")
    parser.add_argument("--quiet-period", type=float, default=6.0, help="捕获后的静默观察期秒数（默认 6）")
    parser.add_argument("--headless", action="store_true", help="以无头模式启动浏览器")
    parser.add_argument("--insecure", action="store_true", help="跳过上游 HTTPS 证书校验（慎用）")
    parser.add_argument("--output", default="session.json", help="session.json 输出路径（默认 ./session.json）")
    args = parser.parse_args(argv)

    base_url = (args.base_url or "").strip().rstrip("/")
    if not base_url:
        parser.error("缺少 --base-url，或未设置环境变量 OPEN_WEBUI_BASE_URL")
    if not base_url.startswith(("http://", "https://")):
        parser.error(f"--base-url 需要包含协议头：{base_url!r}，例如 https://chat.example.com")

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
        print(f"\n[错误] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"\n[错误] 登录流程异常：{exc}", file=sys.stderr)
        return 1

    path = Path(args.output)
    save_session(path, session)
    print(f"\n[成功] 凭证已保存到 {path}（{session.describe()}）", flush=True)

    # 终端完整输出 session.json 内容，供复制粘贴到 Worker 管理界面
    content = json.dumps(session.to_dict(), ensure_ascii=False, indent=2)
    print("\n" + "=" * 62, flush=True)
    print("  请复制下方全部 JSON 内容，粘贴到 Worker 管理界面的『导入 Session』中。", flush=True)
    print("=" * 62, flush=True)
    print(content, flush=True)
    print("=" * 62, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
