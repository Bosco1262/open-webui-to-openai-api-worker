/**
 * Self-contained admin console (single HTML page, zero external dependencies).
 * Layout: top title bar + fixed left sidebar navigation + right content area.
 * Built-in i18n (zh-CN / en): manual choice > browser language > English fallback.
 * Dark console aesthetic with glassmorphism cards and orange accents.
 * 
 * 自包含的管理控制台（单 HTML 页面，零外部依赖）。
 * 布局：顶部标题栏 + 固定左侧边栏导航 + 右侧内容区。
 * 内置 i18n（zh-CN / en）：手动选择 > 浏览器语言 > 英文回退。
 * 深色控制台风格，玻璃拟态卡片与橙色点缀。
 */

const VERSION = "1.0.0";

export const ADMIN_UI = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title></title>
<style>
  :root {
    --bg-0: #0f1420;
    --bg-1: #1a2233;
    --bg-2: #232d42;
    --text-0: #e6ebf4;
    --text-1: #94a3b8;
    --accent: #f6821f;
    --accent-2: #fbad41;
    --accent-3: #ff6b35;
    --ok: #22c55e;
    --err: #ef4444;
    --warn: #f59e0b;
    --info: #3b82f6;
    --border: rgba(148, 163, 184, 0.14);
    --radius: 14px;
    --font: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    --mono: "JetBrains Mono", "SF Mono", Consolas, "Courier New", monospace;
    --topbar-h: 60px;
    --sidebar-w: 220px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font);
    color: var(--text-0);
    background:
      radial-gradient(1000px 500px at 85% -10%, rgba(246, 130, 31, 0.14), transparent 60%),
      radial-gradient(800px 500px at -10% 20%, rgba(59, 130, 246, 0.10), transparent 55%),
      linear-gradient(160deg, var(--bg-0), var(--bg-1) 70%);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  ::selection { background: rgba(246, 130, 31, 0.35); }

  /* ---------- Login view ---------- */
  /* ---------- 登录视图 ---------- */
  #view-login {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .login-card {
    width: 100%; max-width: 420px;
    background: rgba(26, 34, 51, 0.62);
    border: 1px solid var(--border);
    border-radius: 20px;
    backdrop-filter: blur(24px) saturate(140%);
    -webkit-backdrop-filter: blur(24px) saturate(140%);
    padding: 40px 36px 32px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    animation: rise 0.5s ease both;
  }
  .login-logo {
    width: 58px; height: 58px; margin: 0 auto 18px;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--accent-3), var(--accent) 55%, var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 24px rgba(246, 130, 31, 0.35);
  }
  .login-logo svg { width: 30px; height: 30px; }
  .login-title { text-align: center; font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
  .login-sub { text-align: center; font-size: 13px; color: var(--text-1); margin: 6px 0 26px; }

  .field { margin-bottom: 14px; position: relative; }
  .field input {
    width: 100%; padding: 12px 44px 12px 14px;
    background: rgba(15, 20, 32, 0.6);
    border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-0); font-size: 14px; font-family: var(--font);
    outline: none; transition: border-color 0.2s, box-shadow 0.2s;
  }
  .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(246, 130, 31, 0.15); }
  .field .eye {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text-1); cursor: pointer;
    font-size: 16px; padding: 6px; border-radius: 8px;
  }
  .field .eye:hover { color: var(--text-0); }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    border: none; border-radius: 10px; cursor: pointer;
    font-family: var(--font); font-size: 14px; font-weight: 600;
    padding: 11px 18px; transition: transform 0.15s, box-shadow 0.15s, background 0.15s, opacity 0.15s;
    user-select: none;
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent-3), var(--accent));
    color: #fff; box-shadow: 0 6px 18px rgba(246, 130, 31, 0.3);
    width: 100%;
  }
  .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(246, 130, 31, 0.42); }
  .btn-ghost {
    background: rgba(35, 45, 66, 0.7); color: var(--text-0);
    border: 1px solid var(--border);
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-2); }
  .btn-danger { background: rgba(239, 68, 68, 0.16); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
  .btn-danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.28); }
  .btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

  .hint { font-size: 12px; color: var(--text-1); margin-top: 6px; line-height: 1.5; }
  .hint.err { color: #fca5a5; }
  .hint.ok { color: #86efac; }

  /* ---------- Panel layout ---------- */
  /* ---------- 面板布局 ---------- */
  #view-panel { display: none; }
  #view-panel.show { display: block; }

  /* Title bar */
  /* 标题栏 */
  .topbar {
    position: sticky; top: 0; z-index: 20;
    height: var(--topbar-h);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 22px;
    background: rgba(15, 20, 32, 0.78);
    border-bottom: 1px solid var(--border);
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
  }
  .topbar-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .topbar-logo {
    width: 34px; height: 34px; border-radius: 10px; flex: none;
    background: linear-gradient(135deg, var(--accent-3), var(--accent) 60%, var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 14px rgba(246, 130, 31, 0.3);
  }
  .topbar-logo svg { width: 18px; height: 18px; }
  .topbar-name { font-size: 15.5px; font-weight: 600; white-space: nowrap; }
  .topbar-name small { font-size: 11px; color: var(--text-1); font-weight: 400; margin-left: 8px; }
  .topbar-actions { display: flex; align-items: center; gap: 10px; }

  /* Body: fixed sidebar + content */
  /* 主体：固定侧边栏 + 内容区 */
  .layout-body { display: flex; min-height: calc(100vh - var(--topbar-h)); }

  .sidebar {
    width: var(--sidebar-w); flex: none;
    position: sticky; top: var(--topbar-h);
    height: calc(100vh - var(--topbar-h));
    overflow-y: auto;
    display: flex; flex-direction: column;
    padding: 18px 12px;
    border-right: 1px solid var(--border);
    background: rgba(15, 20, 32, 0.45);
  }
  .side-label {
    font-size: 11px; color: var(--text-1); text-transform: uppercase; letter-spacing: 1px;
    padding: 4px 12px 10px;
  }
  .side-nav { display: flex; flex-direction: column; gap: 4px; }
  .side-item {
    display: flex; align-items: center; gap: 11px;
    padding: 11px 12px; border-radius: 10px;
    font-size: 13.5px; color: var(--text-1);
    cursor: pointer; border: 1px solid transparent;
    background: none; font-family: var(--font); text-align: left; width: 100%;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    user-select: none;
  }
  .side-item svg { width: 17px; height: 17px; flex: none; }
  .side-item:hover { background: rgba(35, 45, 66, 0.6); color: var(--text-0); }
  .side-item.active {
    background: linear-gradient(135deg, rgba(246, 130, 31, 0.18), rgba(246, 130, 31, 0.08));
    border-color: rgba(246, 130, 31, 0.35);
    color: var(--accent-2);
    font-weight: 600;
  }
  .side-item .side-badge {
    margin-left: auto; font-size: 11px; font-family: var(--mono);
    background: rgba(35, 45, 66, 0.8); color: var(--text-1);
    border-radius: 999px; padding: 1px 8px;
  }
  .side-item.active .side-badge { color: var(--accent-2); }

  .side-foot {
    margin-top: auto; padding: 12px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--text-1); line-height: 1.7;
  }

  .content {
    flex: 1; min-width: 0;
    padding: 24px 26px 44px;
  }
  .content-inner { max-width: 920px; margin: 0 auto; }

  .page { display: none; }
  .page.active { display: block; animation: rise 0.3s ease both; }

  .page-head { margin-bottom: 20px; }
  .page-head h2 { font-size: 19px; font-weight: 600; }
  .page-head p { font-size: 12.5px; color: var(--text-1); margin-top: 5px; line-height: 1.6; }

  /* ---------- Widgets ---------- */
  /* ---------- 通用组件 ---------- */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .stat {
    background: rgba(26, 34, 51, 0.6); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    animation: rise 0.45s ease both;
  }
  .stat:nth-child(2) { animation-delay: 0.06s; }
  .stat:nth-child(3) { animation-delay: 0.12s; }
  .stat:nth-child(4) { animation-delay: 0.18s; }
  .stat .label { font-size: 12px; color: var(--text-1); display: flex; align-items: center; gap: 6px; }
  .stat .value { font-size: 15px; font-weight: 600; margin-top: 8px; word-break: break-all; line-height: 1.4; }
  .stat .sub { font-size: 11px; color: var(--text-1); margin-top: 4px; font-family: var(--mono); }

  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .badge.ok { background: rgba(34, 197, 94, 0.14); color: #86efac; }
  .badge.err { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }
  .badge.warn { background: rgba(245, 158, 11, 0.14); color: #fcd34d; }
  .badge.info { background: rgba(59, 130, 246, 0.14); color: #93c5fd; }
  .badge.gray { background: rgba(148, 163, 184, 0.12); color: var(--text-1); }
  .dot-badge { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

  .card {
    background: rgba(26, 34, 51, 0.6); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 22px; margin-bottom: 18px; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    animation: rise 0.5s ease both;
  }
  .card h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .card h3 .ic { color: var(--accent); }
  .card .desc { font-size: 12.5px; color: var(--text-1); margin-bottom: 16px; line-height: 1.6; }

  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid2 .full { grid-column: 1 / -1; }

  .setting-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; flex-wrap: wrap;
    background: rgba(15, 20, 32, 0.45); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
  }
  .setting-info { min-width: 0; }
  .setting-label { font-size: 13px; color: var(--text-0); margin-bottom: 5px; }
  .setting-value { display: flex; align-items: center; gap: 8px; }
  .setting-hint { font-size: 12px; color: var(--text-1); margin-top: 4px; }

  label.lbl { display: block; font-size: 12.5px; color: var(--text-1); margin-bottom: 6px; }
  input, textarea, select {
    width: 100%; padding: 10px 12px;
    background: rgba(15, 20, 32, 0.6);
    border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-0); font-size: 13.5px; font-family: var(--font);
    outline: none; transition: border-color 0.2s, box-shadow 0.2s;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(246, 130, 31, 0.14); }
  textarea { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; resize: vertical; min-height: 150px; }
  .form-row { margin-bottom: 14px; }

  .btn-row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }

  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table th {
    text-align: left; font-size: 11.5px; color: var(--text-1); font-weight: 600;
    padding: 8px 10px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.4px;
  }
  .table td { padding: 10px; border-bottom: 1px solid rgba(148, 163, 184, 0.08); }
  .table tr:last-child td { border-bottom: none; }
  .table .mono { font-family: var(--mono); font-size: 12px; }
  .table .empty { text-align: center; color: var(--text-1); padding: 22px !important; }

  .banner { border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-top: 14px; line-height: 1.5; display: none; }
  .banner.ok { display: block; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.25); color: #86efac; }
  .banner.err { display: block; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); color: #fca5a5; }
  .banner.warn { display: block; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.25); color: #fcd34d; }
  .banner.info { display: block; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.25); color: #93c5fd; }

  .url-chip {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(35, 45, 66, 0.7); border: 1px solid var(--border);
    border-radius: 10px; padding: 6px 10px; font-family: var(--mono); font-size: 12px; color: var(--text-1);
    max-width: 100%;
  }
  .url-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; flex: none; }
  .url-chip span.txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .code-block {
    background: rgba(15, 20, 32, 0.7); border: 1px solid var(--border); border-radius: 10px;
    font-family: var(--mono); font-size: 12px; padding: 12px 14px; color: var(--text-1);
    line-height: 1.8; word-break: break-all; margin-top: 10px;
  }
  .code-block b { color: var(--accent-2); font-weight: 600; }

  .spinner {
    width: 14px; height: 14px; border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff; border-radius: 50%; display: inline-block; animation: spin 0.7s linear infinite;
  }

  .modal-mask {
    position: fixed; inset: 0; background: rgba(8, 11, 18, 0.7); backdrop-filter: blur(6px);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 20px;
  }
  .modal-mask.show { display: flex; }
  .modal {
    background: var(--bg-1); border: 1px solid var(--border); border-radius: 16px;
    max-width: 520px; width: 100%; padding: 26px; box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: rise 0.25s ease both;
  }
  .modal h4 { font-size: 15px; margin-bottom: 8px; }
  .modal .key-box {
    background: rgba(15, 20, 32, 0.8); border: 1px solid var(--border); border-radius: 10px;
    font-family: var(--mono); font-size: 13px; padding: 14px; margin: 12px 0; word-break: break-all;
    color: var(--accent-2);
  }
  .modal .note { font-size: 12px; color: var(--text-1); margin-bottom: 12px; }

  .toast-wrap { position: fixed; top: 20px; right: 20px; z-index: 100; display: flex; flex-direction: column; gap: 10px; }
  .toast {
    background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 16px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    opacity: 0; transform: translateX(20px); transition: all 0.3s ease; max-width: 360px;
  }
  .toast.show { opacity: 1; transform: translateX(0); }
  .toast.ok { border-color: rgba(34,197,94,0.4); }
  .toast.err { border-color: rgba(239,68,68,0.4); }
  .toast.warn { border-color: rgba(245,158,11,0.4); }

  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  @media (max-width: 860px) {
    .layout-body { flex-direction: column; }
    .sidebar {
      width: 100%; height: auto; overflow: visible; padding: 10px 12px;
      border-right: none; border-bottom: 1px solid var(--border);
      position: sticky; top: var(--topbar-h); z-index: 15;
      background: rgba(15, 20, 32, 0.85);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    }
    .side-label, .side-foot { display: none; }
    .side-nav { flex-direction: row; gap: 6px; overflow-x: auto; }
    .side-item { width: auto; flex: none; padding: 9px 12px; white-space: nowrap; }
    .side-item .side-badge { display: none; }
    .content { padding: 18px 16px 40px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .grid2 { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="toast-wrap" id="toasts"></div>

<!-- ===================== Login view ===================== -->
<!-- ===================== 登录视图 ===================== -->
<div id="view-login">
  <div class="login-card">
    <div class="login-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h11M4 12h8M4 17h13"/>
        <path d="M17 4l4 4-4 4"/>
        <path d="M13 10l4 4 4-4"/>
      </svg>
    </div>
    <div class="login-title" data-i18n="brand.name">Open WebUI 代理控制台</div>
    <div class="login-sub" id="login-sub" data-i18n="login.subtitle">将 Open WebUI 反代为 OpenAI 兼容 API</div>
    <div id="login-mode" data-mode="login">
      <form id="form-login" autocomplete="current-password">
        <div class="field">
          <input id="pw" type="password" data-i18n-ph="login.pw_ph" placeholder="管理密码" autocomplete="current-password" required />
          <button type="button" class="eye" data-target="pw" aria-label="show/hide password" data-i18n-aria="common.show_pw">👁</button>
        </div>
        <button class="btn btn-primary" id="btn-login" type="submit" data-i18n="login.btn">登 录</button>
      </form>
      <form id="form-setup" style="display:none" autocomplete="new-password">
        <div class="field">
          <input id="pw1" type="password" data-i18n-ph="login.pw1_ph" placeholder="设置管理密码（至少 8 位）" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw1" aria-label="show/hide password" data-i18n-aria="common.show_pw">👁</button>
        </div>
        <div class="field">
          <input id="pw2" type="password" data-i18n-ph="login.pw2_ph" placeholder="确认管理密码" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw2" aria-label="show/hide password" data-i18n-aria="common.show_pw">👁</button>
        </div>
        <button class="btn btn-primary" id="btn-setup" type="submit" data-i18n="login.setup_btn">设置密码并进入</button>
      </form>
    </div>
    <div class="hint" id="login-msg"></div>
  </div>
</div>

<!-- ===================== Panel view ===================== -->
<!-- ===================== 面板视图 ===================== -->
<div id="view-panel">

  <!-- Title bar -->
  <!-- 标题栏 -->
  <header class="topbar">
    <div class="topbar-brand">
      <div class="topbar-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h11M4 12h8M4 17h13"/>
          <path d="M17 4l4 4-4 4"/>
          <path d="M13 10l4 4 4-4"/>
        </svg>
      </div>
      <div class="topbar-name"><span data-i18n="brand.name">Open WebUI 代理控制台</span><small>v${VERSION}</small></div>
    </div>
    <div class="topbar-actions">
      <button class="btn btn-ghost btn-sm" onclick="logout()" data-i18n="nav.logout">退出登录</button>
    </div>
  </header>

  <div class="layout-body">

    <!-- Sidebar -->
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="side-label" data-i18n="nav.label">导航</div>
      <nav class="side-nav">
        <button class="side-item active" data-page="dashboard" onclick="switchPage('dashboard')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
            <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
          </svg>
          <span data-i18n="nav.dashboard">仪表盘</span>
        </button>
        <button class="side-item" data-page="upstream" onclick="switchPage('upstream')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>
            <path d="M7 7h.01M7 17h.01"/>
          </svg>
          <span data-i18n="nav.upstream">上游服务端</span>
        </button>
        <button class="side-item" data-page="keys" onclick="switchPage('keys')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16.5 6.5l3 3"/><path d="M14 9l2.5 2.5"/>
          </svg>
          <span data-i18n="nav.keys">API 管理</span>
          <span class="side-badge" id="nav-key-count">·</span>
        </button>
        <button class="side-item" data-page="settings" onclick="switchPage('settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span data-i18n="nav.settings">网页设置</span>
        </button>
      </nav>
      <div class="side-foot">
        <span data-i18n="nav.foot1">登录后可管理上游凭证、</span><br />
        <span data-i18n="nav.foot2">API Key 与控制台设置。</span>
      </div>
    </aside>

    <!-- Content -->
    <!-- 内容区 -->
    <main class="content">
      <div class="content-inner">

        <!-- ============ Page: Dashboard ============ -->
        <!-- ============ 页面：仪表盘 ============ -->
        <section class="page active" id="page-dashboard">
          <div class="page-head">
            <h2 data-i18n="nav.dashboard">仪表盘</h2>
            <p data-i18n="dash.subtitle">代理服务整体运行状态一览。</p>
          </div>

          <div class="stats" style="margin-bottom:18px;">
            <div class="stat">
              <div class="label" data-i18n="stat.session">Session 凭证</div>
              <div class="value"><span id="st-session">—</span></div>
              <div class="sub" id="st-session-sub"></div>
            </div>
            <div class="stat">
              <div class="label" data-i18n="stat.upstream">上游地址</div>
              <div class="value" id="st-upstream">—</div>
              <div class="sub" id="st-upstream-sub"></div>
            </div>
            <div class="stat">
              <div class="label" data-i18n="stat.keys">API Key 数量</div>
              <div class="value" id="st-keys">—</div>
              <div class="sub" data-i18n="stat.keys_sub">生成的客户端密钥</div>
            </div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="dash.access_title">客户端接入</span></h3>
            <div class="desc" data-i18n="dash.access_desc">在任何 OpenAI 兼容客户端中使用以下地址与密钥接入本代理。</div>
            <span class="url-chip" data-i18n-title="dash.chip_title" title="客户端接入地址，点击复制">
              <span class="dot"></span><span class="txt" id="chip-url">/v1</span>
              <button class="btn btn-ghost btn-sm" onclick="copyText(document.getElementById('chip-url').textContent.trim(), t('msg.copied'))" data-i18n="dash.copy">复制</button>
            </span>
            <div class="code-block">
              <b>Base URL</b>&nbsp;&nbsp;<span id="api-base-code">—</span><br />
              <b>Authorization</b>&nbsp;&nbsp;Bearer sk-xxx
            </div>
          </div>
        </section>

        <!-- ============ Page: Upstream ============ -->
        <!-- ============ 页面：上游服务端 ============ -->
        <section class="page" id="page-upstream">
          <div class="page-head">
            <h2 data-i18n="nav.upstream">上游服务端</h2>
            <p data-i18n="up.subtitle">导入并管理 Open WebUI 的 Session 凭证。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="up.import_title">导入 Session</span></h3>
            <div class="desc" data-i18n-html="up.import_desc">在本地运行 <code>python login.py --base-url https://你的-open-webui 地址</code>，完成浏览器登录后，将终端输出的 <b>session.json 全部 JSON 内容</b> 粘贴到下方并导入。</div>
            <div class="form-row">
              <label class="lbl" data-i18n="up.json_label">session.json 内容</label>
              <textarea id="session-json" placeholder='{\n  "authorization": "Bearer eyJ...",\n  "cookie": "...",\n  "base_url": "https://..."\n}'></textarea>
            </div>
            <div class="btn-row">
              <button class="btn btn-ghost" onclick="testSession()" data-i18n="up.test">校验并测试连通</button>
              <button class="btn btn-primary" style="width:auto;" onclick="importSession()" data-i18n="up.import">导入 Session</button>
              <button class="btn btn-danger btn-sm" onclick="deleteSession()" data-i18n="common.delete">删除</button>
            </div>
            <div class="banner" id="session-banner"></div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="up.status_title">当前凭证状态</span></h3>
            <div class="desc" data-i18n="up.status_desc">最近一次导入的凭证摘要，凭证过期后请重新登录上游并再次导入。</div>
            <div class="stats" style="grid-template-columns:1fr 1fr;">
              <div class="stat">
                <div class="label" data-i18n="up.state">状态</div>
                <div class="value"><span id="up-session">—</span></div>
                <div class="sub" id="up-session-sub"></div>
              </div>
              <div class="stat">
                <div class="label" data-i18n="stat.upstream">上游地址</div>
                <div class="value" id="up-upstream">—</div>
                <div class="sub" id="up-upstream-sub"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Page: API Keys ============ -->
        <!-- ============ 页面：API 管理 ============ -->
        <section class="page" id="page-keys">
          <div class="page-head">
            <h2 data-i18n="nav.keys">API 管理</h2>
            <p data-i18n="keys.subtitle">生成与管理客户端使用的 API Key。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="keys.title">管理 API Key</span></h3>
            <div class="desc">
              <span data-i18n="keys.desc1">客户端使用以下 API Key 访问 </span><span class="mono" id="api-base-desc"></span><span data-i18n="keys.desc2">。完整 Key 仅在创建时显示一次。</span>
            </div>
            <div class="grid2" style="max-width:420px;">
              <div class="form-row" style="margin-bottom:0;">
                <label class="lbl" data-i18n="keys.name_label">Key 名称（必填）</label>
                <input id="key-name" data-i18n-ph="keys.name_ph" placeholder="如：Cherry Studio" />
              </div>
              <div class="form-row" style="margin-bottom:0; display:flex; align-items:flex-end;">
                <button class="btn btn-primary" style="width:100%;" onclick="createKey()" data-i18n="keys.create">生成 Key</button>
              </div>
            </div>
            <div style="margin-top:18px;">
              <table class="table">
                <thead><tr>
                  <th data-i18n="keys.th_name">名称</th>
                  <th data-i18n="keys.th_key">Key</th>
                  <th data-i18n="keys.th_created">创建时间</th>
                  <th data-i18n="keys.th_used">最近使用</th>
                  <th style="text-align:right" data-i18n="common.actions">操作</th>
                </tr></thead>
                <tbody id="key-tbody"><tr><td colspan="5" class="empty" data-i18n="common.loading">加载中…</td></tr></tbody>
              </table>
            </div>
            <div class="banner" id="keys-banner"></div>
          </div>
        </section>

        <!-- ============ Page: Settings ============ -->
        <!-- ============ 页面：网页设置 ============ -->
        <section class="page" id="page-settings">
          <div class="page-head">
            <h2 data-i18n="nav.settings">网页设置</h2>
            <p data-i18n="set.subtitle">控制台自身账号与安全配置。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="set.pw_title">密码设置</span></h3>
            <div class="desc" data-i18n="set.pw_desc">管理控制台的登录密码。修改后所有已登录的管理会话将失效，需重新登录。</div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-label" data-i18n="set.pw_src_label">当前密码储存位置</div>
                <div class="setting-value"><span id="pw-src-badge" class="badge gray">—</span></div>
              </div>
              <button class="btn btn-primary" style="width:auto;" onclick="openPwModal()" data-i18n="set.pw_change">修改密码</button>
            </div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="set.lang_title">语言设置</span></h3>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-label" data-i18n="set.lang_label">界面语言</div>
                <div class="setting-hint" data-i18n="set.lang_hint">手动选择优先于浏览器语言；未选择时自动检测，默认英文。</div>
              </div>
              <select id="lang-select" style="width:180px;" onchange="switchLang(this.value)">
                <option value="en" data-i18n="set.lang_en">English</option>
                <option value="zh-CN" data-i18n="set.lang_zh">简体中文</option>
              </select>
            </div>
          </div>
        </section>

      </div>
    </main>
  </div>
</div>

<!-- Modal: show generated key -->
<!-- 弹窗：展示新生成的 Key -->
<div class="modal-mask" id="key-modal">
  <div class="modal">
    <h4 data-i18n="km.title">API Key 已生成</h4>
    <div class="note" data-i18n="km.note">请立即复制保存，关闭后将无法再次查看完整 Key。</div>
    <div class="key-box" id="key-modal-value"></div>
    <div class="btn-row">
      <button class="btn btn-primary" style="flex:1;" onclick="copyText(document.getElementById('key-modal-value').textContent, t('msg.copied'))" data-i18n="common.copy">复制</button>
      <button class="btn btn-ghost" onclick="closeModal()" data-i18n="common.close">关闭</button>
    </div>
  </div>
</div>

<!-- Modal: change password -->
<!-- 弹窗：修改密码 -->
<div class="modal-mask" id="pw-modal">
  <div class="modal">
    <h4 data-i18n="pm.title">修改管理密码</h4>
    <div class="note" data-i18n="pm.note">修改后密码将保存于 KV 并立即生效，所有已登录的管理会话将失效，需使用新密码重新登录。</div>
    <div class="form-row">
      <label class="lbl" data-i18n="pm.cur">当前密码</label>
      <input id="pw-cur" type="password" data-i18n-ph="pm.cur_ph" placeholder="当前密码" autocomplete="current-password" />
    </div>
    <div class="form-row">
      <label class="lbl" data-i18n="pm.new">新密码（至少 8 位）</label>
      <input id="pw-new" type="password" data-i18n-ph="pm.new_ph" placeholder="新密码（至少 8 位）" autocomplete="new-password" />
    </div>
    <div class="form-row">
      <label class="lbl" data-i18n="pm.new2">确认新密码</label>
      <input id="pw-new2" type="password" data-i18n-ph="pm.new2_ph" placeholder="确认新密码" autocomplete="new-password" />
    </div>
    <div class="banner" id="pw-modal-banner"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-submit-pw" style="flex:1;" onclick="submitPasswordChange()" data-i18n="pm.submit">确认修改</button>
      <button class="btn btn-ghost" onclick="closePwModal()" data-i18n="common.cancel">取消</button>
    </div>
  </div>
</div>

<script>
  var VERSION = "${VERSION}";

  function $(id) { return document.getElementById(id); }

  // ---------- i18n ----------
  // ---------- 国际化 ----------
  var I18N = {
    'zh-CN': {
      'app.title': 'Open WebUI 代理控制台',
      'brand.name': 'Open WebUI 代理控制台',
      'login.subtitle': '将 Open WebUI 反代为 OpenAI 兼容 API',
      'login.subtitle_setup': '首次使用，请先设置管理密码',
      'login.pw_ph': '管理密码',
      'login.pw1_ph': '设置管理密码（至少 8 位）',
      'login.pw2_ph': '确认管理密码',
      'login.btn': '登 录',
      'login.setup_btn': '设置密码并进入',
      'login.err_short': '密码长度至少 8 位',
      'login.err_mismatch': '两次输入的密码不一致',
      'nav.logout': '退出登录',
      'nav.label': '导航',
      'nav.dashboard': '仪表盘',
      'nav.upstream': '上游服务端',
      'nav.keys': 'API 管理',
      'nav.settings': '网页设置',
      'nav.foot1': '登录后可管理上游凭证、',
      'nav.foot2': 'API Key 与控制台设置。',
      'dash.subtitle': '代理服务整体运行状态一览。',
      'stat.session': 'Session 凭证',
      'stat.upstream': '上游地址',
      'stat.keys': 'API Key 数量',
      'stat.keys_sub': '生成的客户端密钥',
      'dash.access_title': '客户端接入',
      'dash.access_desc': '在任何 OpenAI 兼容客户端中使用以下地址与密钥接入本代理。',
      'dash.chip_title': '客户端接入地址，点击复制',
      'dash.copy': '复制',
      'up.subtitle': '导入并管理 Open WebUI 的 Session 凭证。',
      'up.import_title': '导入 Session',
      'up.import_desc': '在本地运行 <code>python login.py --base-url https://你的-open-webui 地址</code>，完成浏览器登录后，将终端输出的 <b>session.json 全部 JSON 内容</b> 粘贴到下方并导入。',
      'up.json_label': 'session.json 内容',
      'up.test': '校验并测试连通',
      'up.import': '导入 Session',
      'up.status_title': '当前凭证状态',
      'up.status_desc': '最近一次导入的凭证摘要，凭证过期后请重新登录上游并再次导入。',
      'up.state': '状态',
      'st.imported': '已导入',
      'st.unusable': '凭证不可用',
      'st.not_imported': '未导入',
      'st.not_imported_hint': '请先导入 session.json',
      'up.import_ok': '导入成功。',
      'up.import_summary': ' 凭证摘要：',
      'up.test_ok': '直连连通（前缀 {prefix}，HTTP {status}）',
      'up.test_http': '上游返回 HTTP {status}（前缀 {prefix}），凭证可能已过期',
      'up.test_network': '无法连接上游：{error}',
      'up.test_404': '所有候选前缀均返回 404，请确认地址指向 Open WebUI',
      'err.need_setup': '管理员密码尚未设置，请先完成首次设置。',
      'err.too_many': '登录失败次数过多，请稍后重试。',
      'err.wrong_password': '密码错误。',
      'err.not_logged_in': '未登录或会话已过期。',
      'err.unknown_endpoint': '未知的管理接口。',
      'err.pw_too_short': '密码长度至少 8 位。',
      'err.pw_mismatch': '两次输入的密码不一致。',
      'err.pw_cur_required': '请填写当前密码。',
      'err.pw_new_required': '请填写新密码。',
      'err.pw_cur_wrong': '当前密码不正确。',
      'err.pw_new_short': '新密码长度至少 8 位。',
      'err.pw_new_same': '新密码不能与当前密码相同。',
      'err.pw_change_failed': '修改密码失败。',
      'err.setup_failed': '设置密码失败。',
      'err.setup_secret_exists': '管理员密码已由部署配置（ADMIN_PASSWORD）提供，无需在网页设置。',
      'err.already_setup': '管理员密码已设置。',
      'err.session_empty': '请粘贴 session.json 的 JSON 内容。',
      'err.session_json_bad': 'JSON 解析失败，请检查粘贴内容。',
      'err.session_format_bad': '内容格式不正确，应为 JSON 对象。',
      'err.session_missing_credentials': '缺少 Authorization 与 Cookie（至少需要其一）。',
      'err.session_bad_base_url': 'base_url 缺失或不是合法地址（需 http/https 开头）。',
      'err.key_missing': '缺少要删除的 API Key。',
      'err.key_name_required': '请填写 Key 名称。',
      'err.key_name_duplicate': '已存在同名 Key，请更换名称。',
      'up.del_confirm': '确认删除已导入的 Session？客户端将无法使用代理。',
      'up.deleted': 'Session 已删除',
      'keys.subtitle': '生成与管理客户端使用的 API Key。',
      'keys.title': '管理 API Key',
      'keys.desc1': '客户端使用以下 API Key 访问 ',
      'keys.desc2': '。完整 Key 仅在创建时显示一次。',
      'keys.name_label': 'Key 名称（必填）',
      'keys.name_ph': '如：Cherry Studio',
      'keys.create': '生成 Key',
      'keys.th_name': '名称',
      'keys.th_key': 'Key',
      'keys.th_created': '创建时间',
      'keys.th_used': '最近使用',
      'keys.never_used': '从未使用',
      'keys.empty': '暂无 API Key',
      'keys.del_confirm': '确认删除 Key ',
      'keys.del_confirm_end': '？',
      'keys.deleted': 'Key 已删除',
      'set.subtitle': '控制台自身账号与安全配置。',
      'set.pw_title': '密码设置',
      'set.pw_desc': '管理控制台的登录密码。修改后所有已登录的管理会话将失效，需重新登录。',
      'set.pw_src_label': '当前密码储存位置',
      'set.src_secret': 'Secret（ADMIN_PASSWORD）',
      'set.src_kv': 'KV（控制台修改）',
      'set.src_none': '未设置',
      'set.pw_change': '修改密码',
      'set.lang_title': '语言设置',
      'set.lang_label': '界面语言',
      'set.lang_hint': '手动选择优先于浏览器语言；未选择时自动检测，默认英文。',
      'set.lang_zh': '简体中文',
      'set.lang_en': 'English',
      'set.lang_saved': '语言偏好已保存',
      'km.title': 'API Key 已生成',
      'km.note': '请立即复制保存，关闭后将无法再次查看完整 Key。',
      'pm.title': '修改管理密码',
      'pm.note': '修改后密码将保存于 KV 并立即生效，所有已登录的管理会话将失效，需使用新密码重新登录。',
      'pm.cur': '当前密码',
      'pm.new': '新密码（至少 8 位）',
      'pm.new2': '确认新密码',
      'pm.cur_ph': '请输入当前密码',
      'pm.new_ph': '请输入新密码（至少 8 位）',
      'pm.new2_ph': '请再次输入新密码',
      'pm.submit': '确认修改',
      'pm.confirm_secret': '当前管理员密码来自 Cloudflare Secret（ADMIN_PASSWORD）。\\n\\n在此修改会把生效密码覆盖为 KV 中保存的新密码，之后该 Secret 将不再被使用（除非把 Secret 改成与新密码一致）。\\n如不想覆盖，请前往 Cloudflare Dashboard 更新 Secret。\\n\\n确定要继续吗？',
      'msg.copied': '已复制',
      'msg.copy_failed': '复制失败',
      'msg.processing': ' 处理中…',
      'msg.session_expired': '登录已过期，请重新登录',
      'msg.fill_cur': '请填写当前密码',
      'msg.pw_short': '新密码长度至少 8 位',
      'msg.pw_same': '新密码不能与当前密码相同',
      'msg.pw_mismatch': '两次输入的新密码不一致',
      'msg.pw_changed': '密码已修改，所有旧会话已失效，请使用新密码重新登录',
      'common.delete': '删除',
      'common.copy': '复制',
      'common.close': '关闭',
      'common.cancel': '取消',
      'common.loading': '加载中…',
      'common.actions': '操作',
      'common.show_pw': '显示/隐藏密码'
    },
    'en': {
      'app.title': 'Open WebUI Proxy Console',
      'brand.name': 'Open WebUI Proxy Console',
      'login.subtitle': 'Expose Open WebUI as an OpenAI-compatible API',
      'login.subtitle_setup': 'First run — set an admin password',
      'login.pw_ph': 'Admin password',
      'login.pw1_ph': 'Set admin password (min 8 chars)',
      'login.pw2_ph': 'Confirm admin password',
      'login.btn': 'Sign In',
      'login.setup_btn': 'Set Password and Continue',
      'login.err_short': 'Password must be at least 8 characters',
      'login.err_mismatch': 'Passwords do not match',
      'nav.logout': 'Sign Out',
      'nav.label': 'Navigation',
      'nav.dashboard': 'Dashboard',
      'nav.upstream': 'Upstream Server',
      'nav.keys': 'API Management',
      'nav.settings': 'Settings',
      'nav.foot1': 'Manage upstream credentials,',
      'nav.foot2': 'API keys and console settings after signing in.',
      'dash.subtitle': 'Overview of the proxy service status.',
      'stat.session': 'Session Credential',
      'stat.upstream': 'Upstream URL',
      'stat.keys': 'API Keys',
      'stat.keys_sub': 'Client keys generated',
      'dash.access_title': 'Client Access',
      'dash.access_desc': 'Use the address and key below in any OpenAI-compatible client.',
      'dash.chip_title': 'Client base URL, click to copy',
      'dash.copy': 'Copy',
      'up.subtitle': 'Import and manage Open WebUI session credentials.',
      'up.import_title': 'Import Session',
      'up.import_desc': 'Run <code>python login.py --base-url https://your-open-webui-url</code> locally and finish the browser login, then paste the <b>full JSON content of session.json</b> below and import.',
      'up.json_label': 'session.json Content',
      'up.test': 'Validate and Test',
      'up.import': 'Import Session',
      'up.status_title': 'Current Credential Status',
      'up.status_desc': 'Summary of the last imported credential. If it expires, sign in upstream again and re-import.',
      'up.state': 'Status',
      'st.imported': 'Imported',
      'st.unusable': 'Credential unusable',
      'st.not_imported': 'Not imported',
      'st.not_imported_hint': 'Import session.json first',
      'up.import_ok': 'Import succeeded. ',
      'up.import_summary': ' Credential summary: ',
      'up.test_ok': 'Direct connection OK (prefix {prefix}, HTTP {status})',
      'up.test_http': 'Upstream returned HTTP {status} (prefix {prefix}); credentials may have expired',
      'up.test_network': 'Cannot connect to upstream: {error}',
      'up.test_404': 'All candidate prefixes returned 404; please verify the URL points to Open WebUI',
      'err.need_setup': 'Admin password is not set. Complete the first-time setup first.',
      'err.too_many': 'Too many failed attempts. Please try again later.',
      'err.wrong_password': 'Incorrect password.',
      'err.not_logged_in': 'Not signed in or session expired.',
      'err.unknown_endpoint': 'Unknown admin endpoint.',
      'err.pw_too_short': 'Password must be at least 8 characters.',
      'err.pw_mismatch': 'Passwords do not match.',
      'err.pw_cur_required': 'Please enter the current password.',
      'err.pw_new_required': 'Please enter the new password.',
      'err.pw_cur_wrong': 'Current password is incorrect.',
      'err.pw_new_short': 'New password must be at least 8 characters.',
      'err.pw_new_same': 'New password must differ from the current one.',
      'err.pw_change_failed': 'Failed to change password.',
      'err.setup_failed': 'Failed to set password.',
      'err.setup_secret_exists': 'The admin password is already provided by the deployment config (ADMIN_PASSWORD); no need to set it here.',
      'err.already_setup': 'Admin password is already set.',
      'err.session_empty': 'Please paste the JSON content of session.json.',
      'err.session_json_bad': 'JSON parsing failed. Please check the pasted content.',
      'err.session_format_bad': 'Invalid content format; expected a JSON object.',
      'err.session_missing_credentials': 'Missing Authorization and Cookie (at least one is required).',
      'err.session_bad_base_url': 'base_url is missing or not a valid URL (must start with http/https).',
      'err.key_missing': 'Missing the API key to delete.',
      'err.key_name_required': 'Please enter a key name.',
      'err.key_name_duplicate': 'A key with the same name already exists. Choose another.',
      'up.del_confirm': 'Delete the imported session? Clients will no longer be able to use the proxy.',
      'up.deleted': 'Session deleted',
      'keys.subtitle': 'Generate and manage client API keys.',
      'keys.title': 'Manage API Keys',
      'keys.desc1': 'Clients use these API keys to access ',
      'keys.desc2': '. The full key is shown only once at creation.',
      'keys.name_label': 'Key Name (Required)',
      'keys.name_ph': 'e.g. Cherry Studio',
      'keys.create': 'Generate Key',
      'keys.th_name': 'Name',
      'keys.th_key': 'Key',
      'keys.th_created': 'Created',
      'keys.th_used': 'Last Used',
      'keys.never_used': 'Never Used',
      'keys.empty': 'No API Keys Yet',
      'keys.del_confirm': 'Delete key ',
      'keys.del_confirm_end': '?',
      'keys.deleted': 'Key deleted',
      'set.subtitle': 'Console account and security configuration.',
      'set.pw_title': 'Password',
      'set.pw_desc': 'Manage the console login password. Changing it signs out all admin sessions.',
      'set.pw_src_label': 'Current Password Storage',
      'set.src_secret': 'Secret (ADMIN_PASSWORD)',
      'set.src_kv': 'KV (changed in console)',
      'set.src_none': 'Not set',
      'set.pw_change': 'Change Password',
      'set.lang_title': 'Language',
      'set.lang_label': 'Interface Language',
      'set.lang_hint': 'Manual choice overrides browser language; otherwise auto-detected, English fallback.',
      'set.lang_zh': '简体中文',
      'set.lang_en': 'English',
      'set.lang_saved': 'Language preference saved',
      'km.title': 'API Key Generated',
      'km.note': 'Copy and store it now — the full key cannot be viewed again after closing.',
      'pm.title': 'Change Admin Password',
      'pm.note': 'The new password is stored in KV and takes effect immediately; all admin sessions will be signed out.',
      'pm.cur': 'Current Password',
      'pm.new': 'New Password (min 8 chars)',
      'pm.new2': 'Confirm New Password',
      'pm.cur_ph': 'Enter current password',
      'pm.new_ph': 'Enter new password (min 8 chars)',
      'pm.new2_ph': 'Re-enter new password',
      'pm.submit': 'Confirm Change',
      'pm.confirm_secret': 'The admin password currently comes from the Cloudflare Secret (ADMIN_PASSWORD).\\n\\nChanging it here overrides the effective password with the new one stored in KV; the Secret will no longer be used (unless you set the Secret to the same new value).\\nTo keep using the Secret, update it in the Cloudflare Dashboard instead.\\n\\nContinue?',
      'msg.copied': 'Copied',
      'msg.copy_failed': 'Copy failed',
      'msg.processing': ' Working…',
      'msg.session_expired': 'Session expired, please sign in again',
      'msg.fill_cur': 'Please enter the current password',
      'msg.pw_short': 'New password must be at least 8 characters',
      'msg.pw_same': 'New password must differ from the current one',
      'msg.pw_mismatch': 'Passwords do not match',
      'msg.pw_changed': 'Password changed. All old sessions are signed out — sign in with the new password.',
      'common.delete': 'Delete',
      'common.copy': 'Copy',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.loading': 'Loading…',
      'common.actions': 'Actions',
      'common.show_pw': 'Show/Hide Password'
    }
  };

  var _lang = 'en';

  function t(key) {
    var d = I18N[_lang] || I18N['en'];
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    if (Object.prototype.hasOwnProperty.call(I18N['en'], key)) return I18N['en'][key];
    return key;
  }

  // Translate an API error code; falls back to the raw text when unknown
  // 翻译 API 错误码；未知时回退为原始文本
  function etext(m) {
    if (m && Object.prototype.hasOwnProperty.call(I18N[_lang] || I18N['en'], m)) return t(m);
    if (m && Object.prototype.hasOwnProperty.call(I18N['en'], m)) return I18N['en'][m];
    return m;
  }

  // Simple {placeholder} interpolation on a translation key
  // 对翻译键做简单的 {占位符} 插值
  function tfmt(key, params) {
    var s = t(key);
    if (params) {
      for (var p in params) {
        if (Object.prototype.hasOwnProperty.call(params, p)) s = s.split('{' + p + '}').join(String(params[p]));
      }
    }
    return s;
  }

  // Compose a localized message from the structured connectivity test result
  // 根据结构化的连通性测试结果拼出本地化消息
  function testDetail(tst) {
    if (!tst) return '';
    if (tst.code === 'up.test_network') return tfmt('up.test_network', { error: tst.error || '' });
    if (tst.code === 'up.test_ok' || tst.code === 'up.test_http') {
      return tfmt(tst.code, { prefix: tst.prefix || '', status: tst.status == null ? '' : tst.status });
    }
    return t(tst.code);
  }

  // Manual setting > browser language > English fallback
  // 手动选择 > 浏览器语言 > 英文回退
  function detectLang() {
    try {
      var saved = localStorage.getItem('admin_lang');
      if (saved && I18N[saved]) return saved;
    } catch (e) {}
    var langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i] || '').toLowerCase();
      if (l.indexOf('zh') === 0) return 'zh-CN';
      if (l.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  function applyI18n() {
    document.documentElement.lang = _lang;
    document.title = t('app.title');
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    var htmlNodes = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlNodes.length; j++) htmlNodes[j].innerHTML = t(htmlNodes[j].getAttribute('data-i18n-html'));
    var phNodes = document.querySelectorAll('[data-i18n-ph]');
    for (var k = 0; k < phNodes.length; k++) phNodes[k].setAttribute('placeholder', t(phNodes[k].getAttribute('data-i18n-ph')));
    var titleNodes = document.querySelectorAll('[data-i18n-title]');
    for (var m = 0; m < titleNodes.length; m++) titleNodes[m].setAttribute('title', t(titleNodes[m].getAttribute('data-i18n-title')));
    var ariaNodes = document.querySelectorAll('[data-i18n-aria]');
    for (var n = 0; n < ariaNodes.length; n++) ariaNodes[n].setAttribute('aria-label', t(ariaNodes[n].getAttribute('data-i18n-aria')));
  }

  function switchLang(v) {
    if (!I18N[v] || v === _lang) return;
    _lang = v;
    try { localStorage.setItem('admin_lang', v); } catch (e) {}
    applyI18n();
    for (var id in _bannerRenderers) {
      if (Object.prototype.hasOwnProperty.call(_bannerRenderers, id)) {
        var r = _bannerRenderers[id]();
        showBanner(id, r.msg, r.type);
      }
    }
    if (_loginMsgRender) setLoginMsg(_loginMsgRender);
    loadStatus();
    loadKeys();
    toast(t('set.lang_saved'), 'ok');
  }

  function toast(msg, type) {
    var t2 = document.createElement('div');
    t2.className = 'toast ' + (type || '');
    t2.textContent = msg;
    $('toasts').appendChild(t2);
    requestAnimationFrame(function () { t2.classList.add('show'); });
    setTimeout(function () {
      t2.classList.remove('show');
      setTimeout(function () { t2.remove(); }, 350);
    }, 3200);
  }

  // Banner render registry: lets switchLang() re-render visible banners in the new language
  // 横幅渲染注册表：让 switchLang() 在切换语言后以新语言重渲染可见横幅
  var _bannerRenderers = {};

  function showBanner(id, msg, type) {
    var el = $(id);
    el.className = 'banner ' + (type || 'info');
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }
  // render() is invoked lazily so the message re-translates when the language changes
  // render() 延迟调用，语言切换时消息可重新翻译
  function setBanner(id, type, render) {
    _bannerRenderers[id] = function () { return { msg: render(), type: type }; };
    showBanner(id, render(), type);
  }
  function clearBanner(id) {
    delete _bannerRenderers[id];
    var el = $(id); el.className = 'banner'; el.textContent = ''; el.style.display = 'none';
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + t('msg.processing');
    } else {
      btn.disabled = false;
      if (btn.dataset.orig) { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && data.needLogin) {
      toast(t('msg.session_expired'), 'warn');
      showLogin();
      throw new Error('not authed');
    }
    if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- copy ----------
  // ---------- 复制 ----------
  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(msg || t('msg.copied'), 'ok');
      }, function () { fallbackCopy(text, msg); });
    } else { fallbackCopy(text, msg); }
  }
  function fallbackCopy(text, msg) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg || t('msg.copied'), 'ok'); } catch (e) { toast(t('msg.copy_failed'), 'err'); }
    document.body.removeChild(ta);
  }

  // ---------- views ----------
  // ---------- 视图切换 ----------
  function showLogin() {
    $('view-login').style.display = 'flex';
    $('view-panel').classList.remove('show');
  }
  function showPanel() {
    $('view-login').style.display = 'none';
    $('view-panel').classList.add('show');
    switchPage('dashboard');
    loadStatus();
    loadKeys();
  }

  // ---------- page switching ----------
  // ---------- 页面切换 ----------
  function switchPage(name) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
    var items = document.querySelectorAll('.side-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', items[j].getAttribute('data-page') === name);
    }
    var page = $('page-' + name);
    if (page) page.classList.add('active');
  }

  // ---------- login / setup ----------
  // ---------- 登录 / 首次设密 ----------
  document.addEventListener('DOMContentLoaded', function () {
    // password visibility toggles
    // 密码可见性切换按钮
    document.querySelectorAll('.eye').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = $(btn.dataset.target);
        input.type = input.type === 'password' ? 'text' : 'password';
      });
    });

    $('form-login').addEventListener('submit', function (e) {
      e.preventDefault();
      login();
    });
    $('form-setup').addEventListener('submit', function (e) {
      e.preventDefault();
      setup();
    });

    // decide login vs setup mode
    // 判断显示登录还是首次设密模式
    api('/admin/api/status').then(function (data) {
      var needsSetup = data.adminPasswordMode === 'none';
      if (needsSetup) {
        $('form-login').style.display = 'none';
        $('form-setup').style.display = 'block';
        $('login-sub').setAttribute('data-i18n', 'login.subtitle_setup');
        $('login-sub').textContent = t('login.subtitle_setup');
      } else {
        showPanel();
      }
    }).catch(function (err) {
      setLoginMsg(function () { return etext(err.message); });
    });
  });

  var _loginMsgRender = null;

  function setLoginMsg(render) {
    _loginMsgRender = render;
    var el = $('login-msg');
    el.textContent = render();
    el.className = 'hint err';
  }

  function login() {
    var btn = $('btn-login');
    setLoading(btn, true);
    api('/admin/api/login', { method: 'POST', body: { password: $('pw').value } })
      .then(function () { showPanel(); })
      .catch(function (err) { setLoginMsg(function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function setup() {
    var btn = $('btn-setup');
    var p1 = $('pw1').value, p2 = $('pw2').value;
    if (p1.length < 8) { setLoginMsg(function () { return t('login.err_short'); }); return; }
    if (p1 !== p2) { setLoginMsg(function () { return t('login.err_mismatch'); }); return; }
    setLoading(btn, true);
    api('/admin/api/setup', { method: 'POST', body: { password: p1, confirm: p2 } })
      .then(function () { showPanel(); })
      .catch(function (err) { setLoginMsg(function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function logout() {
    api('/admin/api/logout', { method: 'POST' }).then(function () {
      showLogin();
    }).catch(function () { showLogin(); });
  }

  // ---------- change password ----------
  // ---------- 修改密码 ----------
  var _pwSource = 'none';

  function updatePwSourceUI(s) {
    var src = (s && (s.passwordSource || s.adminPasswordMode)) || 'none';
    _pwSource = src;
    var badgeEl = $('pw-src-badge');
    if (!badgeEl) return;
    if (src === 'secret') {
      badgeEl.className = 'badge warn';
      badgeEl.textContent = t('set.src_secret');
    } else if (src === 'kv') {
      badgeEl.className = 'badge info';
      badgeEl.textContent = t('set.src_kv');
    } else {
      badgeEl.className = 'badge gray';
      badgeEl.textContent = t('set.src_none');
    }
  }

  function openPwModal() {
    clearBanner('pw-modal-banner');
    // Secret override warning: shown only after clicking the button, before the modal opens
    // Secret 覆盖警告：仅在点击按钮后、弹窗打开前显示
    if (_pwSource === 'secret' && !confirm(t('pm.confirm_secret'))) return;
    $('pw-modal').classList.add('show');
    setTimeout(function () { $('pw-cur').focus(); }, 60);
  }

  function closePwModal() {
    $('pw-modal').classList.remove('show');
    $('pw-cur').value = '';
    $('pw-new').value = '';
    $('pw-new2').value = '';
    clearBanner('pw-modal-banner');
  }

  function submitPasswordChange() {
    var btn = $('btn-submit-pw');
    var cur = $('pw-cur').value;
    var n1 = $('pw-new').value;
    var n2 = $('pw-new2').value;
    clearBanner('pw-modal-banner');
    if (!cur) { setBanner('pw-modal-banner', 'err', function () { return t('msg.fill_cur'); }); return; }
    if (n1.length < 8) { setBanner('pw-modal-banner', 'err', function () { return t('msg.pw_short'); }); return; }
    if (n1 === cur) { setBanner('pw-modal-banner', 'err', function () { return t('msg.pw_same'); }); return; }
    if (n1 !== n2) { setBanner('pw-modal-banner', 'err', function () { return t('msg.pw_mismatch'); }); return; }
    setLoading(btn, true);
    api('/admin/api/password', { method: 'POST', body: { current_password: cur, new_password: n1 } })
      .then(function () {
        toast(t('msg.pw_changed'), 'ok');
        closePwModal();
        showLogin();
      })
      .catch(function (err) { setBanner('pw-modal-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  // ---------- status ----------
  // ---------- 状态 ----------
  function badge(type, text) {
    return '<span class="badge ' + type + '">' + text + '</span>';
  }

  function fillSessionStatus(prefix, s) {
    if (s.session && s.session.imported) {
      $(prefix + '-session').innerHTML = s.session.usable ? badge('ok', t('st.imported')) : badge('err', t('st.unusable'));
      $(prefix + '-session-sub').textContent = s.session.summary || '';
      $(prefix + '-upstream').textContent = s.session.base_url || '—';
      $(prefix + '-upstream-sub').textContent = s.session.captured_at ? new Date(s.session.captured_at * 1000).toLocaleString() : '';
    } else {
      $(prefix + '-session').innerHTML = badge('err', t('st.not_imported'));
      $(prefix + '-session-sub').textContent = t('st.not_imported_hint');
      $(prefix + '-upstream').textContent = '—';
      $(prefix + '-upstream-sub').textContent = '';
    }
  }

  function loadStatus() {
    api('/admin/api/status').then(function (s) {
      // chip
      // 接入地址胶囊
      $('chip-url').textContent = s.baseUrl + '  ';
      $('api-base-desc').textContent = s.baseUrl;
      $('api-base-code').textContent = s.baseUrl;

      // dashboard session stat
      // 仪表盘 Session 状态
      fillSessionStatus('st', s);
      // upstream page status
      // 上游页面状态
      fillSessionStatus('up', s);

      // keys
      // Key 计数
      $('st-keys').textContent = String(s.apiKeys.count);
      $('nav-key-count').textContent = String(s.apiKeys.count);

      // admin password source badge
      // 管理密码来源徽标
      updatePwSourceUI(s);
    }).catch(function (err) {
      toast(etext(err.message), 'err');
    });
  }

  // ---------- session ----------
  // ---------- 会话凭证 ----------
  function testSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', { method: 'POST', body: { json: $('session-json').value, test: true, save: false } })
      .then(function (d) {
        setBanner('session-banner', d.test.ok ? 'ok' : 'warn', function () { return testDetail(d.test); });
      })
      .catch(function (err) { setBanner('session-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function importSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', { method: 'POST', body: { json: $('session-json').value, test: true, save: true } })
      .then(function (d) {
        setBanner('session-banner', 'ok', function () {
          return t('up.import_ok') + (d.test ? ' ' + testDetail(d.test) : '') + t('up.import_summary') + d.summary;
        });
        loadStatus();
      })
      .catch(function (err) { setBanner('session-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function deleteSession() {
    if (!confirm(t('up.del_confirm'))) return;
    api('/admin/api/session', { method: 'DELETE' })
      .then(function () { toast(t('up.deleted'), 'ok'); loadStatus(); clearBanner('session-banner'); })
      .catch(function (err) { toast(etext(err.message), 'err'); });
  }

  // ---------- api keys ----------
  // ---------- API Key ----------
  function createKey() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('keys-banner');
    var name = $('key-name').value.trim();
    if (!name) {
      setLoading(btn, false);
      setBanner('keys-banner', 'err', function () { return etext('err.key_name_required'); });
      return;
    }
    api('/admin/api/keys', { method: 'POST', body: { name: name } })
      .then(function (d) {
        $('key-name').value = '';
        $('key-modal-value').textContent = d.key;
        $('key-modal').classList.add('show');
        loadStatus();
        loadKeys();
      })
      .catch(function (err) { setBanner('keys-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function closeModal() { $('key-modal').classList.remove('show'); }

  var _keys = [];

  function loadKeys() {
    api('/admin/api/keys').then(function (d) {
      var tbody = $('key-tbody');
      if (!d.keys || !d.keys.length) {
        _keys = [];
        tbody.innerHTML = '<tr><td colspan="5" class="empty">' + t('keys.empty') + '</td></tr>';
        return;
      }
      _keys = d.keys;
      tbody.innerHTML = d.keys.map(function (k, i) {
        var created = new Date(k.created_at * 1000).toLocaleString();
        var used = k.last_used ? new Date(k.last_used * 1000).toLocaleString() : t('keys.never_used');
        return '<tr>' +
          '<td>' + esc(k.name) + '</td>' +
          '<td class="mono">' + esc(k.masked) + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + used + '</td>' +
          '<td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="deleteKey(' + i + ')">' + t('common.delete') + '</button></td>' +
          '</tr>';
      }).join('');
    }).catch(function (err) { toast(etext(err.message), 'err'); });
  }

  function deleteKey(i) {
    var k = _keys[i];
    if (!k) return;
    if (!confirm(t('keys.del_confirm') + '[' + k.name + ']' + t('keys.del_confirm_end'))) return;
    api('/admin/api/keys', { method: 'DELETE', body: { key: k.key } })
      .then(function () { toast(t('keys.deleted'), 'ok'); loadKeys(); loadStatus(); })
      .catch(function (err) { toast(etext(err.message), 'err'); });
  }

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // init language before first paint of dynamic content
  // 在动态内容首次渲染前初始化语言
  _lang = detectLang();
  applyI18n();
  (function () { var sel = $('lang-select'); if (sel) sel.value = _lang; })();

  // close modals on mask click / Escape
  // 点击遮罩或按 Escape 关闭弹窗
  $('key-modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  $('pw-modal').addEventListener('click', function (e) { if (e.target === this) closePwModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closePwModal(); }
  });
</script>
</body>
</html>`;
