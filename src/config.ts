// ============================================================
// src/config.ts — 环境变量读取 & 校验
// ============================================================

import type { AIConfig, Env, PromptConfig } from './types';

/** 默认系统提示词（当 KV 中无值时使用） */
export const DEFAULT_SYSTEM_PROMPT = `你是一个友好的 AI 邮件助手。请根据收到的邮件内容，生成简洁、专业、有帮助的回复。
- 使用与发件人相同的语言回复
- 保持回复简洁明了
- 如果是问题，请直接回答
- 署名使用 "AI Assistant"`;

/** 默认正文前提示词（当 KV 中无值时使用） */
export const DEFAULT_PRE_PROMPT = '请根据以下邮件内容生成回复。';

/** 默认正文后提示词（当 KV 中无值时使用） */
export const DEFAULT_POST_PROMPT = '请直接输出回复内容，不要包含邮件头信息（如 From、To、Subject 等）。';

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
 * 从 KV 读取三层提示词，无值则 fallback 到默认值
 *
 * KV 键名:
 *   - system_prompt: AI 角色定义
 *   - pre_prompt:    正文前指令
 *   - post_prompt:   正文后指令
 */
export async function readPrompts(env: Env): Promise<PromptConfig> {
  const [systemPrompt, prePrompt, postPrompt] = await Promise.all([
    env.PROMPT_KV.get('system_prompt'),
    env.PROMPT_KV.get('pre_prompt'),
    env.PROMPT_KV.get('post_prompt'),
  ]);

  return {
    systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
    prePrompt: prePrompt || DEFAULT_PRE_PROMPT,
    postPrompt: postPrompt || DEFAULT_POST_PROMPT,
  };
}

/**
 * 获取鉴权 Token
 */
export function getAuthToken(env: Env): string {
  return env.AUTH_TOKEN || '';
}
