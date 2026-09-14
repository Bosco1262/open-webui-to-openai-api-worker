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

import { I18N } from "./ui-i18n.ts";

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
  /* Probe facts: one entry per line, so a long list (max, xhigh, high, ...) or a
     long error can never squeeze the neighbouring columns into one letter each. */
  /* 探测事实：每行一条，使很长的挡位列表或报错永远不会把旁边的列挤成一行一个字母。 */
  .mp-list { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
  .mp-list > * { max-width: 100%; }
  .mp-cap { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
  .mp-cap.on { background: rgba(34, 197, 94, 0.14); color: #86efac; }
  .mp-cap.off { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }
  .mp-params { font-family: var(--mono); font-size: 11.5px; color: var(--text-1); line-height: 1.65; word-break: break-word; }
  .mp-error { color: var(--err); font-size: 12px; line-height: 1.5; word-break: break-word; margin-top: 6px; }

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
              <button class="btn btn-ghost" style="width:auto; flex:none; margin:12px 0;" onclick="checkSession(this)" data-i18n="up.check_session">检测 Session 连通性</button>
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
              <button class="btn btn-ghost" onclick="testSession(this)" data-i18n="up.test">校验并测试连通</button>
              <button class="btn btn-primary" style="width:auto;" onclick="importSession(this)" data-i18n="up.import">导入 Session</button>
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
                  <div class="setting-label" data-i18n="mp.hb_label">定时巡检</div>
                  <div class="setting-hint" data-i18n="mp.hb_hint">开启后，空闲部署也会每隔所选时长自动对齐一次上游模型列表（每次巡检约 1–2 个上游子请求）；有指纹变化才探测，仍受「每轮子请求预算」约束并由 alarm 自动继续；上游模型的增减与凭证过期会被更早发现。默认关闭。</div>
                </div>
                <select id="mp-heartbeat-select" style="width:180px;" onchange="saveProbeHeartbeat(this.value)"></select>
              </div>

              <div class="setting-row" style="margin-bottom:12px;">
                <div style="flex:1; min-width:300px;">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;">
                    <div class="setting-info">
                      <div class="setting-label" data-i18n="mp.params_title">探测参数</div>
                      <div class="setting-hint" data-i18n="mp.params_hint">此参数设置作用于所有探测。</div>
                    </div>
                    <button class="btn btn-primary" style="width:auto; flex:none;" onclick="saveProbeSettings(this)" data-i18n="mp.save">保存</button>
                  </div>
                  <div style="display:flex; flex-direction:column; gap:12px; margin-top:14px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.budget_label">每轮子请求预算</div>
                        <div class="setting-hint" data-i18n="mp.budget_hint">单轮探测（一次调用）最多向上游发送的子请求数，4–9000，按「保存」生效。一个模型典型消耗约 10 个、最坏约 20 个；免费层单次调用上限 50 个（含模型列表与前缀探测的开销），建议不超过 40。预算用完时协调者用自身 alarm 继续，无需再点「立即探测」。</div>
                      </div>
                      <input id="mp-budget" type="number" min="4" max="9000" style="width:130px; flex:none;" placeholder="40" />
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                      <div class="setting-info" style="flex:1;">
                        <div class="setting-label" data-i18n="mp.timeout_label">单模型超时</div>
                        <div class="setting-hint" data-i18n="mp.timeout_hint">每个模型探测请求的最长等待时间（1–120 秒）。另有单模型总墙钟 45 秒的保险（不可调），调大本值不会突破它。</div>
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
                  <button class="btn btn-ghost" style="width:auto; flex:none;" onclick="refreshProbe(this)" data-i18n="mp.refresh">立即探测</button>
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
  var I18N = ${JSON.stringify(I18N)};

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
    // Only poll when signed in: an unauthenticated visitor switching languages
    // would otherwise fire three requests that all come back 401.
    //
    // 仅在已登录时轮询：未登录访客切换语言会白白发出三个 401 请求。
    if (_authed) {
      loadStatus();
      loadKeys();
      loadProbe();
    }
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
    var res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      // A transport failure (offline, DNS, aborted) has no error code from the
      // server: map it to a fixed key so callers show a localized message instead
      // of the raw "Failed to fetch".
      //
      // 传输层失败（离线、DNS、中断）没有服务端错误码：映射为固定键，调用方显示
      // 本地化消息，而不是原始的 "Failed to fetch"。
      throw new Error('err.network');
    }
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
    if (!data.ok) {
      var e = new Error(data.error || ('HTTP ' + res.status));
      // Carry the structured payload (needForce, test, ...) so callers can branch
      // on it instead of re-fetching.
      //
      // 携带结构化负载（needForce、test 等），调用方可据此分支，而无需重新请求。
      e.payload = data;
      throw e;
    }
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
    '43200': 'set.touch_12h',
    '21600': 'set.touch_6h',
    '10800': 'set.touch_3h',
    '3600': 'set.touch_hourly',
    '1800': 'set.touch_30m',
    '0': 'set.touch_off'
  };

  function fillTouchSelect(current, options) {
    var sel = $('touch-interval-select');
    if (!sel) return;
    sel.innerHTML = '';
    var opts = options && options.length ? options : [86400, 43200, 21600, 10800, 3600, 1800, 0];
    for (var i = 0; i < opts.length; i++) {
      var value = String(opts[i]);
      var option = document.createElement('option');
      option.value = value;
      option.textContent = t(TOUCH_LABELS[value] || value);
      sel.appendChild(option);
    }
    // 0 (off) is a legitimate selection, so the usual truthiness check would drop it.
    // 0（关闭）是合法选择，常规的真值判断会把它丢掉。
    if (current !== null && current !== undefined) sel.value = String(current);
  }

  function saveTouchInterval(v) {
    api('/admin/api/settings', { method: 'POST', body: { touch_interval: parseInt(v, 10) } })
      .then(function () {
        toast(t('msg.touch_saved'), 'ok');
        // Switching tracking off/on changes every row of the "Last Used" column.
        // 切换记录开关会改变「最近使用」整列的显示。
        renderKeys();
      })
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
    return '<div class="mp-list">' + keys.map(function (k) {
      var on = !!caps[k];
      return '<span class="mp-cap ' + (on ? 'on' : 'off') + '">' +
        (on ? '✓' : '✗') + ' ' + esc(k) + '</span>';
    }).join('') + '</div>';
  }

  // The request parameters the engine did not reject. Rendered verbatim: this list is
  // what explains why a capability or an effort level is missing elsewhere.
  //
  // 引擎未拒绝的请求参数。原样渲染：它正是"为什么某能力或挡位不在其它列里"的解释。
  function renderParams(params) {
    if (!params || !params.length) return '<span style="color:var(--text-1)">—</span>';
    return '<div class="mp-list">' + params.map(function (p) {
      return '<div class="mp-params">' + esc(p) + '</div>';
    }).join('') + '</div>';
  }

  function renderProbeTable(models) {
    var tbody = $('mp-tbody');
    if (!tbody) return;
    if (!models || !models.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">' + t('mp.empty') + '</td></tr>';
      return;
    }
    tbody.innerHTML = models.map(function (m) {
      // One entry per line: a seven-level list or a long error must stay readable
      // instead of squeezing the neighbouring columns into one letter per line.
      //
      // 每行一条：七级挡位或很长的报错必须保持可读，而不是把旁边的列挤成一行一个字母。
      var efforts = m.status === 'unprobeable'
        ? '<span style="color:var(--text-1)">' + t('mp.unprobeable') + '</span>'
        : '<div class="mp-list">' + (m.supported_efforts || []).map(function (level) {
            return '<div class="mp-params">' + esc(level) + '</div>';
          }).join('') + '</div>';
      if (!m.supported_efforts || !m.supported_efforts.length) {
        if (m.status !== 'unprobeable') efforts = '<span style="color:var(--text-1)">—</span>';
      }
      if (m.last_error) {
        efforts += '<div class="mp-error">' + esc(m.last_error) + '</div>';
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
        '<td style="white-space:nowrap;">' + probeStatusBadge(m.status) + reprobe + '</td>' +
        '</tr>';
    }).join('');
  }

  // Last server-known settings; fallback for the immediate-save paths so toggling the
  // switch never submits half-edited probe parameters.
  //
  // 最近一次服务端设置的快照；立即保存路径的参数回退来源，保证切换开关不会连带提交
  // 尚未保存完毕的探测参数。
  var _probeSettings = null;

  function buildProbeBody(enabled, budgetOverride, exposeOverride, heartbeatOverride) {
    var base = _probeSettings || { enabled: true, timeout: 30, wait: 5, budget: 40, heartbeatInterval: 0, exposeInstanceMeta: true };
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
      expose_instance_meta: exposeOverride !== undefined ? exposeOverride : base.exposeInstanceMeta !== false,
      // Same override pattern for the patrol interval: the select saves immediately,
      // while the explicit Save round-trips the loaded seconds untouched.
      //
      // 巡检间隔沿用同样的覆盖模式：下拉框立即保存，显式「保存」则把已载入的秒数
      // 原样回传。
      heartbeat_interval: heartbeatOverride !== undefined ? heartbeatOverride : (base.heartbeatInterval === undefined ? 0 : base.heartbeatInterval)
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

  // The heartbeat select saves immediately, like the probe switch: the patrol interval
  // is not one of the "Save"-gated parameters, and the coordinator re-arms on this save.
  //
  // 心跳下拉框与探测开关一样立即保存：巡检间隔不属于按「保存」生效的参数，协调者会在
  // 这次保存后立即重排。
  function saveProbeHeartbeat(value) {
    // The select's values are SECONDS from the shared granularity table (0 = off);
    // the historical name of this variable wrongly suggested hours.
    //
    // 下拉框的取值是共享档位表的**秒数**（0 = 关闭）；这个变量的旧名字误作 hours。
    var seconds = parseInt(value, 10);
    if (isNaN(seconds)) return;
    api('/admin/api/probe/settings', { method: 'POST', body: buildProbeBody(undefined, undefined, undefined, seconds) })
      .then(function (data) { _probeSettings = data.settings; toast(t('mp.saved'), 'ok'); })
      .catch(function (err) {
        toast(etext(err.message), 'err');
        loadProbe(); // revert the select to the persisted value / 恢复为已保存的值
      });
  }

  // Heartbeat steps arrive from the server in SECONDS (the shared granularity table,
  // same source as the usage-tracking select); only the display labels live here.
  //
  // 心跳档位由服务端以秒下发（共享刻度表，与「使用记录粒度」下拉框同源）；展示文案
  // 保留在本端。
  var HEARTBEAT_LABELS = {
    '86400': 'mp.hb_daily',
    '43200': 'mp.hb_12h',
    '21600': 'mp.hb_6h',
    '10800': 'mp.hb_3h',
    '3600': 'mp.hb_hourly',
    '1800': 'mp.hb_30m',
    '0': 'mp.hb_off'
  };

  function fillHeartbeatSelect(current, options) {
    var sel = $('mp-heartbeat-select');
    if (!sel) return;
    sel.innerHTML = '';
    var opts = options && options.length ? options : [86400, 43200, 21600, 10800, 3600, 1800, 0];
    for (var i = 0; i < opts.length; i++) {
      var value = String(opts[i]);
      var option = document.createElement('option');
      option.value = value;
      option.textContent = t(HEARTBEAT_LABELS[value] || value);
      sel.appendChild(option);
    }
    // 0 (off) is a legitimate selection, so the usual truthiness check would drop it.
    // 0（关闭）是合法选择，常规的真值判断会把它丢掉。
    if (current !== null && current !== undefined) sel.value = String(current);
  }

  function loadProbe() {
    api('/admin/api/probe').then(function (data) {
      if (!$('mp-enabled-select')) return;
      _probeSettings = data.settings;
      $('mp-enabled-select').value = data.settings.enabled ? 'on' : 'off';
      toggleProbeDetail(data.settings.enabled);
      $('mp-budget').value = String(data.settings.budget);
      if ($('mp-expose-select')) $('mp-expose-select').value = data.settings.exposeInstanceMeta === false ? 'off' : 'on';
      $('mp-timeout').value = String(data.settings.timeout);
      $('mp-wait').value = String(data.settings.wait);
      // An old payload without the field must read as "off", not as a bogus selection.
      // 缺字段的旧响应必须按"关闭"处理，而不是变成一个错误的选中项。
      fillHeartbeatSelect(data.settings.heartbeatInterval === undefined ? 0 : data.settings.heartbeatInterval, data.heartbeatOptions);
      renderProbeTable(data.models);
      reportProbeFailures(data.models);
    }).catch(function (err) {
      // 401 is already handled by api(); skip to avoid duplicate toasts
      // 401 已由 api() 统一提示（仅会话过期时），此处跳过避免重复弹窗
      if (err && err.message === 'not authed') return;
      toast(etext(err.message), 'err');
    });
  }

  // Whether the round banner (set by a "Probe Now" click) is still the current message.
  // Once it is, a failure report may replace it; while it is fresh, a clean load must
  // not wipe it.
  //
  // 「立即探测」设置的轮次横幅是否仍是当前消息。是的话，失败报告可以取代它；而一次
  // 干净的加载不能把它抹掉。
  var _probeRoundBanner = false;

  // A failed probe is a persistent condition, not a toast: as long as any model sits
  // in the failed state with an error, the round banner box shows it in red on every
  // load, so the operator cannot scroll past it. A partial model keeps its quieter
  // in-table treatment (its copy is a counter, not an error message).
  //
  // 探测失败是持续状态，而不是一条弹窗：只要有模型停在 failed 且带错误，这个轮次横幅
  // 框就在每次加载时以红色显示它，运维不可能看漏。partial 保持表格内较轻的呈现（它的
  // 文案是计数，不是错误消息）。
  function reportProbeFailures(models) {
    var failed = (models || []).filter(function (m) {
      return m.status === 'failed' && m.last_error;
    });
    if (failed.length > 0) {
      _probeRoundBanner = false;
      var error = String(failed[0].last_error || '');
      if (error.length > 220) error = error.slice(0, 220) + '…';
      setBanner('mp-banner', 'err', function () {
        return tfmt('mp.failed_banner', { count: failed.length, error: error });
      });
    } else if (!_probeRoundBanner) {
      clearBanner('mp-banner');
    }
  }

  function saveProbeSettings(btn) {
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
    setLoading(btn, true);
    api('/admin/api/probe/settings', {
      method: 'POST',
      body: {
        enabled: _probeSettings.enabled,
        timeout: timeoutSec,
        wait: waitSec,
        budget: budget,
        // Round-tripped untouched: the patrol interval is not edited by this form.
        // 原样回传：巡检间隔不由本表单编辑。
        heartbeat_interval: _probeSettings.heartbeatInterval === undefined ? 0 : _probeSettings.heartbeatInterval,
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

  function refreshProbe(btn, model) {
    setLoading(btn, true);
    clearBanner('mp-banner');
    api('/admin/api/probe/refresh', { method: 'POST', body: model ? { model: model } : {} })
      .then(function () {
        // Ack-and-poll: the round runs on the coordinator's alarm in the background
        // (a full round can outlive an HTTP invocation), so the banner only announces
        // the submission and the table refreshes on timers. Persistent failures still
        // surface via reportProbeFailures() on each refresh.
        //
        // 应答后轮询：轮次由协调者的 alarm 在后台执行（完整轮次可能超出一次 HTTP
        // 调用的生存期），因此横幅只宣布"已提交"，表格改由定时器刷新。持续性失败
        // 仍会在每次刷新时经 reportProbeFailures() 呈现。
        setBanner('mp-banner', 'info', function () { return t('mp.refresh_accepted'); });
        _probeRoundBanner = true;
        loadProbe();
        [3, 10, 25, 45].forEach(function (seconds) {
          setTimeout(function () { if (_authed) loadProbe(); }, seconds * 1000);
        });
      })
      .catch(function (err) {
        _probeRoundBanner = false;
        setBanner('mp-banner', 'err', function () { return etext(err.message); });
      })
      .finally(function () { setLoading(btn, false); });
  }

  // Per-model re-probe (row button); the id travels in a data attribute so quoting
  // can never break the markup.
  //
  // 单模型重探（行内按钮）；id 走 data 属性，因此引号永远不会破坏标记。
  function probeOneModel(btn) {
    var model = btn && btn.getAttribute ? btn.getAttribute('data-probe-model') : '';
    if (model) refreshProbe(btn, model);
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
      _touchInterval = status.touchInterval;
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
  function testSession(btn) {
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
  function checkSession(btn) {
    setLoading(btn, true);
    clearBanner('status-banner');
    api('/admin/api/session/check', { method: 'POST' })
      .then(function (data) {
        setBanner('status-banner', data.test.ok ? 'ok' : 'warn', function () { return testDetail(data.test); });
      })
      .catch(function (err) { setBanner('status-banner', 'err', function () { return etext(err.message); }); })
      .finally(function () { setLoading(btn, false); });
  }

  function importSession(btn, force) {
    setLoading(btn, true);
    clearBanner('session-banner');
    api('/admin/api/session', {
      method: 'POST',
      // force: true only after the operator confirms the failed connectivity test
      // — the server refuses to overwrite a (possibly still working) session on a
      // dead test otherwise.
      //
      // force: true 仅在运维确认连通性测试失败后附加——否则服务端会拒绝在测试未过时
      // 覆盖（可能仍可用的）现有 Session。
      body: { json: $('session-json').value, test: true, save: true, force: force === true }
    })
      .then(function (data) {
        setBanner('session-banner', 'ok', function () {
          return t('up.import_ok') + (data.test ? ' ' + testDetail(data.test) : '') + t('up.import_summary') + data.summary;
        });
        loadStatus();
      })
      .catch(function (err) {
        // The server refused the overwrite because the test failed: ask once, and
        // retry with force when the operator confirms.
        //
        // 服务端因测试未通过而拒绝覆盖：询问一次，运维确认后携带 force 重试。
        if (err && err.payload && err.payload.needForce) {
          setLoading(btn, false);
          if (confirm(t('up.import_force_confirm'))) { importSession(btn, true); }
          else { setBanner('session-banner', 'warn', function () { return etext('err.session_test_failed'); }); }
          return;
        }
        setBanner('session-banner', 'err', function () { return etext(err.message); });
      })
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

  // Last known usage-tracking interval; 0 means the feature is off and the
  // "Last Used" column shows a disabled notice instead of (stale) timestamps.
  //
  // 最近一次已知的记录粒度；0 表示功能已关闭，「最近使用」列显示停用提示，
  // 而不是（可能过时的）时间戳。
  var _touchInterval = null;

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
    // Buttons bind to the key VALUE via a data attribute instead of the array
    // index: a second tab mutating _keys between render and click would otherwise
    // make "row 2" point at a different key. esc() escapes quotes too, so the
    // value cannot break out of the attribute.
    //
    // 按钮经 data 属性绑定**键值**而不是数组下标：否则另一个标签页在渲染与点击之间
    // 改动 _keys 时，"第 2 行"会指向另一把 Key。esc() 连引号也转义，取值逃不出属性。
    tbody.innerHTML = _keys.map(function (k) {
      var created = new Date(k.created_at * 1000).toLocaleString();
      // Tracking off hides even historical timestamps: the column must never
      // suggest "this key was used recently" from data that can no longer update.
      //
      // 关闭记录后连历史时间戳也一并隐藏：这一列绝不能再用已经不再更新的数据，
      // 暗示"这个 Key 最近用过"。
      var used = _touchInterval === 0
        ? t('keys.tracking_disabled')
        : (k.last_used ? new Date(k.last_used * 1000).toLocaleString() : t('keys.never_used'));
      return '<tr>' +
        '<td>' + esc(k.name) + '</td>' +
        '<td class="mono">' + esc(k.masked) + '</td>' +
        '<td>' + created + '</td>' +
        '<td>' + used + '</td>' +
        '<td style="text-align:right; white-space:nowrap;">' +
          '<button class="btn btn-ghost btn-sm" data-key="' + esc(k.key) + '" onclick="rotateKey(this)">' + t('keys.rotate') + '</button> ' +
          '<button class="btn btn-danger btn-sm" data-key="' + esc(k.key) + '" onclick="deleteKey(this)">' + t('common.delete') + '</button>' +
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

  function deleteKey(btn) {
    var key = btn && btn.getAttribute ? btn.getAttribute('data-key') : '';
    // Resolve by value, not by position: another tab may have changed _keys since
    // this row was rendered.
    //
    // 按值解析而不是按位置：渲染之后另一个标签页可能已改动 _keys。
    var idx = _keys.findIndex(function (k) { return k.key === key; });
    if (idx < 0) return;
    var keyRecord = _keys[idx];
    if (!confirm(t('keys.del_confirm') + '[' + keyRecord.name + ']' + t('keys.del_confirm_end'))) return;
    api('/admin/api/keys', { method: 'DELETE', body: { key: keyRecord.key } })
      .then(function () {
        toast(t('keys.deleted'), 'ok');
        // Remove locally first: the KV list index is eventually consistent and
        // an immediate re-list may still return the deleted key.
        //
        // 先在本地移除：KV list 索引是最终一致的，立即重新拉取
        // 可能仍返回已删除的 Key。
        _keys.splice(idx, 1);
        renderKeys();
        loadStatus();
        loadKeys(); // overwrite with the server list once it has caught up / 服务端列表同步后覆盖
      })
      .catch(function (err) { toast(etext(err.message), 'err'); });
  }

  function rotateKey(btn) {
    var key = btn && btn.getAttribute ? btn.getAttribute('data-key') : '';
    var idx = _keys.findIndex(function (k) { return k.key === key; });
    if (idx < 0) return;
    var keyRecord = _keys[idx];
    if (!confirm(t('keys.rotate_confirm') + '[' + keyRecord.name + ']' + t('keys.rotate_confirm_end'))) return;
    api('/admin/api/keys/rotate', { method: 'POST', body: { key: keyRecord.key } })
      .then(function (data) {
        // Replace the row locally (same write-after-read compensation as
        // create/delete), then force the one-time copy modal for the new key.
        //
        // 本地替换该行（与创建/删除相同的写后读补偿机制），随后弹出
        // 新 Key 的一次性复制弹窗。
        _keys[idx] = {
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
    // Element-content serialization only escapes & < >; values that also land
    // inside double-quoted attributes (e.g. data-probe-model="...") need the
    // quotes escaped too, or a crafted model id could break out of the attribute.
    //
    // 元素内容序列化只转义 & < >；同样落进双引号属性的取值（如
    // data-probe-model="..."）还需要转义引号，否则构造的模型 id 可以逃出属性。
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
