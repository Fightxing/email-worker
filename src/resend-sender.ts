// ============================================================
// src/resend-sender.ts — 通过 Resend API 发送回信
// ============================================================

import type { ParsedEmail, Env, ResendEmailPayload } from './types';
import { RESEND_API_BASE_URL, RESEND_TIMEOUT_MS } from './config';

/** Resend API 错误 */
export class ResendError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseBody?: string,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

/**
 * 通过 Resend API 发送 AI 生成的回复邮件
 *
 * @param parsedEmail  原始解析邮件
 * @param replyText     AI 生成的回复内容
 * @param env           环境变量
 */
export async function sendReply(
  parsedEmail: ParsedEmail,
  replyText: string,
  env: Env,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    throw new ResendError('RESEND_API_KEY 未配置，请通过 wrangler secret put RESEND_API_KEY 设置');
  }

  const senderEmail = env.SENDER_EMAIL;
  const senderName = env.SENDER_NAME || 'AI Assistant';

  if (!senderEmail) {
    throw new ResendError('SENDER_EMAIL 未配置');
  }

  // 构建发件人字符串: "Name <email>"
  const from = `${senderName} <${senderEmail}>`;

  // 构建邮件主题（加 Re: 前缀）
  const subject = parsedEmail.subject.startsWith('Re:')
    ? parsedEmail.subject
    : `Re: ${parsedEmail.subject}`;

  // 构建自定义邮件头（保持线程）
  const headers: Record<string, string> = {};
  if (parsedEmail.messageId) {
    headers['In-Reply-To'] = parsedEmail.messageId;
  }
  if (parsedEmail.references) {
    headers['References'] = parsedEmail.references;
  } else if (parsedEmail.messageId) {
    headers['References'] = parsedEmail.messageId;
  }

  const payload: ResendEmailPayload = {
    from,
    to: parsedEmail.from,
    subject,
    text: replyText,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${RESEND_API_BASE_URL}/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Cloudflare-Email-AI-Agent/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ResendError(
        `Resend API 返回错误 (${response.status}): ${errorBody}`,
        response.status,
        errorBody,
      );
    }
  } catch (error) {
    if (error instanceof ResendError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ResendError(`Resend API 请求超时 (${RESEND_TIMEOUT_MS / 1000}s)`);
    }
    throw new ResendError(
      `Resend API 调用失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
