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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23ff6b35'/%3E%3Cstop offset='0.55' stop-color='%23f6821f'/%3E%3Cstop offset='1' stop-color='%23fbad41'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='24' height='24' rx='6' fill='url(%23g)'/%3E%3Cg fill='none' stroke='%23ffffff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 7h11M4 12h8M4 17h13'/%3E%3Cpath d='M17 4l4 4-4 4'/%3E%3Cpath d='M13 10l4 4 4-4'/%3E%3C/g%3E%3C/svg%3E" />
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
    padding: 6px; border-radius: 8px; line-height: 0;
  }
  .field .eye:hover { color: var(--text-0); }
  .field .eye svg { width: 18px; height: 18px; display: block; }
  .field .eye .icon-eye-off { display: none; }
  .field .eye.showing .icon-eye { display: none; }
  .field .eye.showing .icon-eye-off { display: block; }

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
  .pw-src-row { gap: 4px; flex-wrap: wrap; }
  .pw-src-row .setting-label { margin-bottom: 0; }
  .pw-src-row .setting-label::after { content: ':'; margin-left: 2px; }
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
  /* Probe facts: one chip per capability, plus the parameters the engine accepted. */
  /* 探测事实：每个能力一个 chip，以及引擎未拒绝的请求参数。 */
  .mp-cap { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; margin: 0 4px 3px 0; white-space: nowrap; }
  .mp-cap.on { background: rgba(34, 197, 94, 0.14); color: #86efac; }
  .mp-cap.off { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }
  .mp-params { font-family: var(--mono); font-size: 11.5px; color: var(--text-1); line-height: 1.65; word-break: break-word; max-width: 260px; }

  .banner { border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-top: 14px; line-height: 1.5; display: none; }
  .banner.ok { display: block; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.25); color: #86efac; }
  .banner.err { display: block; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); color: #fca5a5; }
  .banner.warn { display: block; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.25); color: #fcd34d; }
  .banner.info { display: block; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.25); color: #93c5fd; }

  /* Smooth collapse/expand: 0fr->1fr grid rows transition, height-agnostic.
     平滑折叠/展开：0fr->1fr 的 grid 行过渡，内容高度自适应。 */
  .collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.35s ease; }
  .collapse.open { grid-template-rows: 1fr; }
  .collapse > div { overflow: hidden; min-height: 0; }

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
          <button type="button" class="eye" data-target="pw" aria-label="show/hide password" data-i18n-aria="common.show_pw">
            <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
        </div>
        <button class="btn btn-primary" id="btn-login" type="submit" data-i18n="login.btn">登 录</button>
      </form>
      <form id="form-setup" style="display:none" autocomplete="new-password">
        <div class="field">
          <input id="pw1" type="password" data-i18n-ph="login.pw1_ph" placeholder="设置管理密码（至少 8 位）" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw1" aria-label="show/hide password" data-i18n-aria="common.show_pw">
            <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
        </div>
        <div class="field">
          <input id="pw2" type="password" data-i18n-ph="login.pw2_ph" placeholder="确认管理密码" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw2" aria-label="show/hide password" data-i18n-aria="common.show_pw">
            <svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
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
            <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
              <div style="flex:1; min-width:0;">
                <h3><span class="ic">▸</span> <span data-i18n="up.status_title">当前凭证状态</span></h3>
                <div class="desc" style="margin-bottom:0;" data-i18n="up.status_desc">最近一次导入的凭证摘要，凭证过期后请重新登录上游并再次导入。</div>
              </div>
              <button class="btn btn-ghost" style="width:auto; flex:none; margin:12px 0;" onclick="checkSession()" data-i18n="up.check_session">检测 Session 连通性</button>
              <button class="btn btn-danger" style="width:auto; flex:none; margin:12px 0;" onclick="deleteSession()" data-i18n="up.delete_session">删除 Session</button>
            </div>
            <div class="stats" style="grid-template-columns:1fr 1fr; margin-top:16px;">
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
            <div class="banner" id="status-banner"></div>
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
            </div>
            <div class="banner" id="session-banner"></div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="mp.title">模型探测</span></h3>
            <div class="desc" data-i18n="mp.desc">逐模型探测上游引擎真正接受什么：每个思考挡位都用真实请求实证，视觉 / 函数调用 / 结构化输出等能力同样来自引擎。结果体现在 /v1/models 的 capabilities、supported_parameters、reasoning 与 architecture。</div>

            <div class="setting-row" style="margin-bottom:12px;">
              <div class="setting-info">
                <div class="setting-label" data-i18n="mp.enabled_label">启用模型探测</div>
                <div class="setting-hint" data-i18n="mp.enabled_hint">关闭后不发起探测，也不会在 /v1/models 中返回 reasoning 字段。</div>
              </div>
              <select id="mp-enabled-select" style="width:180px;" onchange="saveProbeEnabled(this.value)">
                <option value="on" data-i18n="mp.on">开启</option>
                <option value="off" data-i18n="mp.off">关闭</option>
              </select>
            </div>

            <div id="mp-detail" class="collapse"><div>
              <div class="setting-row" style="margin-bottom:12px;">
                <div class="setting-info">
                  <div class="setting-label" data-i18n="mp.refresh_label">每轮子请求预算</div>
                  <div class="setting-hint" data-i18n="mp.refresh_hint">单轮探测最多消耗的上游子请求数。免费层每次调用上限 50，付费层 10,000；预算用完时协调者会用自身 alarm 继续，不需要客户端再触发。</div>
                </div>
                <select id="mp-budget-select" style="width:180px;" onchange="saveProbeBudget(this.value)"></select>
              </div>

              <div class="setting-row" style="margin-bottom:12px;">
                <div style="flex:1; min-width:300px;">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;">
                    <div class="setting-info">
                      <div class="setting-label" data-i18n="mp.params_title">探测参数</div>
                      <div class="setting-hint" data-i18n="mp.params_hint">此参数设置作用于所有探测。</div>
                    </div>
                    <button class="btn btn-primary" style="width:auto; flex:none;" onclick="saveProbeSettings()" data-i18n="mp.save">保存</button>
                  </div>
                  <div style="display:flex; flex-direction:column; gap:12px; margin-top:14px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.budget_label">自定义预算</div>
                        <div class="setting-hint" data-i18n="mp.budget_hint">与上方「每轮子请求预算」是同一个值：预设一键写入 40 / 2000，这里可填 4–9000 的任意数值，保存后上方显示为「自定义」。一个模型典型消耗约 10 个子请求，最坏约 20 个。</div>
                      </div>
                      <input id="mp-budget" type="number" min="4" max="9000" style="width:130px; flex:none;" placeholder="40" />
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.timeout_label">单模型超时</div>
                        <div class="setting-hint" data-i18n="mp.timeout_hint">每个模型探测请求的最长等待时间（1–120 秒）。</div>
                      </div>
                      <input id="mp-timeout" type="number" min="1" max="120" style="width:130px; flex:none;" placeholder="30" />
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.wait_label">等待时长</div>
                        <div class="setting-hint" data-i18n="mp.wait_hint">/v1/models 最多等待缺失模型探测完成的时长（0–30 秒，0 为不等待）。</div>
                      </div>
                      <input id="mp-wait" type="number" min="0" max="30" style="width:130px; flex:none;" placeholder="5" />
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.expose_label">实例元信息</div>
                        <div class="setting-hint" data-i18n="mp.expose_hint">在 /v1/models 信封中输出上游部署的 name / version / features 与共享能力模板（x_open_webui）。</div>
                      </div>
                      <select id="mp-expose-select" style="width:130px; flex:none;" onchange="saveProbeExpose(this.value)">
                        <option value="on" data-i18n="mp.on">开启</option>
                        <option value="off" data-i18n="mp.off">关闭</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div class="setting-row" style="display:block;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:12px;">
                  <div class="setting-info">
                    <div class="setting-label" data-i18n="mp.cache_title">已缓存的模型及其探测结果</div>
                    <div class="setting-hint" data-i18n="mp.cache_hint">列出已探测的模型与状态：正常（结论完整）、部分结论（有请求未得出答案，会按退避重试）、不可探测（上游从不校验该字段）、失败待重试。能力与最后错误显示在挡位下方。</div>
                  </div>
                  <button class="btn btn-ghost" style="width:auto; flex:none;" onclick="refreshProbe()" data-i18n="mp.refresh">立即探测</button>
                </div>
                <!-- The round banner sits with the button that triggers it (and above the
                     table it describes) instead of above the section heading, where it
                     looked disconnected from "立即探测". -->
                <!-- 轮次横幅与触发它的按钮同处一块（并在它所描述的表格上方），而不再挂在
                     小节标题之上、看上去与「立即探测」无关。 -->
                <div class="banner" id="mp-banner"></div>
                <table class="table">
                  <thead><tr>
                    <th data-i18n="mp.th_model">模型</th>
                    <th data-i18n="mp.th_efforts">支持挡位</th>
                    <th data-i18n="mp.th_caps">能力字段</th>
                    <th data-i18n="mp.th_params">支持参数</th>
                    <th data-i18n="mp.th_probed">探测时间</th>
                    <th data-i18n="mp.th_status">状态</th>
                  </tr></thead>
                  <tbody id="mp-tbody"><tr><td colspan="6" class="empty" data-i18n="common.loading">加载中…</td></tr></tbody>
                </table>
              </div>
            </div></div>
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
            <div style="display:flex; align-items:center; gap:14px;">
              <div style="flex:1; min-width:0;">
                <h3><span class="ic">▸</span> <span data-i18n="keys.title">管理 API Key</span></h3>
                <div class="desc" style="margin-bottom:0;">
                  <span data-i18n="keys.desc1">客户端使用以下 API Key 访问 </span><span class="mono" id="api-base-desc"></span><span data-i18n="keys.desc2">。完整 Key 仅在创建时显示一次。</span>
                </div>
              </div>
              <button class="btn btn-primary" style="width:auto; flex:none; margin:12px 0;" onclick="openKeyModal()" data-i18n="keys.create">生成 Key</button>
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

          <div class="card">
            <h3><span class="ic">▸</span> <span data-i18n="set.touch_title">使用记录粒度</span></h3>
            <div class="desc" data-i18n="set.touch_desc">控制 API Key「最近使用」时间的 KV 写入频率。从未使用的 Key 首次调用会立即记录一次，之后按所选粒度更新；粒度越粗，KV 写入次数越少（免费层每日写入上限 1000 次）。</div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-label" data-i18n="set.touch_label">记录间隔</div>
                <div class="setting-hint" data-i18n="set.touch_hint">更改立即生效，无需重新部署。</div>
              </div>
              <select id="touch-interval-select" style="width:180px;" onchange="saveTouchInterval(this.value)"></select>
            </div>
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
                <div class="setting-value pw-src-row">
                  <span class="setting-label" data-i18n="set.pw_src_label">当前密码储存位置</span>
                  <span id="pw-src-badge" class="badge gray">—</span>
                </div>
                <div class="setting-hint" data-i18n="set.pw_src_hint">部署时通过 Secret（ADMIN_PASSWORD）提供的密码优先；若曾在控制台修改过密码，则以 KV 中保存的新密码为准，原 Secret 将不再生效。</div>
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

