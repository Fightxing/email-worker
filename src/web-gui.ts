// ============================================================
// src/web-gui.ts — Web 管理界面 HTML + API 路由
// ============================================================

import type { Env, ParsedEmail, AIMessage, PromptBlock } from './types';
import { readPrompts, getAIConfig, DEFAULT_PROMPT_BLOCKS, KV_PROMPT_BLOCKS_KEY } from './config';
import { buildMessages } from './prompt-builder';

// ---- 内存预览缓存（仅存在于当前 Worker isolate，随 isolate 销毁而丢失）----
let previewBlocksCache: PromptBlock[] | null = null;

/** 所有可用的模板变量及其说明 */
const TEMPLATE_VARIABLES = [
  { var: 'email_from', desc: '发件人地址' },
  { var: 'email_to', desc: '收件人地址' },
  { var: 'email_subject', desc: '邮件主题' },
  { var: 'email_body', desc: '纯文本正文（优先 text，其次去标签 HTML）' },
  { var: 'email_text_attachments', desc: '文本附件内容（含文件名/MIME/大小/截断标记）' },
  { var: 'email_attachment_list', desc: '非文本附件列表（仅文件名/大小）' },
  { var: 'email_full', desc: '以上全部组合（from + subject + body + attachments）' },
  { var: 'conversation_context', desc: '对话树上下文' },
];

/** 生成用于预览的示例邮件 */
function sampleEmail(): ParsedEmail {
  return {
    from: 'test@example.com',
    to: 'bot@example.com',
    subject: '测试主题',
    text: '测试正文测试正文测试正文测试正文',
    html: '',
    attachments: [
      {
        filename: 'test.pdf',
        mimeType: 'application/pdf',
        size: 245760,
      },
    ],
    messageId: '<demo-123@example.com>',
    inReplyTo: '',
    references: '',
  };
}

/**
 * 处理 /admin/api/* 请求
 */
