"""
User-facing message localization (zh / en) for the local login tool.

Language selection priority: CLI --lang flag > system language detection > English.

At import time the module initializes with the system language, so messages logged
before argument parsing are localized too. The CLI flag overrides it later via
configure().

登录工具用户可见消息的本地化（zh / en）。

语言选择优先级：CLI --lang 参数 > 系统语言检测 > 默认英文。

模块导入时即按系统语言初始化，因此解析参数之前的输出也会被本地化；
CLI 参数随后通过 configure() 覆盖。

Adapted from the reference project `open-webui-to-openai-api` (lang.py).
改编自参考项目 open-webui-to-openai-api 的 lang.py。
"""

from __future__ import annotations

import locale
import os
import sys
from typing import Dict, Optional, Tuple

LANG_ZH = "zh"
LANG_EN = "en"
LANG_AUTO = "auto"

# Messages: key -> (en, zh)
# 消息表：key -> (英文, 中文)
_MESSAGES: Dict[str, Tuple[str, str]] = {
    # ---------------- CLI ----------------
    "cli_description": (
        "Open WebUI local credential capture tool: browser login and output session.json",
        "Open WebUI 本地认证获取端：浏览器登录并输出 session.json",
    ),
    "cli_base_url_help": (
        "Open WebUI URL with http(s):// prefix (required, or set env OPEN_WEBUI_BASE_URL)",
        "Open WebUI 地址，需包含 https:// 前缀（必填，或设环境变量 OPEN_WEBUI_BASE_URL）",
    ),
    "cli_timeout_help": (
        "Maximum seconds to wait (default 600)",
        "最长等待秒数（默认 600）",
    ),
    "cli_quiet_help": (
        "Quiet period after capture, seconds (default 6)",
        "捕获后的静默观察期秒数（默认 6）",
    ),
    "cli_headless_help": (
        "Launch the browser in headless mode",
        "以无头模式启动浏览器",
    ),
    "cli_insecure_help": (
        "Skip upstream HTTPS cert verification (use with caution)",
        "跳过上游 HTTPS 证书校验（慎用）",
    ),
    "cli_output_help": (
        "session.json output path (default ./session.json)",
        "session.json 输出路径（默认 ./session.json）",
    ),
    "cli_lang_help": (
        "Output language: zh / en / auto (default: auto = system language)",
        "输出语言：zh / en / auto（默认 auto = 系统语言，检测不到时用英文）",
    ),
    "err_base_url_missing": (
        "Missing --base-url, or set env OPEN_WEBUI_BASE_URL",
        "缺少 --base-url，或未设置环境变量 OPEN_WEBUI_BASE_URL",
    ),
    "err_base_url_protocol": (
        "--base-url must include a protocol scheme, e.g. https://chat.example.com (got {base_url!r})",
        "--base-url 需要包含协议头：{base_url!r}，例如 https://chat.example.com",
    ),
    "error_prefix": (
        "[Error]",
        "[错误]",
    ),
    "err_login_flow": (
        "Login flow error: {exc}",
        "登录流程异常：{exc}",
    ),
    # ---------------- login banner ----------------
    "login_banner_open": (
        "  Opening browser, please log in: {url}",
        "  即将打开浏览器，请在窗口中登录：{url}",
    ),
    "login_banner_auto": (
        "  Credentials are captured automatically; the browser closes after login.",
        "  登录成功后脚本会自动抓取凭证并关闭浏览器（无需任何额外操作）。",
    ),
    "login_banner_portal": (
        "  If redirected to a campus/corporate network auth page, complete it first.",
        "  若浏览器跳到校园网 / 公司网认证页，请先完成网络认证再回到登录。",
    ),
    "login_banner_timeout": (
        "  Waiting at most {timeout} seconds.",
        "  最长等待 {timeout} 秒。",
    ),
    # ---------------- capture ----------------
    "capture_error_debug": (
        "Error capturing request headers: {exc}",
        "抓取请求头时出错：{exc}",
    ),
    "goto_failed": (
        "Failed to open the homepage ({exc}); ignore if already logged in.",
        "打开首页失败（{exc}），如已登录可忽略。",
    ),
    "localStorage_failed": (
        "Failed to read localStorage: {exc}",
        "读取 localStorage 失败：{exc}",
    ),
    "cookies_failed": (
        "Failed to read the cookie jar: {exc}",
        "读取 Cookie Jar 失败：{exc}",
    ),
    "validate_failed": (
        "Credentials failed upstream validation (expired token or unauthenticated portal?); waiting for login...",
        "抓到的凭证未通过上游校验（可能是过期 Token，或校园网等门户尚未完成网络认证），继续等待登录...",
    ),
    # ---------------- login errors ----------------
    "login_timeout": (
        "Login timed out ({timeout}s); no valid credentials captured.\n"
        "If the browser hit a network auth page, complete it, then log in to Open WebUI.",
        "登录超时（{timeout} 秒），未捕获到有效凭证，请重试。\n"
        "如果浏览器跳到了校园网 / 公司网认证页，请先完成网络认证，"
        "再回到 Open WebUI 完成登录。",
    ),
    "login_interrupted": (
        "Browser login interrupted: {exc}",
        "浏览器登录中断：{exc}",
    ),
    "login_browser_exit": (
        "Browser exited abnormally ({exc}); using captured credentials.",
        "浏览器异常退出（{exc}），使用已抓到的凭证继续。",
    ),
    "login_no_creds": (
        "No credentials captured; did you complete the login in the browser?",
        "未能捕获到任何凭证，请检查是否在浏览器中完成了登录。",
    ),
    # ---------------- success ----------------
    "creds_saved": (
        "Credentials saved to {path} ({desc})",
        "凭证已保存到 {path}（{desc}）",
    ),
    "copy_hint": (
        "  Copy the JSON below into 'Import Session' in the Worker admin console.",
        "  请复制下方全部 JSON 内容，粘贴到 Worker 管理界面的『导入 Session』中。",
    ),
    "describe_empty": (
        "<empty>",
        "<空>",
    ),
}