<!-- Modal: key name input before generation -->
<!-- 弹窗：生成前输入 Key 名称 -->
<div class="modal-mask" id="key-name-modal">
  <div class="modal">
    <h4 data-i18n="kn.title">生成 API Key</h4>
    <div class="note" data-i18n="kn.note">请输入 Key 名称，用于标识使用该 Key 的客户端。</div>
    <div class="form-row">
      <label class="lbl" data-i18n="keys.name_label">Key 名称（必填）</label>
      <input id="key-name-modal-input" data-i18n-ph="keys.name_ph" placeholder="如：Cherry Studio" onkeydown="if(event.key==='Enter'){event.preventDefault();submitCreateKey();}" />
    </div>
    <div class="banner" id="key-name-banner"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-submit-key" style="flex:1;" onclick="submitCreateKey()" data-i18n="kn.submit">确认生成</button>
      <button class="btn btn-ghost" onclick="closeKeyModal()" data-i18n="common.cancel">取消</button>
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
      'up.test_not_models': '所有候选前缀都没有返回模型列表（可能是被前端页面接管或状态码异常），请确认地址指向 Open WebUI',
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
      'up.check_session': '检测 Session 连通性',
      'up.delete_session': '删除 Session',
      'err.session_not_imported': '尚未导入 Session，请先在下方导入后再检测。',
      'keys.subtitle': '生成与管理客户端使用的 API Key。',
      'keys.title': '管理 API Key',
      'keys.desc1': '客户端使用以下 API Key 访问 ',
      'keys.desc2': '。完整 Key 仅在创建时显示一次。',
      'keys.name_label': 'Key 名称（必填）',
      'keys.name_ph': '如：Cherry Studio',
      'keys.create': '生成 Key',
      'kn.title': '生成 API Key',
      'kn.note': '请输入 Key 名称，用于标识使用该 Key 的客户端。',
      'kn.submit': '确认生成',
      'keys.th_name': '名称',
      'keys.th_key': 'Key',
      'keys.th_created': '创建时间',
      'keys.th_used': '最近使用',
      'keys.never_used': '从未使用',
      'keys.empty': '暂无 API Key',
      'keys.del_confirm': '确认删除 Key ',
      'keys.del_confirm_end': '？',
      'keys.deleted': 'Key 已删除',
      'keys.rotate': '轮转',
      'keys.rotate_confirm': '确认轮转 Key ',
      'keys.rotate_confirm_end': '？旧 Key 将立即失效，使用它的客户端需更换为新 Key。',
      'keys.rotated': 'Key 已轮转，旧 Key 已失效',
      'set.subtitle': '控制台自身账号与安全配置。',
      'set.pw_title': '密码设置',
      'set.pw_desc': '管理控制台的登录密码。修改后所有已登录的管理会话将失效，需重新登录。',
      'set.pw_src_label': '当前密码储存位置',
      'set.pw_src_hint': 'Secret（ADMIN_PASSWORD）仅在 KV 不存在相关记录时生效',
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
      'set.touch_title': '使用记录粒度',
      'set.touch_desc': '控制 API Key「最近使用」时间的 KV 写入频率。从未使用的 Key 首次调用会立即记录一次，之后按所选粒度更新；粒度越粗，KV 写入次数越少（免费层每日写入上限 1000 次）。',
      'set.touch_label': '记录间隔',
      'set.touch_hint': '更改立即生效，无需重新部署。',
      'set.touch_daily': '每天（默认）',
      'set.touch_6h': '每六小时',
      'set.touch_3h': '每三小时',
      'set.touch_hourly': '每小时',
      'set.touch_30m': '每三十分钟',
      'msg.touch_saved': '使用记录粒度已保存',
      'err.settings_invalid': '无效的设置值。',
      'mp.title': '模型探测',
      'mp.desc': '逐模型探测上游引擎真正接受什么：每个思考挡位都用真实请求实证，视觉 / 函数调用 / 结构化输出等能力同样来自引擎。结果体现在 /v1/models 的 capabilities、supported_parameters、reasoning 与 architecture。',
      'mp.enabled_label': '启用模型探测',
      'mp.enabled_hint': '关闭后不发起任何探测，/v1/models 也不再输出探测得出的字段（capabilities、supported_parameters、reasoning、architecture）。',
      'mp.on': '开启',
      'mp.off': '关闭',
      'mp.refresh_label': '每轮子请求预算',
      'mp.refresh_hint': '单轮探测最多消耗的上游子请求数。免费层每次调用上限 50，付费层 10,000；预算用完时协调者会用自身 alarm 继续，不需要客户端再触发。',
      'mp.params_title': '探测参数',
      'mp.params_hint': '此参数设置作用于所有探测。',
      'mp.cache_title': '已缓存的模型及其探测结果',
      'mp.cache_hint': '列出已探测的模型与状态：正常（结论完整）、部分结论（有请求未得出答案，会按退避重试）、不可探测（上游从不校验该字段）、失败待重试。能力与最后错误显示在挡位下方。',
      'mp.budget_label': '自定义预算',
      'mp.budget_hint': '与上方「每轮子请求预算」是同一个值：预设一键写入 40 / 2000，这里可填 4–9000 的任意数值，保存后上方显示为「自定义」。一个模型典型消耗约 10 个子请求，最坏约 20 个。',
      'mp.timeout_label': '单模型超时',
      'mp.timeout_hint': '每个模型探测请求的最长等待时间（1–120 秒）。',
      'mp.wait_label': '等待时长',
      'mp.wait_hint': '/v1/models 最多等待缺失模型探测完成的时长（0–30 秒，0 为不等待）。',
      'mp.save': '保存',
      'mp.saved': '探测设置已保存',
      'mp.refresh': '立即探测',
      'mp.refresh_done': '探测完成：成功 {probed} 个，不可探测 {unknown} 个，失败 {failed} 个',
      'mp.refresh_truncated': '探测进行中：成功 {probed} 个，不可探测 {unknown} 个，失败 {failed} 个。本轮子请求预算已用完（{used} 个），其余 {pending} 个模型由后台自动继续，无需再点「立即探测」。',
      'mp.refresh_auth': '探测中途凭证失效（HTTP 401/403），已中止：成功 {probed} 个，不可探测 {unknown} 个，失败 {failed} 个。请重新导入 Session',
      'mp.th_model': '模型',
      'mp.th_efforts': '支持挡位',
      'mp.th_probed': '探测时间',
      'mp.th_status': '状态',
      'mp.th_caps': '能力字段',
      'mp.th_params': '支持参数',
      'mp.empty': '暂无探测结果，点击「立即探测」开始',
      'mp.unprobeable': '上游未校验，无法获知挡位',
      'mp.st_unprobeable': '不可探测',
      'mp.st_ok': '正常',
      'mp.st_partial': '部分结论',
      'mp.st_failed': '失败待重试',
      'mp.budget_free': '免费层（40 子请求/轮）',
      'mp.budget_paid': '付费层（2000 子请求/轮）',
      'mp.budget_custom_value': '自定义（{value} 子请求/轮）',
      'mp.reprobe': '重探',
      'mp.expose_label': '实例元信息',
      'mp.expose_hint': '在 /v1/models 信封中输出上游部署的 name / version / features 与共享能力模板（x_open_webui）。关闭后该键完全不出现。',
      'err.probe_session_missing': '尚未导入 Session，无法探测。',
      'err.probe_models_failed': '无法获取上游模型列表，请检查凭证或稍后重试。',
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
      'up.test_not_models': 'No candidate prefix returned a model list (the page may be served by the SPA, or the status code was unexpected); please verify the URL points to Open WebUI',
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
      'up.check_session': 'Check Session Connectivity',
      'up.delete_session': 'Delete Session',
      'err.session_not_imported': 'No session imported yet; import one below first.',
      'keys.subtitle': 'Generate and manage client API keys.',
      'keys.title': 'Manage API Keys',
      'keys.desc1': 'Clients use these API keys to access ',
      'keys.desc2': '. The full key is shown only once at creation.',
      'keys.name_label': 'Key Name (Required)',
      'keys.name_ph': 'e.g. Cherry Studio',
      'keys.create': 'Generate Key',
      'kn.title': 'Generate API Key',
      'kn.note': 'Enter a name to identify the client that uses this key.',
      'kn.submit': 'Confirm',
      'keys.th_name': 'Name',
      'keys.th_key': 'Key',
      'keys.th_created': 'Created',
      'keys.th_used': 'Last Used',
      'keys.never_used': 'Never Used',
      'keys.empty': 'No API Keys Yet',
      'keys.del_confirm': 'Delete key ',
      'keys.del_confirm_end': '?',
      'keys.deleted': 'Key deleted',
      'keys.rotate': 'Rotate',
      'keys.rotate_confirm': 'Rotate key ',
      'keys.rotate_confirm_end': '? The old key is invalidated immediately; clients using it must switch to the new key.',
      'keys.rotated': 'Key rotated; the old key is now invalid',
      'set.subtitle': 'Console account and security configuration.',
      'set.pw_title': 'Password',
      'set.pw_desc': 'Manage the console login password. Changing it signs out all admin sessions.',
      'set.pw_src_label': 'Current Password Storage',
      'set.pw_src_hint': 'The Secret (ADMIN_PASSWORD) only takes effect when no related record exists in KV.',
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
      'set.touch_title': 'Usage Tracking Granularity',
      'set.touch_desc': 'Controls how often the "Last Used" timestamp of API keys is written to KV. A never-used key is recorded immediately on its first call; afterwards it refreshes at the chosen granularity. Coarser granularity means fewer KV writes (free tier: 1,000 writes/day).',
      'set.touch_label': 'Record Interval',
      'set.touch_hint': 'Changes take effect immediately; no redeploy needed.',
      'set.touch_daily': 'Daily (default)',
      'set.touch_6h': 'Every 6 hours',
      'set.touch_3h': 'Every 3 hours',
      'set.touch_hourly': 'Hourly',
      'set.touch_30m': 'Every 30 minutes',
      'msg.touch_saved': 'Tracking granularity saved',
      'err.settings_invalid': 'Invalid setting value.',
      'mp.title': 'Model Probe',
      'mp.desc': 'Establishes what each model really accepts: every reasoning level is verified with a real request, and vision / function calling / structured outputs come from the engine too. The results appear on /v1/models as capabilities, supported_parameters, reasoning and architecture.',
      'mp.enabled_label': 'Enable Model Probe',
      'mp.enabled_hint': 'When off, no probes are sent and /v1/models carries no probe-derived fields (capabilities, supported_parameters, reasoning, architecture).',
      'mp.on': 'On',
      'mp.off': 'Off',
      'mp.refresh_label': 'Subrequest Budget Per Round',
      'mp.refresh_hint': 'Upstream subrequests one round may spend. The free plan allows 50 per invocation, the paid plan 10,000; when the budget runs out the coordinator continues with its own alarm, so no client has to trigger it again.',
      'mp.params_title': 'Probe Parameters',
      'mp.params_hint': 'These parameters apply to all probes.',
      'mp.cache_title': 'Cached Models & Probe Results',
      'mp.cache_hint': 'Lists each probed model with its status: OK (conclusive), Partial (some request left the answer open, retried with backoff), Unprobeable (the upstream never validates the field) or Failed. Capabilities and the last error appear under the levels.',
      'mp.budget_label': 'Custom Budget',
      'mp.budget_hint': 'The same value as "Per-round Subrequest Budget" above: the presets write 40 / 2000 in one click, while this input takes any value from 4 to 9000 — the preset then reads "Custom". One model typically costs about 10 subrequests, 20 in the worst case.',
      'mp.timeout_label': 'Per-model Timeout',
      'mp.timeout_hint': 'Maximum wait per probe request (1–120 seconds).',
      'mp.wait_label': 'Wait Time',
      'mp.wait_hint': 'How long /v1/models may wait for a missing-models probe (0–30 seconds; 0 = never wait).',
      'mp.save': 'Save',
      'mp.saved': 'Probe settings saved',
      'mp.refresh': 'Probe Now',
      'mp.refresh_done': 'Probe finished: {probed} probed, {unknown} unprobeable, {failed} failed',
      'mp.refresh_truncated': 'Probe still running: {probed} probed, {unknown} unprobeable, {failed} failed. This round used up its subrequest budget ({used}); the remaining {pending} models continue in the background — no need to click again.',
      'mp.refresh_auth': 'Credentials expired mid-probe (HTTP 401/403); aborted: {probed} probed, {unknown} unprobeable, {failed} failed. Please re-import the session',
      'mp.th_model': 'Model',
      'mp.th_efforts': 'Supported Efforts',
      'mp.th_probed': 'Probed At',
      'mp.th_status': 'Status',
      'mp.th_caps': 'Capabilities',
      'mp.th_params': 'Supported Parameters',
      'mp.empty': 'No probe results yet — click "Probe Now" to start',
      'mp.unprobeable': 'Upstream accepted the probe without validating',
      'mp.st_unprobeable': 'Unprobeable',
      'mp.st_ok': 'OK',
      'mp.st_partial': 'Partial',
      'mp.st_failed': 'Failed, will retry',
      'mp.budget_free': 'Free plan (40 subrequests/round)',
      'mp.budget_paid': 'Paid plan (2000 subrequests/round)',
      'mp.budget_custom_value': 'Custom ({value} subrequests/round)',
      'mp.reprobe': 'Re-probe',
      'mp.expose_label': 'Instance Metadata',
      'mp.expose_hint': 'Serves the upstream deployment name / version / features and the shared capability template as x_open_webui on the /v1/models envelope. When off, the key is absent entirely.',
      'err.probe_session_missing': 'No session imported; cannot probe.',
      'err.probe_models_failed': 'Cannot fetch the upstream model list. Check credentials or retry later.',
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
    var dict = I18N[_lang] || I18N['en'];
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
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
    var text = t(key);
    if (params) {
      for (var p in params) {
        if (Object.prototype.hasOwnProperty.call(params, p)) text = text.split('{' + p + '}').join(String(params[p]));
      }
    }
    return text;
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
      var lang = String(langs[i] || '').toLowerCase();
      if (lang.indexOf('zh') === 0) return 'zh-CN';
      if (lang.indexOf('en') === 0) return 'en';
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
        var rendered = _bannerRenderers[id]();
        showBanner(id, rendered.msg, rendered.type);
      }
    }
    if (_loginMsgRender) setLoginMsg(_loginMsgRender);
    loadStatus();
    loadKeys();
    loadProbe();
    toast(t('set.lang_saved'), 'ok');
  }

  function toast(msg, type) {
    var toastEl = document.createElement('div');
    toastEl.className = 'toast ' + (type || '');
    toastEl.textContent = msg;
    $('toasts').appendChild(toastEl);
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    setTimeout(function () {
      toastEl.classList.remove('show');
      setTimeout(function () { toastEl.remove(); }, 350);
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
      // Only notify when a previously-authed session actually expired; stay silent for a fresh unauthenticated visit
      // 只有此前已登录（会话真正过期）才提示；未登录首次访问保持安静
      var wasAuthed = _authed;
      showLogin();
      if (wasAuthed) toast(t('msg.session_expired'), 'warn');
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
    var helper = document.createElement('textarea');
    helper.value = text; helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.appendChild(helper); helper.select();
    try { document.execCommand('copy'); toast(msg || t('msg.copied'), 'ok'); } catch (e) { toast(t('msg.copy_failed'), 'err'); }
    document.body.removeChild(helper);
  }

  // ---------- views ----------
  // ---------- 视图切换 ----------
  // Tracks whether the user is currently signed in; lets api() distinguish
  // "session expired" from "never logged in" / 标记当前是否已登录，供 api() 区分"会话过期"与"从未登录"
  var _authed = false;

  function showLogin() {
    _authed = false;
    $('view-login').style.display = 'flex';
    $('view-panel').classList.remove('show');
  }
  function showPanel() {
    _authed = true;
    $('view-login').style.display = 'none';
    $('view-panel').classList.add('show');
    switchPage('dashboard');
    loadStatus();
    loadKeys();
    loadProbe();
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
        var showing = input.type === 'password';
        input.type = showing ? 'text' : 'password';
        btn.classList.toggle('showing', showing);
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
      // Being unauthenticated on first visit is normal: stay on the login view without an error
      // 未登录（not authed）属正常状态：停留在登录页，不显示错误
      if (err && err.message === 'not authed') return;
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
    var password = $('pw1').value, confirm = $('pw2').value;
    if (password.length < 8) { setLoginMsg(function () { return t('login.err_short'); }); return; }
    if (password !== confirm) { setLoginMsg(function () { return t('login.err_mismatch'); }); return; }
    setLoading(btn, true);
    api('/admin/api/setup', { method: 'POST', body: { password: password, confirm: confirm } })
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

  function updatePwSourceUI(status) {
    var src = (status && (status.passwordSource || status.adminPasswordMode)) || 'none';
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

  // ---------- settings: usage tracking granularity ----------
  // ---------- 设置：使用记录粒度 ----------
  // Interval values come from the server (touchIntervalOptions); only the
  // display labels live here. 
  //
  // 档位值来自服务端（touchIntervalOptions），仅展示文案保留在本端。
  var TOUCH_LABELS = {
    '86400': 'set.touch_daily',
    '21600': 'set.touch_6h',
    '10800': 'set.touch_3h',
    '3600': 'set.touch_hourly',
    '1800': 'set.touch_30m'
  };

  function fillTouchSelect(current, options) {
    var sel = $('touch-interval-select');
    if (!sel) return;
    sel.innerHTML = '';
    var opts = options && options.length ? options : [86400, 21600, 10800, 3600, 1800, 600];
    for (var i = 0; i < opts.length; i++) {
      var value = String(opts[i]);
      var option = document.createElement('option');
      option.value = value;
      option.textContent = t(TOUCH_LABELS[value] || value);
      sel.appendChild(option);
    }
    if (current) sel.value = String(current);
  }

  function saveTouchInterval(v) {
    api('/admin/api/settings', { method: 'POST', body: { touch_interval: parseInt(v, 10) } })
      .then(function () { toast(t('msg.touch_saved'), 'ok'); })
      .catch(function (err) {
        toast(etext(err.message), 'err');
        loadStatus(); // revert the select to the persisted value / 恢复为已保存的值
      });
  }

  // ---------- upstream: model probe ----------
  // ---------- 上游：模型探测 ----------
  // The select next to the switch picks the per-round subrequest budget; the presets
  // spell out their platform ceiling (the free plan allows 50 subrequests per
  // invocation, and one model typically costs about 10 of them).
  //
  // 开关旁的下拉框选择「每轮子请求预算」；预设写明各自的平台上限（免费层单次调用
  // 上限 50 个子请求，而一个模型典型消耗约 10 个）。
  var MP_BUDGET_LABELS = { '40': 'mp.budget_free', '2000': 'mp.budget_paid' };
  var MP_BUDGET_VALUES = [40, 2000];

  // The select and the custom input below are two views of ONE stored setting
  // (budget): the presets write 40 / 2000 in one click, the input takes anything in
  // 4-9000. A stored value that is neither preset gets its own entry, so the select
  // never claims the free plan is active while a custom budget is in effect.
  //
  // 下拉框与下方的自定义输入框是同一个存储设置（budget）的两个视图：预设一键写入
  // 40 / 2000，输入框接受 4–9000 的任意值。两个预设之外的值会获得独立条目，因此
  // 存着自定义预算时，下拉框绝不会谎称免费层生效。
  function fillBudgetSelect(current) {
    var sel = $('mp-budget-select');
    if (!sel) return;
    var budget = parseInt(current, 10);
    var values = MP_BUDGET_VALUES.slice();
    if (!isNaN(budget) && values.indexOf(budget) < 0) values.push(budget);
    sel.innerHTML = '';
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i]);
      var option = document.createElement('option');
      option.value = value;
      var label = MP_BUDGET_LABELS[value];
      option.textContent = label ? t(label) : tfmt('mp.budget_custom_value', { value: value });
      sel.appendChild(option);
    }
    if (!isNaN(budget)) sel.value = String(budget);
  }

  // Four states, because "the upstream never validates the field" (unprobeable) and
  // "the probe could not finish" (partial/failed) mean very different things.
  //
  // 四种状态： "上游从不校验该字段"（unprobeable）与 "探测没能完成"（partial/failed）
  // 含义完全不同。
  function probeStatusBadge(status) {
    if (status === 'ok') return badge('ok', t('mp.st_ok'));
    if (status === 'partial') return badge('warn', t('mp.st_partial'));
    if (status === 'unprobeable') return badge('gray', t('mp.st_unprobeable'));
    return badge('warn', t('mp.st_failed'));
  }

  // A chip per established capability. Both values are conclusions: "vision: false"
  // disproved by the engine is as informative as "true", so neither is hidden -- the
  // previous version showed only the true ones, which made "nothing established yet"
  // look identical to "vision was disproved".
  //
  // 每个已确立的能力一个 chip。两种取值都是结论：引擎证伪的 "vision: false" 与
  // "true" 同样有价值，因此两者都不隐藏——旧版本只显示 true，使"尚未探到能力"与
  // "视觉已被证伪"看起来一模一样。
  function renderCaps(caps) {
    var keys = caps ? Object.keys(caps) : [];
    if (!keys.length) return '<span style="color:var(--text-1)">—</span>';
    return keys.map(function (k) {
      var on = !!caps[k];
      return '<span class="mp-cap ' + (on ? 'on' : 'off') + '">' +
        (on ? '✓' : '✗') + ' ' + esc(k) + '</span>';
    }).join('');
  }

  // The request parameters the engine did not reject. Rendered verbatim: this list is
  // what explains why a capability or an effort level is missing elsewhere.
  //
  // 引擎未拒绝的请求参数。原样渲染：它正是"为什么某能力或挡位不在其它列里"的解释。
  function renderParams(params) {
    if (!params || !params.length) return '<span style="color:var(--text-1)">—</span>';
    return '<div class="mp-params">' + esc(params.join(', ')) + '</div>';
  }

  function renderProbeTable(models) {
    var tbody = $('mp-tbody');
    if (!tbody) return;
    if (!models || !models.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">' + t('mp.empty') + '</td></tr>';
      return;
    }
    tbody.innerHTML = models.map(function (m) {
      var efforts = m.status === 'unprobeable'
        ? '<span style="color:var(--text-1)">' + t('mp.unprobeable') + '</span>'
        : esc((m.supported_efforts || []).join(', ') || '—');
      if (m.last_error) {
        efforts += '<div style="color:var(--text-1);font-size:12px;">' + esc(m.last_error) + '</div>';
      }
      var probed = m.probed_at ? new Date(m.probed_at * 1000).toLocaleString() : '—';
      var reprobe = '<button class="btn btn-ghost" style="width:auto;flex:none;margin-left:8px;"' +
        ' data-probe-model="' + esc(m.id) + '" onclick="probeOneModel(this)">' + t('mp.reprobe') + '</button>';
      return '<tr>' +
        '<td class="mono">' + esc(m.id) + '</td>' +
        '<td>' + efforts + '</td>' +
        '<td>' + renderCaps(m.capabilities) + '</td>' +
        '<td>' + renderParams(m.supported_parameters) + '</td>' +
        '<td>' + probed + '</td>' +
        '<td>' + probeStatusBadge(m.status) + reprobe + '</td>' +
        '</tr>';
    }).join('');
  }

  // Last server-known settings; fallback for the immediate-save paths so toggling the
  // switch never submits half-edited probe parameters.
  //
  // 最近一次服务端设置的快照；立即保存路径的参数回退来源，保证切换开关不会连带提交
  // 尚未保存完毕的探测参数。
  var _probeSettings = null;

  function buildProbeBody(enabled, budgetOverride, exposeOverride) {
    var base = _probeSettings || { enabled: true, timeout: 30, wait: 5, budget: 40, exposeInstanceMeta: true };
    var numOr = function (id, fallback) {
      var el = $(id);
      var parsed = el ? parseInt(el.value, 10) : NaN;
      return isNaN(parsed) ? fallback : parsed;
    };
    return {
      enabled: enabled !== undefined ? enabled : base.enabled,
      timeout: numOr('mp-timeout', base.timeout),
      wait: numOr('mp-wait', base.wait),
      budget: budgetOverride !== undefined ? budgetOverride : numOr('mp-budget', base.budget),
      // An explicit override wins (the switch saves immediately); otherwise the loaded
      // value is round-tripped so saving a parameter never resets it.
      //
      // 显式覆盖值优先（开关立即保存）；否则把读到的值原样回传，避免保存参数时把它重置。
      expose_instance_meta: exposeOverride !== undefined ? exposeOverride : base.exposeInstanceMeta !== false
    };
  }

  function toggleProbeDetail(on) {
    var el = $('mp-detail');
    if (el) el.classList.toggle('open', on);
  }

  function saveProbeEnabled(value) {
    var on = value === 'on';
    api('/admin/api/probe/settings', { method: 'POST', body: buildProbeBody(on) })
      .then(function (data) {
        _probeSettings = data.settings;
        toggleProbeDetail(on);
        toast(t('mp.saved'), 'ok');
      })
      .catch(function (err) {
        toast(etext(err.message), 'err');
        loadProbe(); // revert the select to the persisted value / 恢复为已保存的值
      });
  }

  // The budget preset also saves immediately, and mirrors into the custom input.
  // 预算预设同样立即保存，并同步到自定义输入框。
  function saveProbeBudget(value) {
    var budget = parseInt(value, 10);
    if ($('mp-budget') && !isNaN(budget)) $('mp-budget').value = String(budget);
    api('/admin/api/probe/settings', { method: 'POST', body: buildProbeBody(undefined, budget) })
      .then(function (data) { _probeSettings = data.settings; toast(t('mp.saved'), 'ok'); })
      .catch(function (err) {
        toast(etext(err.message), 'err');
        loadProbe(); // revert the select to the persisted value / 恢复为已保存的值
      });
  }

  // The instance-metadata switch saves immediately, like the others.
  // 实例元信息开关同样立即保存。
  function saveProbeExpose(value) {
    var on = value === 'on';
    api('/admin/api/probe/settings', { method: 'POST', body: buildProbeBody(undefined, undefined, on) })
      .then(function (data) { _probeSettings = data.settings; toast(t('mp.saved'), 'ok'); })
      .catch(function (err) {
        toast(etext(err.message), 'err');
        loadProbe(); // revert the select to the persisted value / 恢复为已保存的值
      });
  }
  function loadProbe() {
    api('/admin/api/probe').then(function (data) {
      if (!$('mp-enabled-select')) return;
      _probeSettings = data.settings;
      $('mp-enabled-select').value = data.settings.enabled ? 'on' : 'off';
      toggleProbeDetail(data.settings.enabled);
      fillBudgetSelect(data.settings.budget);
      $('mp-budget').value = String(data.settings.budget);
      if ($('mp-expose-select')) $('mp-expose-select').value = data.settings.exposeInstanceMeta === false ? 'off' : 'on';
      $('mp-timeout').value = String(data.settings.timeout);
      $('mp-wait').value = String(data.settings.wait);
      renderProbeTable(data.models);
    }).catch(function (err) {
      // 401 is already handled by api(); skip to avoid duplicate toasts
      // 401 已由 api() 统一提示（仅会话过期时），此处跳过避免重复弹窗
      if (err && err.message === 'not authed') return;
      toast(etext(err.message), 'err');
    });
  }

  function saveProbeSettings() {
    var budget = parseInt($('mp-budget').value, 10);
    // NB: do NOT name this "t" — it would shadow the global i18n function t().
    // 注意：不要命名为 "t"，否则会遮蔽全局的 i18n 翻译函数 t()。
    var timeoutSec = parseInt($('mp-timeout').value, 10);
    var waitSec = parseInt($('mp-wait').value, 10);
    clearBanner('mp-banner');
    // Strict validation for the explicit Save: no silent fallbacks.
    // 显式「保存」走严格校验：不静默回退。
    if (!_probeSettings || isNaN(budget) || isNaN(timeoutSec) || isNaN(waitSec)) {
      setBanner('mp-banner', 'err', function () { return etext('err.settings_invalid'); });
      return;
    }
    var btn = event.target;
    setLoading(btn, true);
    api('/admin/api/probe/settings', {
      method: 'POST',
      body: {
        enabled: _probeSettings.enabled,
        timeout: timeoutSec,
        wait: waitSec,
        budget: budget,
        expose_instance_meta: _probeSettings.exposeInstanceMeta !== false
      }
    })
      .then(function (data) {
        _probeSettings = data.settings;
        toast(t('mp.saved'), 'ok');
        loadProbe();
      })
      .catch(function (err) { setBanner('mp-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  // The round counters are four-way now, but the banner copy only has three slots;
  // "partial" is folded into "failed" so the message stays truthful and short.
  // The pending count is what a truncated round still owes the queue: the free plan's
  // 40 subrequests cover only ~4 models, so "4 probed" is the normal answer there and
  // must not be announced as a finished round.
  //
  // 轮次计数现在是四态，而横幅文案只有三个占位；partial 折进 failed，既不撒谎也不
  // 让文案变长。pending 是被预算截断的轮次仍欠队列的模型数：免费层 40 个子请求只够
  // 约 4 个模型，因此"探完 4 个"在那里是常态，绝不能被宣布成"整轮已完成"。
  function probeBannerParams(data) {
    var stats = data.stats || data;
    var probed = stats.ok || 0;
    var unknown = stats.unprobeable || 0;
    var failed = (stats.failed || 0) + (stats.partial || 0);
    return {
      probed: probed,
      unknown: unknown,
      failed: failed,
      used: stats.budgetUsed || 0,
      pending: Math.max(0, (stats.total || 0) - probed - unknown - failed)
    };
  }

  function refreshProbe(model) {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('mp-banner');
    api('/admin/api/probe/refresh', { method: 'POST', body: model ? { model: model } : {} })
      .then(function (data) {
        // The auth-expired flag lives in the round stats; older builds also echoed it
        // at the top level, so read both to stay compatible either way.
        //
        // 凭证失效标记在轮次统计里；旧构建也曾在最外层回传，因此两者都读以保持兼容。
        var stats = data.stats || data;
        var params = probeBannerParams(data);
        var authExpired = stats.authExpired === true || data.authExpired === true;
        // A truncated round is not a finished one: the coordinator keeps probing with
        // its own alarm, so the banner must say so instead of claiming "done".
        //
        // 被截断的轮次不等于已完成的轮次：协调者会用自身 alarm 继续探测，因此横幅必须
        // 说明这一点，而不是宣布"完成"。
        var truncated = stats.truncated === true;
        var type = authExpired ? 'warn' : (truncated ? 'warn' : 'ok');
        var key = authExpired ? 'mp.refresh_auth' : (truncated ? 'mp.refresh_truncated' : 'mp.refresh_done');
        setBanner('mp-banner', type, function () { return tfmt(key, params); });
        loadProbe();
      })
      .catch(function (err) { setBanner('mp-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  // Per-model re-probe (row button); the id travels in a data attribute so quoting
  // can never break the markup.
  //
  // 单模型重探（行内按钮）；id 走 data 属性，因此引号永远不会破坏标记。
  function probeOneModel(btn) {
    var model = btn && btn.getAttribute ? btn.getAttribute('data-probe-model') : '';
    if (model) refreshProbe(model);
  }
  // ---------- status ----------
  // ---------- 状态 ----------
  function badge(type, text) {
    return '<span class="badge ' + type + '">' + text + '</span>';
  }

  function fillSessionStatus(prefix, status) {
    if (status.session && status.session.imported) {
      $(prefix + '-session').innerHTML = status.session.usable ? badge('ok', t('st.imported')) : badge('err', t('st.unusable'));
      $(prefix + '-session-sub').textContent = status.session.summary || '';
      $(prefix + '-upstream').textContent = status.session.base_url || '—';
      $(prefix + '-upstream-sub').textContent = status.session.captured_at ? new Date(status.session.captured_at * 1000).toLocaleString() : '';
    } else {
      $(prefix + '-session').innerHTML = badge('err', t('st.not_imported'));
      $(prefix + '-session-sub').textContent = t('st.not_imported_hint');
      $(prefix + '-upstream').textContent = '—';
      $(prefix + '-upstream-sub').textContent = '';
    }
  }

  function loadStatus() {
    api('/admin/api/status').then(function (status) {
      // chip
      // 接入地址胶囊
      $('chip-url').textContent = status.baseUrl + '  ';
      $('api-base-desc').textContent = status.baseUrl;
      $('api-base-code').textContent = status.baseUrl;

      // dashboard session stat
      // 仪表盘 Session 状态
      fillSessionStatus('st', status);
      // upstream page status
      // 上游页面状态
      fillSessionStatus('up', status);

      // The key count is intentionally NOT rendered here: it comes from the
      // eventually-consistent KV list and would briefly lag behind creates.
      // renderKeys() owns it from the local _keys snapshot instead.
      //
      // 此处刻意不渲染 Key 计数：它来自最终一致的 KV list，创建后会短暂
      // 滞后；计数改由 renderKeys() 用本地 _keys 快照统一维护。

      // admin password source badge
      // 管理密码来源徽标
      updatePwSourceUI(status);

      // usage tracking granularity select
      // 使用记录粒度选择器
      fillTouchSelect(status.touchInterval, status.touchIntervalOptions);
    }).catch(function (err) {
    // 401 is already handled by api(); skip to avoid duplicate toasts
    // 401 已由 api() 统一提示（仅会话过期时），此处跳过避免重复弹窗
      if (err && err.message === 'not authed') return;
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
      .then(function (data) {
        setBanner('session-banner', data.test.ok ? 'ok' : 'warn', function () { return testDetail(data.test); });
      })
      .catch(function (err) { setBanner('session-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  // Connectivity check for the session already stored in KV (no paste needed).
  // The result shows inside the "Current Credential Status" card.
  //
  // 针对已导入 KV 的 session 的连通性检测（无需粘贴内容）。
  // 结果显示在「当前凭证状态」卡片内部。
  function checkSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('status-banner');
    api('/admin/api/session/check', { method: 'POST' })
      .then(function (data) {
        setBanner('status-banner', data.test.ok ? 'ok' : 'warn', function () { return testDetail(data.test); });
      })
      .catch(function (err) { setBanner('status-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function importSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', { method: 'POST', body: { json: $('session-json').value, test: true, save: true } })
      .then(function (data) {
        setBanner('session-banner', 'ok', function () {
          return t('up.import_ok') + (data.test ? ' ' + testDetail(data.test) : '') + t('up.import_summary') + data.summary;
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
  function openKeyModal() {
    clearBanner('key-name-banner');
    $('key-name-modal-input').value = '';
    $('key-name-modal').classList.add('show');
    setTimeout(function () { $('key-name-modal-input').focus(); }, 60);
  }

  function closeKeyModal() {
    $('key-name-modal').classList.remove('show');
    $('key-name-modal-input').value = '';
    clearBanner('key-name-banner');
  }

  function submitCreateKey() {
    var btn = $('btn-submit-key');
    var name = $('key-name-modal-input').value.trim();
    clearBanner('key-name-banner');
    if (!name) {
      setBanner('key-name-banner', 'err', function () { return etext('err.key_name_required'); });
      return;
    }
    setLoading(btn, true);
    api('/admin/api/keys', { method: 'POST', body: { name: name } })
      .then(function (data) {
        closeKeyModal();
        $('key-modal-value').textContent = data.key;
        $('key-modal').classList.add('show');
        // Insert the new key locally instead of re-listing: the KV list index
        // is eventually consistent, so an immediate re-fetch may not include
        // it yet. loadKeys() from the next refresh overwrites once synced.
        //
        // 在本地插入新 Key 而非重新拉取列表：KV list 索引是最终一致的，
        // 立即重新拉取可能还看不到它；下次 loadKeys() 同步后自然覆盖。
        _keys.unshift({
          key: data.key,
          name: data.name,
          prefix: data.prefix,
          created_at: data.created_at,
          last_used: data.last_used,
          masked: data.masked || (data.key.slice(0, 12) + '…' + data.key.slice(-4))
        });
        renderKeys();
        loadStatus();
      })
      .catch(function (err) { setBanner('key-name-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function closeModal() { $('key-modal').classList.remove('show'); }

  var _keys = [];

  // Render the key table from the local _keys snapshot. The dashboard key
  // count reads the same local snapshot, so it updates immediately on
  // create/delete — including consecutive adds — without waiting for the
  // eventually-consistent KV list behind /admin/api/status.
  //
  // 根据本地 _keys 快照渲染 Key 表格。仪表盘计数读取同一份本地快照，
  // 创建/删除（含连续添加）都会立即更新，无需等待 /admin/api/status 背后
  // 最终一致的 KV list。
  function renderKeys() {
    var tbody = $('key-tbody');
    $('st-keys').textContent = String(_keys.length);
    $('nav-key-count').textContent = String(_keys.length);
    if (!_keys.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">' + t('keys.empty') + '</td></tr>';
      return;
    }
    tbody.innerHTML = _keys.map(function (k, i) {
      var created = new Date(k.created_at * 1000).toLocaleString();
      var used = k.last_used ? new Date(k.last_used * 1000).toLocaleString() : t('keys.never_used');
      return '<tr>' +
        '<td>' + esc(k.name) + '</td>' +
        '<td class="mono">' + esc(k.masked) + '</td>' +
        '<td>' + created + '</td>' +
        '<td>' + used + '</td>' +
        '<td style="text-align:right; white-space:nowrap;">' +
          '<button class="btn btn-ghost btn-sm" onclick="rotateKey(' + i + ')">' + t('keys.rotate') + '</button> ' +
          '<button class="btn btn-danger btn-sm" onclick="deleteKey(' + i + ')">' + t('common.delete') + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  function loadKeys() {
    api('/admin/api/keys').then(function (data) {
      _keys = data.keys || [];
      renderKeys();
    }).catch(function (err) {
      // 401 is already handled by api(); skip to avoid duplicate toasts
      // 401 已由 api() 统一提示（仅会话过期时），此处跳过避免重复弹窗
      if (err && err.message === 'not authed') return;
      toast(etext(err.message), 'err');
    });
  }

  function deleteKey(i) {
    var keyRecord = _keys[i];
    if (!keyRecord) return;
    if (!confirm(t('keys.del_confirm') + '[' + keyRecord.name + ']' + t('keys.del_confirm_end'))) return;
    api('/admin/api/keys', { method: 'DELETE', body: { key: keyRecord.key } })
      .then(function () {
        toast(t('keys.deleted'), 'ok');
        // Remove locally first: the KV list index is eventually consistent and
        // an immediate re-list may still return the deleted key.
        //
        // 先在本地移除：KV list 索引是最终一致的，立即重新拉取
        // 可能仍返回已删除的 Key。
        _keys.splice(i, 1);
        renderKeys();
        loadStatus();
        loadKeys(); // overwrite with the server list once it has caught up / 服务端列表同步后覆盖
      })
      .catch(function (err) { toast(etext(err.message), 'err'); });
  }

  function rotateKey(i) {
    var keyRecord = _keys[i];
    if (!keyRecord) return;
    if (!confirm(t('keys.rotate_confirm') + '[' + keyRecord.name + ']' + t('keys.rotate_confirm_end'))) return;
    api('/admin/api/keys/rotate', { method: 'POST', body: { key: keyRecord.key } })
      .then(function (data) {
        // Replace the row locally (same write-after-read compensation as
        // create/delete), then force the one-time copy modal for the new key.
        //
        // 本地替换该行（与创建/删除相同的写后读补偿机制），随后弹出
        // 新 Key 的一次性复制弹窗。
        _keys[i] = {
          key: data.key,
          name: data.name,
          prefix: data.prefix,
          created_at: data.created_at,
          last_used: data.last_used,
          masked: data.masked || (data.key.slice(0, 12) + '…' + data.key.slice(-4))
        };
        renderKeys();
        $('key-modal-value').textContent = data.key;
        $('key-modal').classList.add('show');
        toast(t('keys.rotated'), 'ok');
        loadStatus();
      })
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
  $('key-name-modal').addEventListener('click', function (e) { if (e.target === this) closeKeyModal(); });
  $('pw-modal').addEventListener('click', function (e) { if (e.target === this) closePwModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeKeyModal(); closePwModal(); }
  });
</script>
</body>
</html>`;
