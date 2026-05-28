// ============================================================
// src/web-gui.ts — Web 管理界面 HTML + API 路由
// ============================================================

import type { Env } from './types';
import { readPrompts } from './config';
import { getLogs, clearLogs } from './log-buffer';

// ---- KV 键名常量 ----
const KV_KEYS = {
  system: 'system_prompt',
  pre: 'pre_prompt',
  post: 'post_prompt',
} as const;

/**
 * 处理 /admin/api/* 请求
 */
export async function handleApiRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, '');

  // GET /admin/api/prompts — 获取三层提示词
  if (pathname === '/admin/api/prompts' && request.method === 'GET') {
    const prompts = await readPrompts(env);
    return jsonResponse({
      systemPrompt: prompts.systemPrompt,
      prePrompt: prompts.prePrompt,
      postPrompt: prompts.postPrompt,
    });
  }

  // PUT /admin/api/prompts — 更新提示词
  if (pathname === '/admin/api/prompts' && request.method === 'PUT') {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const updates: Promise<void>[] = [];

      if (typeof body.systemPrompt === 'string') {
        updates.push(env.PROMPT_KV.put(KV_KEYS.system, body.systemPrompt));
      }
      if (typeof body.prePrompt === 'string') {
        updates.push(env.PROMPT_KV.put(KV_KEYS.pre, body.prePrompt));
      }
      if (typeof body.postPrompt === 'string') {
        updates.push(env.PROMPT_KV.put(KV_KEYS.post, body.postPrompt));
      }

      if (updates.length === 0) {
        return jsonResponse({ error: '没有提供任何需要更新的字段' }, 400);
      }

      await Promise.all(updates);
      console.log('[API] 提示词已更新');

      return jsonResponse({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`[API] 更新提示词失败: ${message}`);
      return jsonResponse({ error: message }, 500);
    }
  }

  // GET /admin/api/config — 获取只读配置
  if (pathname === '/admin/api/config' && request.method === 'GET') {
    return jsonResponse({
      allowList: env.ALLOWED_SENDERS || '',
      aiBaseUrl: env.AI_BASE_URL || 'https://api.openai.com/v1',
      aiModel: env.AI_MODEL || 'gpt-4o',
      senderEmail: env.SENDER_EMAIL || '',
      senderName: env.SENDER_NAME || '',
    });
  }

  // GET /admin/api/logs — 获取日志列表
  if (pathname === '/admin/api/logs' && request.method === 'GET') {
    return jsonResponse(getLogs());
  }

  // DELETE /admin/api/logs — 清空日志
  if (pathname === '/admin/api/logs' && request.method === 'DELETE') {
    clearLogs();
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

/**
 * 返回管理界面完整 HTML 页面
 */
export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Email AI Agent — 管理面板</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e1e4eb;
    --text-muted: #8b8fa3;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --success: #22c55e;
    --danger: #ef4444;
    --radius: 10px;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .container {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 20px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(99, 102, 241, 0.15);
    color: var(--accent-hover);
    border: 1px solid rgba(99, 102, 241, 0.3);
  }
  .badge::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 24px;
    background: var(--surface);
    border-radius: var(--radius);
    padding: 4px;
    border: 1px solid var(--border);
  }
  .tab-btn {
    flex: 1;
    padding: 10px 20px;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: var(--text-muted);
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .tab-btn:hover { color: var(--text); background: rgba(255,255,255,0.05); }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card-header h3 {
    font-size: 1rem;
    font-weight: 600;
  }
  .char-count {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .field-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .field-hint {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 6px;
  }
  textarea {
    width: 100%;
    min-height: 140px;
    padding: 14px 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.85rem;
    line-height: 1.7;
    resize: vertical;
    transition: border-color 0.2s;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 24px;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-primary {
    background: var(--accent);
    color: #fff;
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .config-table {
    width: 100%;
    border-collapse: collapse;
  }
  .config-table th,
  .config-table td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .config-table th {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 600;
    width: 180px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .config-table td {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.85rem;
    word-break: break-all;
  }
  .config-table td .readonly-tag {
    display: inline-block;
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(139, 143, 163, 0.12);
    color: var(--text-muted);
    margin-left: 10px;
  }

  .toast {
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 14px 22px;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    z-index: 1000;
    animation: slideIn 0.3s ease, fadeOut 0.3s ease 2.7s forwards;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  .toast.success { background: #14532d; color: #86efac; border: 1px solid #22c55e40; }
  .toast.error { background: #450a0a; color: #fca5a5; border: 1px solid #ef444440; }

  @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes fadeOut { to { opacity: 0; transform: translateY(-10px); } }

  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-muted);
  }
  .empty-state svg { margin-bottom: 16px; opacity: 0.4; }

  /* ===== 日志面板 ===== */
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .auto-refresh-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.75); }
  }
  .log-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 65vh;
    overflow-y: auto;
    padding-right: 4px;
  }
  .log-list::-webkit-scrollbar { width: 6px; }
  .log-list::-webkit-scrollbar-track { background: transparent; }
  .log-list::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .log-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    transition: border-color 0.2s, background 0.2s;
  }
  .log-card.type-email_accepted,
  .log-card.type-resend_sent { border-left-color: var(--success); }
  .log-card.type-ai_reply { border-left-color: var(--accent); }
  .log-card.type-email_rejected,
  .log-card.type-ai_error,
  .log-card.type-resend_error,
  .log-card.type-system { border-left-color: var(--danger); }
  .log-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  .log-type-badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .badge-accepted, .badge-sent { background: rgba(34,197,94,0.12); color: var(--success); }
  .badge-reply { background: rgba(99,102,241,0.12); color: var(--accent-hover); }
  .badge-error { background: rgba(239,68,68,0.12); color: var(--danger); }
  .log-time {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .log-duration {
    font-size: 0.7rem;
    color: var(--text-muted);
    background: rgba(139,143,163,0.1);
    padding: 1px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .log-summary {
    font-size: 0.88rem;
    color: var(--text);
    word-break: break-word;
    margin-bottom: 4px;
  }
  .log-card.has-detail { cursor: pointer; }
  .log-card.has-detail:hover { background: rgba(255,255,255,0.03); }
  .log-expand-hint {
    font-size: 0.7rem;
    color: var(--accent);
    margin-top: 2px;
  }
  .log-detail {
    display: none;
    margin-top: 10px;
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
  }
  .log-detail.open { display: block; }
  .log-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  @media (max-width: 640px) {
    .container { padding: 20px 14px; }
    .card { padding: 18px; }
    header { flex-direction: column; align-items: flex-start; gap: 12px; }
    .log-toolbar { flex-direction: column; align-items: stretch; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>&#9993; Email AI Agent</h1>
    </div>
    <span class="badge">已连接</span>
  </header>

  <div class="tabs">
    <button class="tab-btn active" data-tab="prompts">&#9881; 提示词管理</button>
    <button class="tab-btn" data-tab="config">&#128269; 配置查看</button>
    <button class="tab-btn" data-tab="logs">&#128202; 日志监控</button>
  </div>

  <!-- Tab: 提示词管理 -->
  <div class="tab-panel active" id="panel-prompts">
    <div class="card">
      <div class="card-header">
        <h3>System Prompt — AI 角色定义</h3>
        <span class="char-count" id="count-system">0 字符</span>
      </div>
      <label class="field-label">系统提示词</label>
      <textarea id="input-system" placeholder="定义 AI 的行为、身份和回复风格..."></textarea>
      <p class="field-hint">作为 system 消息发送给 AI，定义其角色和核心行为准则。</p>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Pre Prompt — 正文前指令</h3>
        <span class="char-count" id="count-pre">0 字符</span>
      </div>
      <label class="field-label">正文前提示词</label>
      <textarea id="input-pre" placeholder="在邮件正文之前插入的引导指令..."></textarea>
      <p class="field-hint">插入在邮件正文 <strong>之前</strong>，用于设置任务目标或上下文说明。</p>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Post Prompt — 正文后指令</h3>
        <span class="char-count" id="count-post">0 字符</span>
      </div>
      <label class="field-label">正文后提示词</label>
      <textarea id="input-post" placeholder="在邮件正文之后插入的回复要求..."></textarea>
      <p class="field-hint">插入在邮件正文 <strong>之后</strong>，用于指定回复格式、约束条件等。</p>
    </div>

    <div style="display:flex;gap:12px;align-items:center;">
      <button class="btn btn-primary" id="btn-save" onclick="savePrompts()">
        &#128190; 保存提示词
      </button>
      <span id="save-status" style="font-size:0.85rem;color:var(--text-muted);"></span>
    </div>
  </div>

  <!-- Tab: 配置查看 -->
  <div class="tab-panel" id="panel-config">
    <div class="card">
      <h3 style="margin-bottom:16px;">运行配置</h3>
      <table class="config-table">
        <thead>
          <tr><th>配置项</th><th>值</th></tr>
        </thead>
        <tbody id="config-body">
          <tr><td colspan="2" class="empty-state">加载中...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Tab: 日志监控 -->
  <div class="tab-panel" id="panel-logs">
    <div class="log-toolbar">
      <button class="btn btn-primary" id="btn-refresh-logs" onclick="loadLogs()">
        &#8635; 手动刷新
      </button>
      <span class="auto-refresh-indicator" id="auto-refresh-indicator">
        <span class="pulse-dot"></span> 自动刷新中 (5s)
      </span>
    </div>
    <div class="log-list" id="log-list">
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <p>暂无日志记录</p>
        <p style="font-size:0.8rem;margin-top:4px;">当有邮件到达或 API 调用发生时，日志将在此实时显示</p>
      </div>
    </div>
  </div>
</div>

<script>
  // ===== Tab 切换 =====
  let autoRefreshTimer = null;

  function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    const indicator = document.getElementById('auto-refresh-indicator');
    if (indicator) indicator.style.display = 'none';
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    const indicator = document.getElementById('auto-refresh-indicator');
    if (indicator) indicator.style.display = '';
    loadLogs();
    autoRefreshTimer = setInterval(loadLogs, 5000);
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      stopAutoRefresh();
      if (btn.dataset.tab === 'config') loadConfig();
      if (btn.dataset.tab === 'logs') startAutoRefresh();
    });
  });

  // ===== 字符计数 =====
  ['system', 'pre', 'post'].forEach(type => {
    const el = document.getElementById('input-' + type);
    el.addEventListener('input', () => {
      document.getElementById('count-' + type).textContent = el.value.length + ' 字符';
    });
  });

  // ===== 加载提示词 =====
  async function loadPrompts() {
    try {
      const res = await fetch(location.pathname.replace(/\\/?$/, '/') + 'api/prompts' + location.search);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      document.getElementById('input-system').value = data.systemPrompt || '';
      document.getElementById('input-pre').value = data.prePrompt || '';
      document.getElementById('input-post').value = data.postPrompt || '';
      ['system', 'pre', 'post'].forEach(type => {
        const el = document.getElementById('input-' + type);
        document.getElementById('count-' + type).textContent = el.value.length + ' 字符';
      });
    } catch (err) {
      showToast('加载提示词失败: ' + err.message, 'error');
    }
  }

  // ===== 保存提示词 =====
  async function savePrompts() {
    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 保存中...';
    document.getElementById('save-status').textContent = '';

    const body = {
      systemPrompt: document.getElementById('input-system').value,
      prePrompt: document.getElementById('input-pre').value,
      postPrompt: document.getElementById('input-post').value,
    };

    try {
      const res = await fetch(location.pathname.replace(/\\/?$/, '/') + 'api/prompts' + location.search, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      showToast('提示词已保存成功', 'success');
      document.getElementById('save-status').textContent = '\u2714 已保存 ' + new Date().toLocaleTimeString();
    } catch (err) {
      showToast('保存失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128190; 保存提示词';
    }
  }

  // ===== 加载配置 =====
  async function loadConfig() {
    const tbody = document.getElementById('config-body');
    tbody.innerHTML = '<tr><td colspan="2" class="empty-state">加载中...</td></tr>';
    try {
      const res = await fetch(location.pathname.replace(/\\/?$/, '/') + 'api/config' + location.search);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rows = [
        ['ALLOWED_SENDERS', data.allowList || '(空)'],
        ['AI_BASE_URL', data.aiBaseUrl || '(空)'],
        ['AI_MODEL', data.aiModel || '(空)'],
        ['SENDER_EMAIL', data.senderEmail || '(空)'],
        ['SENDER_NAME', data.senderName || '(空)'],
      ];
      tbody.innerHTML = rows.map(([k, v]) =>
        '<tr><td>' + escapeHtml(k) + ' <span class="readonly-tag">只读</span></td><td>' + escapeHtml(v) + '</td></tr>'
      ).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-state">加载失败: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  // ===== Toast =====
  function showToast(msg, type) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ===== 日志渲染 =====
  const LOG_TYPE_LABELS = {
    email_accepted: '邮件接收',
    email_rejected: '白名单拒绝',
    ai_reply: 'AI 回复',
    ai_error: 'AI 错误',
    resend_sent: '发送成功',
    resend_error: '发送失败',
    system: '系统',
  };

  const LOG_BADGE_CLASS = {
    email_accepted: 'badge-accepted',
    email_rejected: 'badge-error',
    ai_reply: 'badge-reply',
    ai_error: 'badge-error',
    resend_sent: 'badge-sent',
    resend_error: 'badge-error',
    system: 'badge-error',
  };

  function formatTime(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  async function loadLogs() {
    const list = document.getElementById('log-list');
    try {
      const res = await fetch(location.pathname.replace(/\\/?$/, '/') + 'api/logs' + location.search);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const logs = await res.json();

      if (!logs || logs.length === 0) {
        list.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>暂无日志记录</p><p style="font-size:0.8rem;margin-top:4px;">当有邮件到达或 API 调用发生时，日志将在此实时显示</p></div>';
        return;
      }

      // 倒序渲染（最新在前）
      const reversed = logs.slice().reverse();
      list.innerHTML = reversed.map(log => {
        const hasDetail = !!log.detail;
        const badgeClass = LOG_BADGE_CLASS[log.type] || 'badge-accepted';
        const typeLabel = LOG_TYPE_LABELS[log.type] || log.type;

        let metaHtml = '';
        if (log.metadata && log.metadata.from) {
          metaHtml += '<span style="font-size:0.75rem;color:var(--text-muted);">' + escapeHtml(String(log.metadata.from)) + '</span>';
        }
        if (log.metadata && log.metadata.subject) {
          metaHtml += '<span style="font-size:0.75rem;color:var(--text-muted);">' + escapeHtml(String(log.metadata.subject)) + '</span>';
        }

        const durationHtml = log.durationMs != null
          ? '<span class="log-duration">' + log.durationMs + 'ms</span>'
          : '';

        return (
          '<div class="log-card type-' + log.type + (hasDetail ? ' has-detail' : '') + '"' +
          (hasDetail ? ' data-detail-id="' + log.id + '"' : '') + '>' +
          '<div class="log-card-header">' +
          '<span class="log-type-badge ' + badgeClass + '">' + escapeHtml(typeLabel) + '</span>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
          durationHtml +
          '<span class="log-time">' + formatTime(log.timestamp) + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="log-summary">' + escapeHtml(log.summary) + '</div>' +
          (metaHtml ? '<div class="log-meta">' + metaHtml + '</div>' : '') +
          (hasDetail
            ? '<div class="log-expand-hint">&#9660; 点击展开 AI 回复详情</div>' +
              '<div class="log-detail">' + escapeHtml(log.detail) + '</div>'
            : '') +
          '</div>'
        );
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-state"><p style="color:var(--danger);">加载日志失败: ' + escapeHtml(err.message) + '</p></div>';
    }
  }

  // ===== 日志卡片点击展开（事件委托） =====
  document.getElementById('log-list').addEventListener('click', function(e) {
    const card = e.target.closest('.log-card.has-detail');
    if (!card) return;
    const detail = card.querySelector('.log-detail');
    if (detail) detail.classList.toggle('open');
  });

  // ===== 初始化 =====
  loadPrompts();
</script>
</body>
</html>`;
}

/** 构造 JSON 响应 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
