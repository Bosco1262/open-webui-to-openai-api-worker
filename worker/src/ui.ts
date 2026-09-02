/**
 * Self-contained admin console (single HTML page, zero external dependencies).
 * Layout: top title bar + left sidebar navigation + right content area.
 * Dark console aesthetic with glassmorphism cards and orange accents.
 */

const VERSION = "1.0.0";

export const ADMIN_UI = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open WebUI 代理控制台</title>
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
  #view-panel { display: none; }
  #view-panel.show { display: block; }

  /* Title bar */
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

  /* Body: sidebar + content */
  .layout-body { display: flex; min-height: calc(100vh - var(--topbar-h)); }

  .sidebar {
    width: var(--sidebar-w); flex: none;
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
    margin-top: 16px; padding: 12px; border-top: 1px solid var(--border);
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
      width: 100%; padding: 10px 12px;
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
<div id="view-login">
  <div class="login-card">
    <div class="login-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h11M4 12h8M4 17h13"/>
        <path d="M17 4l4 4-4 4"/>
        <path d="M13 10l4 4 4-4"/>
      </svg>
    </div>
    <div class="login-title">Open WebUI 代理控制台</div>
    <div class="login-sub">将 Open WebUI 反代为 OpenAI 兼容 API</div>
    <div id="login-mode" data-mode="login">
      <form id="form-login" autocomplete="current-password">
        <div class="field">
          <input id="pw" type="password" placeholder="管理密码" autocomplete="current-password" required />
          <button type="button" class="eye" data-target="pw" aria-label="显示/隐藏密码">👁</button>
        </div>
        <button class="btn btn-primary" id="btn-login" type="submit">登 录</button>
      </form>
      <form id="form-setup" style="display:none" autocomplete="new-password">
        <div class="field">
          <input id="pw1" type="password" placeholder="设置管理密码（至少 8 位）" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw1" aria-label="显示/隐藏密码">👁</button>
        </div>
        <div class="field">
          <input id="pw2" type="password" placeholder="确认管理密码" autocomplete="new-password" required />
          <button type="button" class="eye" data-target="pw2" aria-label="显示/隐藏密码">👁</button>
        </div>
        <button class="btn btn-primary" id="btn-setup" type="submit">设置密码并进入</button>
      </form>
    </div>
    <div class="hint" id="login-msg"></div>
  </div>
</div>

<!-- ===================== Panel view ===================== -->
<div id="view-panel">

  <!-- Title bar -->
  <header class="topbar">
    <div class="topbar-brand">
      <div class="topbar-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h11M4 12h8M4 17h13"/>
          <path d="M17 4l4 4-4 4"/>
          <path d="M13 10l4 4 4-4"/>
        </svg>
      </div>
      <div class="topbar-name">Open WebUI 代理控制台<small>v${VERSION}</small></div>
    </div>
    <div class="topbar-actions">
      <button class="btn btn-ghost btn-sm" onclick="logout()">退出登录</button>
    </div>
  </header>

  <div class="layout-body">

    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="side-label">导航</div>
      <nav class="side-nav">
        <button class="side-item active" data-page="dashboard" onclick="switchPage('dashboard')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
            <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
          </svg>
          仪表盘
        </button>
        <button class="side-item" data-page="upstream" onclick="switchPage('upstream')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>
            <path d="M7 7h.01M7 17h.01"/>
          </svg>
          上游服务端
        </button>
        <button class="side-item" data-page="keys" onclick="switchPage('keys')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16.5 6.5l3 3"/><path d="M14 9l2.5 2.5"/>
          </svg>
          API 管理
          <span class="side-badge" id="nav-key-count">·</span>
        </button>
        <button class="side-item" data-page="settings" onclick="switchPage('settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          网页设置
        </button>
      </nav>
      <div class="side-foot">
        登录后可管理上游凭证、<br />API Key 与控制台设置。
      </div>
    </aside>

    <!-- Content -->
    <main class="content">
      <div class="content-inner">

        <!-- ============ Page: Dashboard ============ -->
        <section class="page active" id="page-dashboard">
          <div class="page-head">
            <h2>仪表盘</h2>
            <p>代理服务整体运行状态一览。</p>
          </div>

          <div class="stats" style="margin-bottom:18px;">
            <div class="stat">
              <div class="label">Session 凭证</div>
              <div class="value"><span id="st-session">—</span></div>
              <div class="sub" id="st-session-sub"></div>
            </div>
            <div class="stat">
              <div class="label">上游地址</div>
              <div class="value" id="st-upstream">—</div>
              <div class="sub" id="st-upstream-sub"></div>
            </div>
            <div class="stat">
              <div class="label">API Key 数量</div>
              <div class="value" id="st-keys">—</div>
              <div class="sub">生成的客户端密钥</div>
            </div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> 客户端接入</h3>
            <div class="desc">在任何 OpenAI 兼容客户端中使用以下地址与密钥接入本代理。</div>
            <span class="url-chip" title="客户端接入地址，点击复制">
              <span class="dot"></span><span class="txt" id="chip-url">/v1</span>
              <button class="btn btn-ghost btn-sm" onclick="copyText(document.getElementById('chip-url').textContent.trim(), '已复制接入地址')">复制</button>
            </span>
            <div class="code-block">
              <b>Base URL</b>&nbsp;&nbsp;<span id="api-base-code">—</span><br />
              <b>Authorization</b>&nbsp;&nbsp;Bearer sk-xxx
            </div>
          </div>
        </section>

        <!-- ============ Page: Upstream ============ -->
        <section class="page" id="page-upstream">
          <div class="page-head">
            <h2>上游服务端</h2>
            <p>导入并管理 Open WebUI 的 Session 凭证。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> 导入 Session</h3>
            <div class="desc">
              在本地运行 <code>python login.py --base-url https://你的-open-webui 地址</code>，完成浏览器登录后，
              将终端输出的 <b>session.json 全部 JSON 内容</b> 粘贴到下方并导入。
            </div>
            <div class="form-row">
              <label class="lbl">session.json 内容</label>
              <textarea id="session-json" placeholder='{\n  "authorization": "Bearer eyJ...",\n  "cookie": "...",\n  "base_url": "https://..."\n}'></textarea>
            </div>
            <div class="btn-row">
              <button class="btn btn-ghost" onclick="testSession()">校验并测试连通</button>
              <button class="btn btn-primary" style="width:auto;" onclick="importSession()">导入 Session</button>
              <button class="btn btn-danger btn-sm" onclick="deleteSession()">删除</button>
            </div>
            <div class="banner" id="session-banner"></div>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> 当前凭证状态</h3>
            <div class="desc">最近一次导入的凭证摘要，凭证过期后请重新登录上游并再次导入。</div>
            <div class="stats" style="grid-template-columns:1fr 1fr;">
              <div class="stat">
                <div class="label">状态</div>
                <div class="value"><span id="up-session">—</span></div>
                <div class="sub" id="up-session-sub"></div>
              </div>
              <div class="stat">
                <div class="label">上游地址</div>
                <div class="value" id="up-upstream">—</div>
                <div class="sub" id="up-upstream-sub"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Page: API Keys ============ -->
        <section class="page" id="page-keys">
          <div class="page-head">
            <h2>API 管理</h2>
            <p>生成与管理客户端使用的 API Key。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> 管理 API Key</h3>
            <div class="desc">客户端使用以下 API Key 访问 <span class="mono" id="api-base-desc"></span>。完整 Key 仅在创建时显示一次。</div>
            <div class="grid2" style="max-width:420px;">
              <div class="form-row" style="margin-bottom:0;">
                <label class="lbl">Key 名称（可选）</label>
                <input id="key-name" placeholder="如：Cherry Studio" />
              </div>
              <div class="form-row" style="margin-bottom:0; display:flex; align-items:flex-end;">
                <button class="btn btn-primary" style="width:100%;" onclick="createKey()">生成 Key</button>
              </div>
            </div>
            <div style="margin-top:18px;">
              <table class="table">
                <thead><tr><th>名称</th><th>Key</th><th>创建时间</th><th>最近使用</th><th style="text-align:right">操作</th></tr></thead>
                <tbody id="key-tbody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
              </table>
            </div>
            <div class="banner" id="keys-banner"></div>
          </div>
        </section>

        <!-- ============ Page: Settings ============ -->
        <section class="page" id="page-settings">
          <div class="page-head">
            <h2>网页设置</h2>
            <p>控制台自身账号与安全配置。</p>
          </div>

          <div class="card">
            <h3><span class="ic">▸</span> 修改管理密码 <span id="pw-src-badge" class="badge gray"></span></h3>
            <div class="desc">修改后密码将保存于 KV 并立即覆盖当前生效来源；所有已登录的管理会话将失效，需重新登录。</div>
            <div class="banner warn" id="pw-src-note" style="display:none"></div>
            <div style="max-width:520px;">
              <div class="form-row">
                <label class="lbl">当前密码</label>
                <input id="pw-cur" type="password" autocomplete="current-password" />
              </div>
              <div class="form-row">
                <label class="lbl">新密码（至少 8 位）</label>
                <input id="pw-new" type="password" autocomplete="new-password" />
              </div>
              <div class="form-row">
                <label class="lbl">确认新密码</label>
                <input id="pw-new2" type="password" autocomplete="new-password" />
              </div>
              <div class="btn-row" style="margin-top:4px;">
                <button class="btn btn-primary" style="width:auto;" onclick="changePassword()">修改密码</button>
              </div>
            </div>
            <div class="banner" id="pw-banner"></div>
          </div>
        </section>

      </div>
    </main>
  </div>
</div>

<!-- Modal: show generated key -->
<div class="modal-mask" id="key-modal">
  <div class="modal">
    <h4>API Key 已生成</h4>
    <div class="note">请立即复制保存，关闭后将无法再次查看完整 Key。</div>
    <div class="key-box" id="key-modal-value"></div>
    <div class="btn-row">
      <button class="btn btn-primary" style="flex:1;" onclick="copyText(document.getElementById('key-modal-value').textContent, '已复制 API Key')">复制</button>
      <button class="btn btn-ghost" onclick="closeModal()">关闭</button>
    </div>
  </div>
</div>

<script>
  var VERSION = "${VERSION}";

  function $(id) { return document.getElementById(id); }

  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 350);
    }, 3200);
  }

  function showBanner(id, msg, type) {
    var el = $(id);
    el.className = 'banner ' + (type || 'info');
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }
  function clearBanner(id) { var el = $(id); el.className = 'banner'; el.textContent = ''; el.style.display = 'none'; }

  function setLoading(btn, loading, text) {
    if (!btn) return;
    if (loading) {
      btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 处理中…';
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
      toast('登录已过期，请重新登录', 'warn');
      showLogin();
      throw new Error('not authed');
    }
    if (!data.ok) throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
    return data;
  }

  // ---------- copy ----------
  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(msg || '已复制', 'ok');
      }, function () { fallbackCopy(text, msg); });
    } else { fallbackCopy(text, msg); }
  }
  function fallbackCopy(text, msg) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg || '已复制', 'ok'); } catch (e) { toast('复制失败', 'err'); }
    document.body.removeChild(ta);
  }

  // ---------- views ----------
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
  document.addEventListener('DOMContentLoaded', function () {
    // password visibility toggles
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
    api('/admin/api/status').then(function (data) {
      var needsSetup = data.adminPasswordMode === 'none';
      if (needsSetup) {
        $('form-login').style.display = 'none';
        $('form-setup').style.display = 'block';
        $('login-sub').textContent = '首次使用，请先设置管理密码';
      } else {
        showPanel();
      }
    }).catch(function (err) {
      $('login-msg').textContent = err.message;
      $('login-msg').className = 'hint err';
    });
  });

  function login() {
    var btn = $('btn-login');
    setLoading(btn, true);
    api('/admin/api/login', { method: 'POST', body: { password: $('pw').value } })
      .then(function () { showPanel(); })
      .catch(function (err) { $('login-msg').textContent = err.message; $('login-msg').className = 'hint err'; })
      .finally(function () { setLoading(btn, false); });
  }

  function setup() {
    var btn = $('btn-setup');
    var p1 = $('pw1').value, p2 = $('pw2').value;
    if (p1.length < 8) { $('login-msg').textContent = '密码长度至少 8 位'; $('login-msg').className = 'hint err'; return; }
    if (p1 !== p2) { $('login-msg').textContent = '两次输入的密码不一致'; $('login-msg').className = 'hint err'; return; }
    setLoading(btn, true);
    api('/admin/api/setup', { method: 'POST', body: { password: p1, confirm: p2 } })
      .then(function () { showPanel(); })
      .catch(function (err) { $('login-msg').textContent = err.message; $('login-msg').className = 'hint err'; })
      .finally(function () { setLoading(btn, false); });
  }

  function logout() {
    api('/admin/api/logout', { method: 'POST' }).then(function () {
      showLogin();
    }).catch(function () { showLogin(); });
  }

  // ---------- change password ----------
  var _pwSource = 'none';

  function updatePwSourceUI(s) {
    var src = (s && (s.passwordSource || s.adminPasswordMode)) || 'none';
    _pwSource = src;
    var badgeEl = $('pw-src-badge');
    var noteEl = $('pw-src-note');
    if (!badgeEl || !noteEl) return;
    if (src === 'secret') {
      badgeEl.className = 'badge warn';
      badgeEl.textContent = 'Secret（ADMIN_PASSWORD）';
      noteEl.textContent = '当前密码来自部署配置 ADMIN_PASSWORD。修改后将以新密码为准并保存在 KV（控制台），该 Secret 将不再被使用，除非在 Cloudflare Dashboard 将其改回一致的值。';
      noteEl.style.display = 'block';
    } else if (src === 'kv') {
      badgeEl.className = 'badge info';
      badgeEl.textContent = 'KV（控制台修改）';
      noteEl.style.display = 'none';
    } else {
      badgeEl.className = 'badge gray';
      badgeEl.textContent = '';
      noteEl.style.display = 'none';
    }
  }

  function changePassword() {
    var btn = event.target;
    var cur = $('pw-cur').value;
    var n1 = $('pw-new').value;
    var n2 = $('pw-new2').value;
    clearBanner('pw-banner');
    if (!cur) { showBanner('pw-banner', '请填写当前密码', 'err'); return; }
    if (n1.length < 8) { showBanner('pw-banner', '新密码长度至少 8 位', 'err'); return; }
    if (n1 === cur) { showBanner('pw-banner', '新密码不能与当前密码相同', 'err'); return; }
    if (n1 !== n2) { showBanner('pw-banner', '两次输入的新密码不一致', 'err'); return; }
    if (_pwSource === 'secret' && !confirm(
      '当前管理员密码来自 Cloudflare Secret（ADMIN_PASSWORD）。\\n\\n' +
      '在此修改会把生效密码覆盖为 KV 中保存的新密码，之后该 Secret 将不再被使用（除非把 Secret 改成与新密码一致）。\\n' +
      '如不想覆盖，请前往 Cloudflare Dashboard 更新 Secret。\\n\\n' +
      '确定要继续吗？'
    )) return;
    setLoading(btn, true);
    api('/admin/api/password', { method: 'POST', body: { current_password: cur, new_password: n1 } })
      .then(function () {
        toast('密码已修改，所有旧会话已失效，请使用新密码重新登录', 'ok');
        $('pw-cur').value = '';
        $('pw-new').value = '';
        $('pw-new2').value = '';
        showLogin();
      })
      .catch(function (err) { showBanner('pw-banner', err.message, 'err'); })
      .finally(function () { setLoading(btn, false); });
  }

  // ---------- status ----------
  function badge(type, text) {
    return '<span class="badge ' + type + '">' + text + '</span>';
  }

  function fillSessionStatus(prefix, s) {
    if (s.session && s.session.imported) {
      $(prefix + '-session').innerHTML = s.session.usable ? badge('ok', '已导入') : badge('err', '凭证不可用');
      $(prefix + '-session-sub').textContent = s.session.summary || '';
      $(prefix + '-upstream').textContent = s.session.base_url || '—';
      $(prefix + '-upstream-sub').textContent = s.session.captured_at ? new Date(s.session.captured_at * 1000).toLocaleString() : '';
    } else {
      $(prefix + '-session').innerHTML = badge('err', '未导入');
      $(prefix + '-session-sub').textContent = '请先导入 session.json';
      $(prefix + '-upstream').textContent = '—';
      $(prefix + '-upstream-sub').textContent = '';
    }
  }

  function loadStatus() {
    api('/admin/api/status').then(function (s) {
      // chip
      $('chip-url').textContent = s.baseUrl + '  ';
      $('api-base-desc').textContent = s.baseUrl;
      $('api-base-code').textContent = s.baseUrl;

      // dashboard session stat
      fillSessionStatus('st', s);
      // upstream page status
      fillSessionStatus('up', s);

      // keys
      $('st-keys').textContent = String(s.apiKeys.count);
      $('nav-key-count').textContent = String(s.apiKeys.count);

      // admin password source badge / overwrite hint
      updatePwSourceUI(s);
    }).catch(function (err) {
      toast(err.message, 'err');
    });
  }

  // ---------- session ----------
  function testSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', { method: 'POST', body: { json: $('session-json').value, test: true, save: false } })
      .then(function (d) {
        showBanner('session-banner', d.test.detail, d.test.ok ? 'ok' : 'warn');
      })
      .catch(function (err) { showBanner('session-banner', err.message, 'err'); })
      .finally(function () { setLoading(btn, false); });
  }

  function importSession() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', { method: 'POST', body: { json: $('session-json').value, test: true, save: true } })
      .then(function (d) {
        var msg = '导入成功。' + (d.test ? ' ' + d.test.detail : '') + ' 凭证摘要：' + d.summary;
        showBanner('session-banner', msg, 'ok');
        loadStatus();
      })
      .catch(function (err) { showBanner('session-banner', err.message, 'err'); })
      .finally(function () { setLoading(btn, false); });
  }

  function deleteSession() {
    if (!confirm('确认删除已导入的 Session？客户端将无法使用代理。')) return;
    api('/admin/api/session', { method: 'DELETE' })
      .then(function () { toast('Session 已删除', 'ok'); loadStatus(); clearBanner('session-banner'); })
      .catch(function (err) { toast(err.message, 'err'); });
  }

  // ---------- api keys ----------
  function createKey() {
    var btn = event.target;
    setLoading(btn, true);
    clearBanner('keys-banner');
    api('/admin/api/keys', { method: 'POST', body: { name: $('key-name').value } })
      .then(function (d) {
        $('key-name').value = '';
        $('key-modal-value').textContent = d.key;
        $('key-modal').classList.add('show');
        loadStatus();
        loadKeys();
      })
      .catch(function (err) { showBanner('keys-banner', err.message, 'err'); })
      .finally(function () { setLoading(btn, false); });
  }

  function closeModal() { $('key-modal').classList.remove('show'); }

  function loadKeys() {
    api('/admin/api/keys').then(function (d) {
      var tbody = $('key-tbody');
      if (!d.keys || !d.keys.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无 API Key</td></tr>';
        return;
      }
      tbody.innerHTML = d.keys.map(function (k) {
        var created = new Date(k.created_at * 1000).toLocaleString();
        var used = k.last_used ? new Date(k.last_used * 1000).toLocaleString() : '从未使用';
        return '<tr>' +
          '<td>' + esc(k.name) + '</td>' +
          '<td class="mono">' + esc(k.masked) + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + used + '</td>' +
          '<td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="deleteKey(\\'' + k.key + '\\',\\'' + esc(k.masked) + '\\')">删除</button></td>' +
          '</tr>';
      }).join('');
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function deleteKey(fullKey, masked) {
    if (!confirm('确认删除 Key ' + masked + ' ？')) return;
    api('/admin/api/keys', { method: 'DELETE', body: { key: fullKey } })
      .then(function () { toast('Key 已删除', 'ok'); loadKeys(); loadStatus(); })
      .catch(function (err) { toast(err.message, 'err'); });
  }

  function esc(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // close modal on mask click
  $('key-modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
</script>
</body>
</html>`;
