// ============================================================
// src/config.ts — 环境变量读取 & 校验
// ============================================================

import type { AIConfig, Env, PromptBlock } from './types';

/** KV 键名 — 提示词块（单一 JSON 键存储全部块） */
export const KV_PROMPT_BLOCKS_KEY = 'prompt_blocks';

/** 旧 KV 键名（用于迁移） */
const OLD_KV_KEYS = ['system_prompt', 'pre_prompt', 'post_prompt'] as const;

/** 默认提示词块预设（2 个块，等价旧版 3 层提示词） */
export const DEFAULT_PROMPT_BLOCKS: PromptBlock[] = [
  {
    id: 'sys-default',
    name: '系统角色',
    role: 'system',
    content: `你是一个友好的 AI 邮件助手。请根据收到的邮件内容，生成简洁、专业、有帮助的回复。
- 使用与发件人相同的语言回复
- 保持回复简洁明了
- 如果是问题，请直接回答
- 署名使用 "AI Assistant"`,
    enabled: true,
    sortOrder: 0,
    mergeWithPrevious: true,
  },
  {
    id: 'user-default',
    name: '用户消息（含邮件）',
    role: 'user',
    content: `请根据以下邮件内容生成回复。

{{email_full}}

请直接输出回复内容，不要包含邮件头信息（如 From、To、Subject 等）。`,
    enabled: true,
    sortOrder: 10,
    mergeWithPrevious: true,
  },
];

/** 默认 AI 配置 */
const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-4o';

/** 支持的图片 MIME 类型 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * 文本附件检测 — 字节探测采样大小（字节）
 *
 * 对附件前 N 字节进行可打印字符占比分析，
 * 避免读取超大文件全文造成 CPU 开销。
 */
export const TEXT_PROBE_SIZE = 4096;

/**
 * 文本附件检测 — 可打印字符占比阈值
 *
 * 当采样字节中可打印字符（含常见空白符、UTF-8 多字节序列）
 * 占比 >= 该值时，判定为文本文件。
 */
export const TEXT_DETECTION_THRESHOLD = 0.95;

/**
 * 文本附件最大字符数
 *
 * 文本附件内容在发送给 AI 时，截取前 N 个字符，
 * 防止超大文本文件撑爆 AI 上下文窗口。
 */
export const MAX_TEXT_ATTACHMENT_CHARS = 1000000;

/**
 * 已知文本 MIME 类型（用于预筛选，减少不必要的字节探测）
 *
 * 所有 text/* 类型自动命中，此处列出常见的 application/* 文本类型。
 */
export const KNOWN_TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-latex',
  'application/rtf',
]);

/** AI API 超时时间（毫秒） */
export const AI_TIMEOUT_MS = 300_000;

/** AI API 最大重试次数 */
export const AI_MAX_RETRIES = 2;

/** Resend API 超时时间（毫秒） */
export const RESEND_TIMEOUT_MS = 15_000;

/** Resend API 基础 URL */
export const RESEND_API_BASE_URL = 'https://api.resend.com';

/**
 * 从环境变量读取并校验 AI 配置
 */
export function getAIConfig(env: Env): AIConfig {
  const baseUrl = env.AI_BASE_URL || DEFAULT_AI_BASE_URL;
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const apiKey = env.AI_API_KEY;

  if (!apiKey) {
    throw new Error('AI_API_KEY 未配置，请通过 wrangler secret put AI_API_KEY 设置');
  }

  return { baseUrl, apiKey, model };
}

/**
 * 读取白名单列表（逗号分隔）
 */
export function getAllowedSenders(env: Env): string[] {
  const raw = env.ALLOWED_SENDERS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 获取发件人显示名称和地址
 */
export function getSenderInfo(env: Env): { email: string; name: string } {
  const email = env.SENDER_EMAIL;
  const name = env.SENDER_NAME || 'AI Assistant';

  if (!email) {
    throw new Error('SENDER_EMAIL 未配置');
  }

  return { email, name };
}

/**
 * 从 KV 读取提示词块列表
 *
 * 优先级:
 *   1. 读取 KV 键 prompt_blocks（新格式，JSON 数组）
 *   2. 若不存在，尝试从旧 3 键迁移（自动构建 2 个 PromptBlock 并写入新键，删除旧键）
 *   3. 若旧键也不存在，返回 DEFAULT_PROMPT_BLOCKS
 */
export async function readPrompts(env: Env): Promise<PromptBlock[]> {
  // 1. 尝试读取新格式
  const newData = await env.PROMPT_KV.get(KV_PROMPT_BLOCKS_KEY);
  if (newData) {
    try {
      const blocks = JSON.parse(newData) as PromptBlock[];
      if (Array.isArray(blocks) && blocks.length > 0) {
        return blocks;
      }
    } catch {
      console.warn('[CONFIG] prompt_blocks JSON 解析失败，将尝试迁移或使用默认值');
    }
  }

  // 2. 尝试从旧 3 键迁移
  const [systemPrompt, prePrompt, postPrompt] = await Promise.all([
    env.PROMPT_KV.get('system_prompt'),
    env.PROMPT_KV.get('pre_prompt'),
    env.PROMPT_KV.get('post_prompt'),
  ]);

  if (systemPrompt || prePrompt || postPrompt) {
    console.log('[CONFIG] 检测到旧格式提示词，执行自动迁移...');

    const migratedBlocks: PromptBlock[] = [
      {
        id: 'sys-migrated',
        name: '系统角色（已迁移）',
        role: 'system',
        content: systemPrompt || DEFAULT_PROMPT_BLOCKS[0].content,
        enabled: true,
        sortOrder: 0,
        mergeWithPrevious: true,
      },
      {
        id: 'user-migrated',
        name: '用户消息（已迁移）',
        role: 'user',
        content: [
          prePrompt || '',
          '{{email_full}}',
          postPrompt || '',
        ].filter(Boolean).join('\n\n'),
        enabled: true,
        sortOrder: 10,
        mergeWithPrevious: true,
      },
    ];

    // 写入新格式
    await env.PROMPT_KV.put(KV_PROMPT_BLOCKS_KEY, JSON.stringify(migratedBlocks));
    console.log('[CONFIG] 迁移完成，已写入 prompt_blocks');

    // 删除旧键
    await Promise.all(OLD_KV_KEYS.map((key) => env.PROMPT_KV.delete(key)));
    console.log('[CONFIG] 旧键已删除:', OLD_KV_KEYS.join(', '));

    return migratedBlocks;
  }

  // 3. 返回默认预设
  console.log('[CONFIG] 无 KV 数据，使用默认提示词块');
  return [...DEFAULT_PROMPT_BLOCKS];
}

/**
 * 获取鉴权 Token
 */
export function getAuthToken(env: Env): string {
  return env.AUTH_TOKEN || '';
}