# Current language; initialized with the system language at import time
# 当前语言；导入时按系统语言初始化
_current: str = LANG_EN


def detect_system_language() -> str:
    """
    Detect the system language from env vars / Windows UI language; fall back to English.

    从环境变量 / Windows UI 语言检测系统语言；检测不到时回退英文。
    """
    # POSIX-style env vars (highest confidence)
    # POSIX 风格环境变量（置信度最高）
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        value = (os.environ.get(var) or "").strip()
        if value:
            # Strip encoding (.UTF-8) and region (_CN / -CN), keep the primary code
            # 去掉编码（.UTF-8）与地区（_CN / -CN），保留主语言码
            code = value.replace("-", "_").split(".")[0].split("_")[0].lower()
            if code.startswith("zh"):
                return LANG_ZH
            return LANG_EN

    # Windows: GetUserDefaultUILanguage returns an LCID; primary language ID 0x04 = Chinese
    # Windows：GetUserDefaultUILanguage 返回 LCID；主语言 ID 0x04 = 中文
    if sys.platform == "win32":
        try:
            import ctypes

            lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            if (lcid & 0x3FF) == 0x04:
                return LANG_ZH
        except Exception:
            # pragma: no cover - depends on the platform
            # 取决于平台
            pass

    # Final fallback: the locale module
    # 最后兜底：locale 模块
    try:
        code, _encoding = locale.getlocale() or (None, None)
        if code and code.replace("-", "_").split("_")[0].lower().startswith("zh"):
            return LANG_ZH
    except Exception:
        # pragma: no cover - locale-dependent
        # 取决于语言环境
        pass

    return LANG_EN


def resolve_language(cli_lang: Optional[str]) -> str:
    """
    Resolve the effective language: CLI flag > system detection > English.

    解析生效语言：CLI 参数 > 系统检测 > 英文。
    """
    if cli_lang in (LANG_ZH, LANG_EN):
        return cli_lang
    return detect_system_language()


def configure(language: str) -> None:
    """
    Force the output language (used by the --lang CLI flag).

    强制设置输出语言（供 --lang CLI 参数使用）。
    """
    global _current
    _current = language if language in (LANG_ZH, LANG_EN) else LANG_EN


def current() -> str:
    """
    The currently active language.

    当前生效的语言。
    """
    return _current


# Built-in argparse strings, localized so that the whole --help / error output
# follows the same language as the rest of the tool.
#
# argparse 内置字符串，让 --help / 错误输出与工具整体保持同一语言。
_ARGPARSE_STRINGS: Dict[str, Tuple[str, str]] = {
    "usage: ": ("usage: ", "用法："),
    "options": ("options", "选项"),
    "options:": ("options:", "选项："),
    "optional arguments": ("optional arguments", "可选参数"),
    "show this help message and exit": (
        "show this help message and exit",
        "显示此帮助信息并退出",
    ),
    "the following arguments are required: %s": (
        "the following arguments are required: %s",
        "缺少必需的参数：%s",
    ),
    "one of the arguments %s is required": (
        "one of the arguments %s is required",
        "必须提供以下参数之一：%s",
    ),
    "unrecognized arguments: %s": (
        "unrecognized arguments: %s",
        "无法识别的参数：%s",
    ),
    "argument %s: expected one argument": (
        "argument %s: expected one argument",
        "参数 %s：需要一个值",
    ),
    "argument %s: expected at least one argument": (
        "argument %s: expected at least one argument",
        "参数 %s：至少需要一个值",
    ),
    "argument %s: expected %s": (
        "argument %s: expected %s",
        "参数 %s：预期 %s",
    ),
    "invalid choice: %r (choose from %s)": (
        "invalid choice: %r (choose from %s)",
        "无效选项：%r（可选 %s）",
    ),
    "invalid %s value: %r": (
        "invalid %s value: %r",
        "无效的 %s 值：%r",
    ),
    "%(prog)s: error: %(message)s": (
        "%(prog)s: error: %(message)s",
        "%(prog)s：错误：%(message)s",
    ),
}


def _argparse_gettext(message: str) -> str:
    # gettext-style hook installed into argparse; unknown strings pass through.
    # 安装进 argparse 的 gettext 钩子；未收录的字符串原样返回。
    pair = _ARGPARSE_STRINGS.get(message)
    if pair is None:
        return message
    return pair[1] if _current == LANG_ZH else pair[0]


def install_argparse_translation() -> None:
    """
    Make argparse's built-in help/error strings follow the current language.

    Must be called before creating the ArgumentParser: the "-h" help text and
    the "options" group title are captured at construction time.

    让 argparse 内置的帮助/错误字符串跟随当前语言。

    必须在创建 ArgumentParser 之前调用："-h" 帮助文本与 "options" 分组标题
    在构造时即被捕获。
    """
    import argparse

    argparse._ = _argparse_gettext


def t(key: str, **fmt: object) -> str:
    """
    Translate a message key into the current language, then format it.

    Unknown keys fall back to the key itself, so a typo degrades gracefully instead
    of crashing at runtime.
    
    把消息 key 翻译成当前语言，再按参数格式化。

    未知 key 回退为 key 本身，拼写错误只会退化为原文而不会在运行时崩溃。
    """
    pair = _MESSAGES.get(key)
    text = pair[1] if pair and _current == LANG_ZH else (pair[0] if pair else key)
    return text.format(**fmt) if fmt else text


_current = detect_system_language()
