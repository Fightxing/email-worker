// ============================================================
// src/ai-client.ts — OpenAI 兼容 API 调用
// ============================================================

import type { AIConfig, AIMessage, AIResponse } from './types';
import { AI_TIMEOUT_MS, AI_MAX_RETRIES } from './config';

/** AI API 调用错误 */
export class AIClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseBody?: string,
  ) {
    super(message);
    this.name = 'AIClientError';
  }
}

/**
 * 调用 AI API 生成邮件回复
 *
 * 支持自动重试（最多 AI_MAX_RETRIES 次）
 * 超时时间 AI_TIMEOUT_MS
 *
 * @param messages 消息列表
 * @param config   AI API 配置
 * @returns AI 生成的回复文本
 */
export async function generateReply(
  messages: AIMessage[],
  config: AIConfig,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.7,
          max_tokens: 128000,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new AIClientError(
          `AI API 返回错误 (${response.status}): ${errorBody}`,
          response.status,
          errorBody,
        );
      }

      const data = (await response.json()) as AIResponse;

      const replyText = data.choices?.[0]?.message?.content;
      if (!replyText) {
        throw new AIClientError('AI API 返回了空的回复内容');
      }

      return replyText.trim();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // 如果是 abort 超时，包装为 AIClientError
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new AIClientError(`AI API 请求超时 (${AI_TIMEOUT_MS / 1000}s)`);
      }

      // 最后一次尝试不再重试
      if (attempt < AI_MAX_RETRIES) {
        // 指数退避: 1s, 2s
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError || new AIClientError('AI API 调用失败（已达最大重试次数）');
}

/** 延时工具函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
