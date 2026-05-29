// ============================================================
// src/web-gui.ts — Web 管理界面 HTML + API 路由
// ============================================================

import type { Env, PromptConfig, ParsedEmail, AIMessage } from './types';
import { readPrompts, getAIConfig, DEFAULT_SYSTEM_PROMPT, DEFAULT_PRE_PROMPT, DEFAULT_POST_PROMPT } from './config';
import { buildMessages } from './prompt-builder';

// ---- KV 键名常量 ----
const KV_KEYS = {
  system: 'system_prompt',
  pre: 'pre_prompt',
  post: 'post_prompt',
} as const;

// ---- 内存预览缓存（仅存在于当前 Worker isolate，随 isolate 销毁而丢失）----
const previewCache = new Map<string, string>();
const PREVIEW_KEYS = {
  system: 'preview_system',
  pre: 'preview_pre',
  post: 'preview_post',
} as const;

/** 生成用于预览的示例邮件 */
function sampleEmail(): ParsedEmail {
  return {
    from: 'alice@example.com',
    to: 'bot@example.com',
    subject: '关于下周项目进度的讨论',
    text: '你好，\n\n我想确认一下下周的项目里程碑是否按计划进行。附件是当前的进度报告，请查阅。\n\n另外，关于客户提到的性能优化需求，你认为我们需要多长时间来完成？\n\n谢谢，\nAlice',
    html: '',
    attachments: [
      {
        filename: 'progress_report.pdf',
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

  // PUT /admin/api/prompts/preview — 暂存提示词到内存（不写 KV）
  if (pathname === '/admin/api/prompts/preview' && request.method === 'PUT') {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      let updated = 0;

      if (typeof body.systemPrompt === 'string') {
        previewCache.set(PREVIEW_KEYS.system, body.systemPrompt);
        updated++;
      }
      if (typeof body.prePrompt === 'string') {
        previewCache.set(PREVIEW_KEYS.pre, body.prePrompt);
        updated++;
      }
      if (typeof body.postPrompt === 'string') {
        previewCache.set(PREVIEW_KEYS.post, body.postPrompt);
        updated++;
      }

      if (updated === 0) {
        return jsonResponse({ error: '没有提供任何需要更新的字段' }, 400);
      }

      console.log('[API] 提示词已暂存到内存预览缓存');
      return jsonResponse({ success: true, cached: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[API] 暂存提示词失败: ${message}`);
      return jsonResponse({ error: message }, 500);
    }
  }

  // GET /admin/api/preview — 预览完整的 AI 请求体
  if (pathname === '/admin/api/preview' && request.method === 'GET') {
    try {
      // 优先使用内存预览缓存，fallback 到 KV
      const prompts: PromptConfig = {
        systemPrompt:
          previewCache.get(PREVIEW_KEYS.system) ||
          (await env.PROMPT_KV.get(KV_KEYS.system)) ||
          DEFAULT_SYSTEM_PROMPT,
        prePrompt:
          previewCache.get(PREVIEW_KEYS.pre) ||
          (await env.PROMPT_KV.get(KV_KEYS.pre)) ||
          DEFAULT_PRE_PROMPT,
        postPrompt:
          previewCache.get(PREVIEW_KEYS.post) ||
          (await env.PROMPT_KV.get(KV_KEYS.post)) ||
          DEFAULT_POST_PROMPT,
      };

      const email = sampleEmail();
      const messages: AIMessage[] = buildMessages(email, prompts);

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
    const sources: Record<string, string> = {};
    for (const key of ['system', 'pre', 'post'] as const) {
      const pk = PREVIEW_KEYS[key];
      sources[key] = previewCache.has(pk) ? 'memory' : 'kv';
    }
    return jsonResponse(sources);
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
    max-width: 960px;
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
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: rgba(255,255,255,0.05); border-color: var(--text-muted); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

  .source-tag {
    display: inline-block;
    font-size: 0.7rem;
    padding: 2px 10px;
    border-radius: 4px;
    font-weight: 600;
    margin-left: 8px;
    text-transform: uppercase;
  }
  .source-tag.kv { background: rgba(34, 197, 94, 0.12); color: var(--success); }
  .source-tag.memory { background: rgba(245, 158, 11, 0.12); color: var(--warning); }

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
    width: 200px;
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

  .json-preview {
    width: 100%;
    min-height: 400px;
    max-height: 70vh;
    padding: 18px 20px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: #a5d6ff;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.82rem;
    line-height: 1.6;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    resize: vertical;
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
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .status-text {
    font-size: 0.85rem;
    color: var(--text-muted);
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

  @media (max-width: 640px) {
    .container { padding: 20px 14px; }
    .card { padding: 18px; }
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
    <button class="tab-btn active" data-tab="prompts">&#9881; 提示词管理</button>
    <button class="tab-btn" data-tab="preview">&#128270; 请求预览</button>
    <button class="tab-btn" data-tab="config">&#128196; 配置查看</button>
  </div>

  <!-- Tab: 提示词管理 -->
  <div class="tab-panel active" id="panel-prompts">
    <div class="card">
      <div class="card-header">
        <h3>System Prompt — AI 角色定义 <span class="source-tag kv" id="source-system">KV</span></h3>
        <span class="char-count" id="count-system">0 字符</span>
      </div>
      <label class="field-label">系统提示词</label>
      <textarea id="input-system" placeholder="定义 AI 的行为、身份和回复风格..."></textarea>
      <p class="field-hint">作为 system 消息发送给 AI，定义其角色和核心行为准则。</p>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Pre Prompt — 正文前指令 <span class="source-tag kv" id="source-pre">KV</span></h3>
        <span class="char-count" id="count-pre">0 字符</span>
      </div>
      <label class="field-label">正文前提示词</label>
      <textarea id="input-pre" placeholder="在邮件正文之前插入的引导指令..."></textarea>
      <p class="field-hint">插入在邮件正文 <strong>之前</strong>，用于设置任务目标或上下文说明。</p>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Post Prompt — 正文后指令 <span class="source-tag kv" id="source-post">KV</span></h3>
        <span class="char-count" id="count-post">0 字符</span>
      </div>
      <label class="field-label">正文后提示词</label>
      <textarea id="input-post" placeholder="在邮件正文之后插入的回复要求..."></textarea>
      <p class="field-hint">插入在邮件正文 <strong>之后</strong>，用于指定回复格式、约束条件等。</p>
    </div>

    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-preview-save" onclick="saveForPreview()">
        &#128065; 暂存以预览
      </button>
      <button class="btn btn-primary" id="btn-save-kv" onclick="saveToKV()">
        &#128190; 写入 KV 数据库
      </button>
      <span class="status-text" id="save-status"></span>
    </div>
    <p style="margin-top:10px;font-size:0.8rem;color:var(--text-muted);">
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
      <p class="field-hint" style="margin-bottom:12px;">
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
  // ===== Tab 切换 =====
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'config') loadConfig();
      if (btn.dataset.tab === 'preview') refreshPreview();
    });
  });

  // ===== 字符计数 =====
  ['system', 'pre', 'post'].forEach(type => {
    const el = document.getElementById('input-' + type);
    el.addEventListener('input', () => {
      document.getElementById('count-' + type).textContent = el.value.length + ' 字符';
    });
  });

  // ===== 加载提示词 & 来源标识 =====
  async function loadPrompts() {
    try {
      const [promptsRes, sourceRes] = await Promise.all([
        fetch(apiPath('api/prompts')),
        fetch(apiPath('api/prompts/source')),
      ]);
      if (!promptsRes.ok) throw new Error('HTTP ' + promptsRes.status);
      const data = await promptsRes.json();
      document.getElementById('input-system').value = data.systemPrompt || '';
      document.getElementById('input-pre').value = data.prePrompt || '';
      document.getElementById('input-post').value = data.postPrompt || '';
      ['system', 'pre', 'post'].forEach(type => {
        const el = document.getElementById('input-' + type);
        document.getElementById('count-' + type).textContent = el.value.length + ' 字符';
      });

      // 更新来源标识
      if (sourceRes.ok) {
        const sources = await sourceRes.json();
        updateSourceBadges(sources);
      }
    } catch (err) {
      showToast('加载提示词失败: ' + err.message, 'error');
    }
  }

  function updateSourceBadges(sources) {
    ['system', 'pre', 'post'].forEach(type => {
      const badge = document.getElementById('source-' + type);
      if (!badge) return;
      const src = sources[type] || 'kv';
      badge.textContent = src.toUpperCase();
      badge.className = 'source-tag ' + (src === 'memory' ? 'memory' : 'kv');
    });
  }

  // ===== 暂存以预览（仅写入内存，不写 KV）=====
  async function saveForPreview() {
    const btn = document.getElementById('btn-preview-save');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 暂存中...';
    document.getElementById('save-status').textContent = '';

    const body = {
      systemPrompt: document.getElementById('input-system').value,
      prePrompt: document.getElementById('input-pre').value,
      postPrompt: document.getElementById('input-post').value,
    };

    try {
      const res = await fetch(apiPath('api/prompts/preview'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      showToast('提示词已暂存到内存（可预览，未持久化）', 'success');
      document.getElementById('save-status').textContent = '\\u2714 已暂存到内存 ' + new Date().toLocaleTimeString();
      // 更新来源标识
      updateSourceBadges({ system: 'memory', pre: 'memory', post: 'memory' });
    } catch (err) {
      showToast('暂存失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128065; 暂存以预览';
    }
  }

  // ===== 写入 KV 数据库（持久化）=====
  async function saveToKV() {
    const btn = document.getElementById('btn-save-kv');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 写入中...';
    document.getElementById('save-status').textContent = '';

    const body = {
      systemPrompt: document.getElementById('input-system').value,
      prePrompt: document.getElementById('input-pre').value,
      postPrompt: document.getElementById('input-post').value,
    };

    try {
      const res = await fetch(apiPath('api/prompts'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      showToast('提示词已写入 KV 数据库', 'success');
      document.getElementById('save-status').textContent = '\\u2714 已持久化 ' + new Date().toLocaleTimeString();
      // 更新来源标识
      updateSourceBadges({ system: 'kv', pre: 'kv', post: 'kv' });
    } catch (err) {
      showToast('写入 KV 失败: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#128190; 写入 KV 数据库';
    }
  }

  // ===== 刷新预览 =====
  async function refreshPreview() {
    const output = document.getElementById('preview-output');
    const status = document.getElementById('preview-status');
    const btn = document.getElementById('btn-refresh-preview');
    btn.disabled = true;
    btn.innerHTML = '&#9203; 加载中...';
    status.textContent = '';

    try {
      const res = await fetch(apiPath('api/preview'));
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      const data = await res.json();
      output.innerHTML = syntaxHighlight(JSON.stringify(data, null, 2));
      status.textContent = '\\u2714 已刷新 ' + new Date().toLocaleTimeString();

      // 更新来源标识
      const sourceRes = await fetch(apiPath('api/prompts/source'));
      if (sourceRes.ok) {
        const sources = await sourceRes.json();
        updateSourceBadges(sources);
        const memCount = Object.values(sources).filter(s => s === 'memory').length;
        const badge = document.getElementById('preview-source-badge');
        if (memCount > 0) {
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

  // ===== JSON 语法高亮 =====
  function syntaxHighlight(json) {
    return json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(
        /("(\\\\u[\\da-fA-F]{4}|\\\\[^u]|[^"\\\\])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\\\-]?\\d+)?)/g,
        function (match) {
          let cls = 'json-number';
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

  // ===== 加载配置 =====
  async function loadConfig() {
    const tbody = document.getElementById('config-body');
    tbody.innerHTML = '<tr><td colspan="2" class="empty-state">加载中...</td></tr>';
    try {
      const res = await fetch(apiPath('api/config'));
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

  // ===== 辅助函数 =====
  function apiPath(suffix) {
    return location.pathname.replace(/\\/?$/, '/') + suffix + location.search;
  }

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
