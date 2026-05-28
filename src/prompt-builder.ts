// ============================================================
// src/prompt-builder.ts — 构建 OpenAI 兼容 multimodal messages
// ============================================================

import type { ParsedEmail, AIMessage, AIMessageContent, PromptConfig } from './types';
import { SUPPORTED_IMAGE_TYPES, MAX_TEXT_ATTACHMENT_CHARS } from './config';

/**
 * 构建发送给 AI 的多模态消息列表（三层提示词 + 对话上下文）
 *
 * 消息结构:
 *   [0] system — AI 角色定义 (prompts.systemPrompt)
 *   [1] user   — prePrompt + 对话历史 + 当前邮件 + postPrompt + 图片附件
 *
 * @param email               当前解析后的邮件
 * @param prompts             三层提示词配置
 * @param conversationContext 对话树上下文文本（可选）
 * @returns OpenAI 兼容的 messages 数组
 */
export function buildMessages(
  email: ParsedEmail,
  prompts: PromptConfig,
  conversationContext?: string,
): AIMessage[] {
  const messages: AIMessage[] = [];

  // 1. System message — AI 角色定义
  messages.push({
    role: 'system',
    content: prompts.systemPrompt,
  });

  // 2. User message — 三段式内容 + 附件（多模态）
  const userContent: AIMessageContent[] = [];

  // 2a. 正文前指令（prePrompt）
  if (prompts.prePrompt) {
    userContent.push({
      type: 'text',
      text: prompts.prePrompt,
    });
  }

  // 2b. 对话历史上下文（如果有）
  if (conversationContext) {
    userContent.push({
      type: 'text',
      text: conversationContext,
    });
  }

  // 2c. 当前邮件正文描述
  const emailDescription = buildEmailDescription(email);
  userContent.push({
    type: 'text',
    text: emailDescription,
  });

  // 2d. 正文后指令（postPrompt）
  if (prompts.postPrompt) {
    userContent.push({
      type: 'text',
      text: prompts.postPrompt,
    });
  }

  // 图片附件作为 image_url 块
  for (const attachment of email.attachments) {
    if (
      SUPPORTED_IMAGE_TYPES.includes(attachment.mimeType) &&
      attachment.content
    ) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.content}`,
          detail: 'auto',
        },
      });
    }
  }

  messages.push({
    role: 'user',
    content: userContent,
  });

  return messages;
}

/**
 * 构建描述原邮件的纯文本块（不含引导语，引导语由 pre/post prompt 提供）
 */
function buildEmailDescription(email: ParsedEmail): string {
  const parts: string[] = [];

  parts.push(`发件人: ${email.from}`);
  parts.push(`主题: ${email.subject}`);
  parts.push('');
  parts.push('--- 邮件正文 ---');

  // 优先使用纯文本，其次使用 HTML（去除标签后的纯文本）
  if (email.text) {
    parts.push(email.text);
  } else if (email.html) {
    parts.push(stripHtml(email.html));
  }

  // 非图片附件处理
  const nonImageAttachments = email.attachments.filter(
    (att) => !SUPPORTED_IMAGE_TYPES.includes(att.mimeType),
  );

  // 文本附件：输出内容
  const textAttachments = nonImageAttachments.filter((att) => att.textContent);
  if (textAttachments.length > 0) {
    parts.push('');
    parts.push('--- 文本附件内容 ---');
    for (const att of textAttachments) {
      const truncated =
        att.textContent!.length > MAX_TEXT_ATTACHMENT_CHARS
          ? att.textContent!.slice(0, MAX_TEXT_ATTACHMENT_CHARS) +
            `\n[... 已截断，原始长度 ${att.textContent!.length} 字符]`
          : att.textContent!;
      parts.push(`### ${att.filename} (${att.mimeType}, ${formatSize(att.size)})`);
      parts.push(truncated);
      parts.push('');
    }
  }

  // 非文本、非图片附件：仅列出文件名和大小
  const binaryAttachments = nonImageAttachments.filter((att) => !att.textContent);
  if (binaryAttachments.length > 0) {
    parts.push('');
    parts.push('--- 附件列表 ---');
    for (const att of binaryAttachments) {
      parts.push(`- ${att.filename} (${att.mimeType}, ${formatSize(att.size)})`);
    }
  }

  return parts.join('\n');
}

/**
 * 简单去除 HTML 标签，提取纯文本
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