export async function handleApiRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, '');

  // GET /admin/api/prompts — 获取提示词块列表
  if (pathname === '/admin/api/prompts' && request.method === 'GET') {
    const blocks = await readPrompts(env);
    return jsonResponse(blocks);
  }

  // PUT /admin/api/prompts — 持久化提示词块到 KV
  if (pathname === '/admin/api/prompts' && request.method === 'PUT') {
    try {
      const body = (await request.json()) as { blocks?: PromptBlock[] };
      if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
        return jsonResponse({ error: 'blocks 必须是非空数组' }, 400);
      }
      await env.PROMPT_KV.put(KV_PROMPT_BLOCKS_KEY, JSON.stringify(body.blocks));
      console.log(`[API] 提示词块已写入 KV (${body.blocks.length} 个块)`);
      return jsonResponse({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[API] 写入提示词块失败: ${message}`);
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

  // PUT /admin/api/prompts/preview — 暂存提示词块到内存（不写 KV）
  if (pathname === '/admin/api/prompts/preview' && request.method === 'PUT') {
    try {
      const body = (await request.json()) as { blocks?: PromptBlock[] };
      if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
        return jsonResponse({ error: 'blocks 必须是非空数组' }, 400);
      }
      previewBlocksCache = body.blocks;
      console.log(`[API] 提示词块已暂存到内存 (${body.blocks.length} 个块)`);
      return jsonResponse({ success: true, cached: body.blocks.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[API] 暂存提示词块失败: ${message}`);
      return jsonResponse({ error: message }, 500);
    }
  }

  // GET /admin/api/preview — 预览完整的 AI 请求体
  if (pathname === '/admin/api/preview' && request.method === 'GET') {
    try {
      // 优先使用内存预览缓存，fallback 到 KV
      let blocks: PromptBlock[];
      if (previewBlocksCache) {
        blocks = previewBlocksCache;
      } else {
        blocks = await readPrompts(env);
      }

      const email = sampleEmail();
      const messages: AIMessage[] = buildMessages(email, blocks);

      let aiConfig;
      try {
        aiConfig = getAIConfig(env);
      } catch {
        aiConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: '***', model: 'gpt-4o' };
      }

      return jsonResponse({
        endpoint: `${aiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiConfig.apiKey.replace(/./g, '*')}`,
        },
        body: {
          model: aiConfig.model,
          messages,
          temperature: 0.7,
          max_tokens: 128000,
        },
        _note: '此为基于示例邮件构建的预览请求体，实际邮件内容会不同。提示词优先使用内存预览缓存。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[API] 预览请求失败: ${message}`);
      return jsonResponse({ error: message }, 500);
    }
  }

  // GET /admin/api/prompts/source — 查询提示词来源（内存 vs KV）
  if (pathname === '/admin/api/prompts/source' && request.method === 'GET') {
    return jsonResponse({
      source: previewBlocksCache ? 'memory' : 'kv',
    });
  }

  // GET /admin/api/prompts/variables — 获取可用模板变量列表
  if (pathname === '/admin/api/prompts/variables' && request.method === 'GET') {
    return jsonResponse(TEMPLATE_VARIABLES);
  }

  // GET /admin/api/prompts/defaults — 获取默认预设
  if (pathname === '/admin/api/prompts/defaults' && request.method === 'GET') {
    return jsonResponse(DEFAULT_PROMPT_BLOCKS);
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
    --warning: #f59e0b;
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
    max-width: 1000px;
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
  h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
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
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .tabs {
    display: flex; gap: 4px; margin-bottom: 24px;
    background: var(--surface);
    border-radius: var(--radius);
    padding: 4px;
    border: 1px solid var(--border);
  }
  .tab-btn {
    flex: 1; padding: 10px 20px;
    background: transparent; border: none;
    border-radius: 7px; color: var(--text-muted);
    font-size: 0.9rem; font-weight: 500;
    cursor: pointer; transition: all 0.2s;
  }
  .tab-btn:hover { color: var(--text); background: rgba(255,255,255,0.05); }
  .tab-btn.active { background: var(--accent); color: #fff; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .card-header h3 { font-size: 0.95rem; font-weight: 600; }
  .card-body { display: flex; flex-direction: column; gap: 10px; }
  .card-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .card-row label {
    font-size: 0.8rem;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 50px;
  }
  .char-count { font-size: 0.75rem; color: var(--text-muted); }
  input[type="text"], select {
    padding: 7px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }
  input[type="text"]:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
  }
  textarea {
    width: 100%;
    min-height: 100px;
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    line-height: 1.6;
    resize: vertical;
    transition: border-color 0.2s;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border: none;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: rgba(255,255,255,0.05); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .btn-danger:hover { background: rgba(239,68,68,0.10); }
  .btn-sm { padding: 5px 10px; font-size: 0.8rem; }

  .source-tag {
    display: inline-block;
    font-size: 0.7rem;
    padding: 2px 10px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .source-tag.kv { background: rgba(34,197,94,0.12); color: var(--success); }
  .source-tag.memory { background: rgba(245,158,11,0.12); color: var(--warning); }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .toggle input { display: none; }
  .toggle .switch {
    width: 36px; height: 20px;
    background: var(--border);
    border-radius: 10px;
    position: relative;
    transition: background 0.2s;
  }
  .toggle .switch::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle input:checked + .switch {
    background: var(--accent);
  }
  .toggle input:checked + .switch::after {
    transform: translateX(16px);
  }

  .sort-btns {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sort-btns button {
    width: 26px; height: 20px;
    padding: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.7rem;
    line-height: 1;
  }
  .sort-btns button:hover { color: var(--text); border-color: var(--text-muted); }
  .sort-btns button:disabled { opacity: 0.3; cursor: not-allowed; }

  .order-num {
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 24px;
    text-align: center;
    font-weight: 600;
  }

  .var-panel {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 20px;
    overflow: hidden;
    transition: max-height 0.3s;
  }
  .var-panel.collapsed { max-height: 38px; }
  .var-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
  }
  .var-panel-header h3 { font-size: 0.9rem; }
  .var-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .var-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    background: rgba(99,102,241,0.1);
    border: 1px solid rgba(99,102,241,0.25);
    border-radius: 6px;
    font-size: 0.78rem;
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent-hover);
    cursor: pointer;
    transition: background 0.2s;
  }
  .var-chip:hover { background: rgba(99,102,241,0.2); }
  .var-chip .var-name { font-weight: 600; }
  .var-chip .var-desc { color: var(--text-muted); font-size: 0.7rem; }

  .config-table {
    width: 100%;
    border-collapse: collapse;
  }
  .config-table th, .config-table td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .config-table th {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .config-table td {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.85rem;
    word-break: break-all;
  }
  .readonly-tag {
    display: inline-block;
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(139,143,163,0.12);
    color: var(--text-muted);
    margin-left: 10px;
  }

  .json-preview {
    width: 100%;
    min-height: 400px;
    max-height: 70vh;
    padding: 18px 20px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: #a5d6ff;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    line-height: 1.6;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    tab-size: 2;
  }
  .json-preview:empty::after {
    content: '点击「刷新预览」加载 AI 请求体...';
    color: var(--text-muted);
    font-style: italic;
  }
  .json-key { color: #79c0ff; }
  .json-string { color: #a5d6ff; }
  .json-number { color: #ffa657; }
  .json-boolean { color: #56d364; }

  .btn-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .status-text { font-size: 0.85rem; color: var(--text-muted); }

  .toast {
    position: fixed;
    top: 20px; right: 20px;
    padding: 14px 22px;
    border-radius: 10px;
    font-size: 0.9rem; font-weight: 500;
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
    padding: 36px 24px;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .hint-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .container { padding: 20px 14px; }
    .card { padding: 14px; }
    .card-row { flex-direction: column; align-items: flex-start; }
    header { flex-direction: column; align-items: flex-start; gap: 12px; }
    .btn-row { flex-direction: column; align-items: stretch; }
    .btn-row .btn { justify-content: center; }
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
    <button class="tab-btn active" data-tab="prompts">&#9881; 提示词块管理</button>
    <button class="tab-btn" data-tab="preview">&#128270; 请求预览</button>
    <button class="tab-btn" data-tab="config">&#128196; 配置查看</button>
  </div>

  <!-- Tab: 提示词块管理 -->
  <div class="tab-panel active" id="panel-prompts">
    <!-- 变量参考面板 -->
    <div class="var-panel" id="var-panel">
      <div class="var-panel-header" onclick="toggleVarPanel()">
        <h3>&#128218; 模板变量参考</h3>
        <span style="color:var(--text-muted);font-size:0.8rem;" id="var-toggle-icon">&#9650;</span>
      </div>
      <div class="var-list" id="var-list"></div>
    </div>

    <!-- 块列表容器 -->
    <div id="blocks-container">
      <div class="empty-state">加载中...</div>
    </div>

    <!-- 底部按钮 -->
    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-add-block" onclick="addBlock()">
        &#10133; 新建块
      </button>
      <button class="btn btn-secondary" id="btn-reset-default" onclick="resetToDefaults()">
        &#8635; 重置为默认
      </button>
      <button class="btn btn-secondary" id="btn-preview-save" onclick="saveForPreview()">
        &#128065; 暂存以预览
      </button>
      <button class="btn btn-primary" id="btn-save-kv" onclick="saveToKV()">
        &#128190; 写入 KV 数据库
      </button>
      <span class="status-text" id="save-status"></span>
    </div>
    <p class="hint-text" style="margin-top:10px;">
      <strong>暂存以预览</strong>：仅保存到当前 Worker 内存，用于在「请求预览」标签中查看效果，Worker 销毁后丢失。<br>
      <strong>写入 KV 数据库</strong>：持久化到 Cloudflare KV，实际邮件处理时将使用此版本。
    </p>
  </div>

  <!-- Tab: 请求预览 -->
  <div class="tab-panel" id="panel-preview">
    <div class="card">
      <div class="card-header">
        <h3>发送给 AI 后端的完整请求体</h3>
        <span id="preview-source-badge" style="font-size:0.8rem;color:var(--text-muted);"></span>
      </div>
      <p class="hint-text" style="margin-bottom:12px;">
        以下为基于<strong>示例邮件</strong>构建的 JSON 请求体预览。提示词优先使用内存暂存版本（如有），否则使用 KV 版本。
      </p>
      <pre class="json-preview" id="preview-output"></pre>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-refresh-preview" onclick="refreshPreview()">
        &#128260; 刷新预览
      </button>
      <span class="status-text" id="preview-status"></span>
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
</div>

<script>
  // ===== Global State =====
  let blocks = [];
  let sourceType = 'kv';

  function uuid() {
    return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ===== Tab Switching =====
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'config') loadConfig();
      if (btn.dataset.tab === 'preview') refreshPreview();
    });
  });

  // ===== Variable Reference Panel =====
  function toggleVarPanel() {
    var panel = document.getElementById('var-panel');
    var icon = document.getElementById('var-toggle-icon');
    var list = document.getElementById('var-list');
    if (panel.classList.contains('collapsed')) {
      panel.classList.remove('collapsed');
      icon.innerHTML = '&#9650;';
      list.style.display = '';
    } else {
      panel.classList.add('collapsed');
      icon.innerHTML = '&#9660;';
      list.style.display = 'none';
    }
  }

  function insertVar(varName) {
    var active = document.activeElement;
    if (active && active.tagName === 'TEXTAREA') {
      var start = active.selectionStart;
      var end = active.selectionEnd;
      var text = active.value;
      active.value = text.slice(0, start) + '{{' + varName + '}}' + text.slice(end);
      active.selectionStart = active.selectionEnd = start + varName.length + 4;
      active.dispatchEvent(new Event('input'));
      active.focus();
    }
  }

  async function loadVariables() {
    try {
      var res = await fetch(apiPath('api/prompts/variables'));
      if (!res.ok) return;
      var vars = await res.json();
      var container = document.getElementById('var-list');
      container.innerHTML = vars.map(function(v) {
        return '<span class="var-chip" onclick="insertVar(\\'' + v.var + '\\')" title="' + escapeAttr(v.desc) + '">' +
        '<span class="var-name">' + escapeHtml('{{' + v.var + '}}') + '</span>' +
        '<span class="var-desc">' + escapeHtml(v.desc) + '</span>' +
        '</span>';
      }).join('');
    } catch (e) { /* silent */ }
  }

  // ===== Render Blocks =====
  function renderBlocks() {
    var container = document.getElementById('blocks-container');
    if (blocks.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无提示词块，点击「新建块」开始</div>';
      return;
    }

    var sorted = blocks.slice().sort(function(a, b) { return a.sortOrder - b.sortOrder; });

    container.innerHTML = sorted.map(function(block, pos) {
      var isFirst = pos === 0;
      var isLast = pos === sorted.length - 1;
      var bid = block.id;
      return '<div class="card" data-block-id="' + bid + '">' +
        '<div class="card-header">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<div class="sort-btns">' +
              '<button onclick="moveBlock(\\'' + bid + '\\', -1)" ' + (isFirst ? 'disabled' : '') + '>&#9650;</button>' +
              '<button onclick="moveBlock(\\'' + bid + '\\', 1)" ' + (isLast ? 'disabled' : '') + '>&#9660;</button>' +
            '</div>' +
            '<span class="order-num">#' + (pos + 1) + '</span>' +
            '<input type="text" value="' + escapeAttr(block.name) + '" placeholder="块名称" ' +
              'onchange="updateBlock(\\'' + bid + '\\', \\'name\\', this.value)" style="min-width:140px;">' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<label class="toggle">' +
              '<input type="checkbox" ' + (block.enabled ? 'checked' : '') + ' onchange="updateBlock(\\'' + bid + '\\', \\'enabled\\', this.checked)">' +
              '<span class="switch"></span>启用' +
            '</label>' +
            '<span style="color:var(--text-muted);font-size:0.7rem;">sort:' + block.sortOrder + '</span>' +
            '<button class="btn btn-danger btn-sm" onclick="deleteBlock(\\'' + bid + '\\')">&#128465;</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="card-row">' +
            '<label>角色:</label>' +
            '<select onchange="updateBlock(\\'' + bid + '\\', \\'role\\', this.value)">' +
              '<option value="system" ' + (block.role === 'system' ? 'selected' : '') + '>system</option>' +
              '<option value="user" ' + (block.role === 'user' ? 'selected' : '') + '>user</option>' +
              '<option value="assistant" ' + (block.role === 'assistant' ? 'selected' : '') + '>assistant</option>' +
            '</select>' +
            '<label class="toggle">' +
              '<input type="checkbox" ' + (block.mergeWithPrevious ? 'checked' : '') + ' onchange="updateBlock(\\'' + bid + '\\', \\'mergeWithPrevious\\', this.checked)">' +
              '<span class="switch"></span>合并到前一条' +
            '</label>' +
          '</div>' +
          '<textarea placeholder="提示词内容，可使用 {{变量}} 占位符..." oninput="onContentInput(\\'' + bid + '\\', this)">' +
            escapeHtml(block.content) +
          '</textarea>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="char-count" id="count-' + bid + '">' + block.content.length + ' 字符</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateBlock(blockId, field, value) {
    var block = blocks.find(function(b) { return b.id === blockId; });
    if (!block) return;
    block[field] = value;
    if (field === 'content') {
      var el = document.getElementById('count-' + blockId);
      if (el) el.textContent = value.length + ' 字符';
    }
  }

  function onContentInput(blockId, textarea) {
    var block = blocks.find(function(b) { return b.id === blockId; });
    if (!block) return;
    block.content = textarea.value;
    var el = document.getElementById('count-' + blockId);
    if (el) el.textContent = textarea.value.length + ' 字符';
  }

  function moveBlock(blockId, direction) {
    var sorted = blocks.slice().sort(function(a, b) { return a.sortOrder - b.sortOrder; });
    var idx = sorted.findIndex(function(b) { return b.id === blockId; });
    if (idx < 0) return;
    var target = idx + direction;
    if (target < 0 || target >= sorted.length) return;
    var tmp = sorted[idx].sortOrder;
    sorted[idx].sortOrder = sorted[target].sortOrder;
    sorted[target].sortOrder = tmp;
    blocks = sorted.slice();
    renderBlocks();
  }

  function addBlock() {
    var maxOrder = blocks.length > 0
      ? Math.max.apply(null, blocks.map(function(b) { return b.sortOrder; }))
      : 0;
    blocks.push({
      id: uuid(),
      name: '新建块',
      role: 'user',
      content: '',
      enabled: true,
      sortOrder: maxOrder + 10,
      mergeWithPrevious: true,
    });
    renderBlocks();
  }

  function deleteBlock(blockId) {
    var block = blocks.find(function(b) { return b.id === blockId; });
    if (!block) return;
    if (!confirm('确定删除块「' + block.name + '」？此操作不可撤销。')) return;
    blocks = blocks.filter(function(b) { return b.id !== blockId; });
    renderBlocks();
  }

  async function resetToDefaults() {
    if (!confirm('确定重置为默认预设？当前所有提示词块将被替换。')) return;
    try {
      var res = await fetch(apiPath('api/prompts/defaults'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blocks = await res.json();
      renderBlocks();
      showToast('已加载默认预设', 'success');
    } catch (err) {
      showToast('加载默认预设失败: ' + err.message, 'error');
    }
  }

  async function loadPrompts() {
    try {
      var blocksRes = await fetch(apiPath('api/prompts'));
      var sourceRes = await fetch(apiPath('api/prompts/source'));
      if (!blocksRes.ok) throw new Error('HTTP ' + blocksRes.status);
      blocks = await blocksRes.json();
      renderBlocks();

      if (sourceRes.ok) {
        var data = await sourceRes.json();
        sourceType = data.source || 'kv';
      }
    } catch (err) {
      showToast('加载提示词失败: ' + err.message, 'error');
    }
  }

  async function saveForPreview() {
    var btn = document.getElementById('btn-preview-save');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 暂存中...';
    document.getElementById('save-status').textContent = '';

    try {
      var res = await fetch(apiPath('api/prompts/preview'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: blocks }),
      });
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      sourceType = 'memory';
      showToast('提示词已暂存到内存（可预览，未持久化）', 'success');
      document.getElementById('save-status').textContent = '\\u2714 已暂存到内存 ' + new Date().toLocaleTimeString();
    } catch (err) {
      showToast('暂存失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128065; 暂存以预览';
    }
  }

  async function saveToKV() {
    var btn = document.getElementById('btn-save-kv');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 写入中...';
    document.getElementById('save-status').textContent = '';

    try {
      var res = await fetch(apiPath('api/prompts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: blocks }),
      });
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      sourceType = 'kv';
      showToast('提示词已写入 KV 数据库', 'success');
      document.getElementById('save-status').textContent = '\\u2714 已持久化 ' + new Date().toLocaleTimeString();
    } catch (err) {
      showToast('写入 KV 失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128190; 写入 KV 数据库';
    }
  }

  async function refreshPreview() {
    var output = document.getElementById('preview-output');
    var status = document.getElementById('preview-status');
    var btn = document.getElementById('btn-refresh-preview');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 加载中...';
    status.textContent = '';

    try {
      var res = await fetch(apiPath('api/preview'));
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      var data = await res.json();
      output.innerHTML = syntaxHighlight(JSON.stringify(data, null, 2));
      status.textContent = '\\u2714 已刷新 ' + new Date().toLocaleTimeString();

      var sourceRes = await fetch(apiPath('api/prompts/source'));
      if (sourceRes.ok) {
        var s = await sourceRes.json();
        var badge = document.getElementById('preview-source-badge');
        if (s.source === 'memory') {
          badge.innerHTML = '<span class="source-tag memory">内存预览</span>';
        } else {
          badge.innerHTML = '<span class="source-tag kv">KV 持久化</span>';
        }
      }
    } catch (err) {
      output.innerHTML = '';
      status.textContent = '加载失败: ' + err.message;
      showToast('预览加载失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128260; 刷新预览';
    }
  }

  function syntaxHighlight(json) {
    return json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(
        /("(\\\\u[\\da-fA-F]{4}|\\\\[^u]|[^"\\\\])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
        function (match) {
          var cls = 'json-number';
          if (/^"/.test(match)) {
            if (/:$/.test(match)) {
              cls = 'json-key';
            } else {
              cls = 'json-string';
            }
          } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
          } else if (/null/.test(match)) {
            cls = 'json-number';
          }
          return '<span class="' + cls + '">' + match + '</span>';
        }
      );
  }

  async function loadConfig() {
    var tbody = document.getElementById('config-body');
    tbody.innerHTML = '<tr><td colspan="2" class="empty-state">加载中...</td></tr>';
    try {
      var res = await fetch(apiPath('api/config'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var rows = [
        ['ALLOWED_SENDERS', data.allowList || '(空)'],
        ['AI_BASE_URL', data.aiBaseUrl || '(空)'],
        ['AI_MODEL', data.aiModel || '(空)'],
        ['SENDER_EMAIL', data.senderEmail || '(空)'],
        ['SENDER_NAME', data.senderName || '(空)'],
      ];
      tbody.innerHTML = rows.map(function(row) {
        return '<tr><td>' + escapeHtml(row[0]) + ' <span class="readonly-tag">只读</span></td><td>' + escapeHtml(row[1]) + '</td></tr>';
      }).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-state">加载失败: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function apiPath(suffix) {
    return location.pathname.replace(/\\/?$/, '/') + suffix + location.search;
  }

  function showToast(msg, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3000);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  }

  loadPrompts();
  loadVariables();
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
