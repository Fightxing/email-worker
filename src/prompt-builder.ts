// ============================================================
// src/prompt-builder.ts — 构建 OpenAI 兼容 multimodal messages
// ============================================================

import type { ParsedEmail, AIMessage, AIMessageContent, PromptBlock } from './types';
import { SUPPORTED_IMAGE_TYPES, MAX_TEXT_ATTACHMENT_CHARS } from './config';

/** 模板变量正则 — 匹配 {{variable}} 格式 */
const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

/** 触发图片追加的变量名集合 */
const IMAGE_TRIGGER_VARS = new Set(['email_body', 'email_full']);

// ============================================================
// 模板变量渲染
// ============================================================

/**
 * 渲染模板中的 {{variable}} 占位符
 *
 * 支持的变量:
 *   {{email_from}}              — 发件人地址
 *   {{email_to}}                — 收件人地址
 *   {{email_subject}}           — 邮件主题
 *   {{email_body}}              — 纯文本正文
 *   {{email_text_attachments}}  — 文本附件内容
 *   {{email_attachment_list}}   — 非文本附件列表
 *   {{email_full}}              — 以上全部组合
 *   {{conversation_context}}    — 对话树上下文
 *
 * 未知变量原样保留（如 {{unknown}} → {{unknown}}）
 */
export function renderTemplate(
  content: string,
  email: ParsedEmail,
  conversationContext?: string,
): string {
  return content.replace(TEMPLATE_RE, (_match, varName: string) => {
    switch (varName) {
      case 'email_from':
        return email.from;
      case 'email_to':
        return email.to;
      case 'email_subject':
        return email.subject;
      case 'email_body':
        return getEmailBody(email);
      case 'email_text_attachments':
        return getTextAttachments(email);
      case 'email_attachment_list':
        return getAttachmentList(email);
      case 'email_full':
        return buildEmailDescription(email);
      case 'conversation_context':
        return conversationContext || '';
      default:
        // 未知变量原样保留
        return `{{${varName}}}`;
    }
  });
}

// ============================================================
// 消息构建
// ============================================================

/**
 * 构建发送给 AI 的多模态消息列表
 *
 * 逻辑:
 *   1. 过滤 enabled 块，按 sortOrder 升序排列
 *   2. 依次渲染每个块的模板，按 mergeWithPrevious 合并同 role 相邻块
 *   3. 原始模板含 {{email_body}} 或 {{email_full}} 的 user 消息，追加图片 attachment
 *
 * @param email               当前解析后的邮件
 * @param blocks              提示词块列表
 * @param conversationContext 对话树上下文文本（可选）
 * @returns OpenAI 兼容的 messages 数组
 */
export function buildMessages(
  email: ParsedEmail,
  blocks: PromptBlock[],
  conversationContext?: string,
): AIMessage[] {
  const messages: AIMessage[] = [];
  // 记录哪些 user 消息需要追加图片（消息索引集合）
  const imageMessageIndices = new Set<number>();

  // 1. 过滤 + 排序
  const sorted = blocks
    .filter((b) => b.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 2. 渲染 + 合并
  for (const block of sorted) {
    const rendered = renderTemplate(block.content, email, conversationContext);

    // 判断该块是否需要触发图片追加
    const needsImages =
      block.role === 'user' && containsImageTrigger(block.content);

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const canMerge =
      block.mergeWithPrevious &&
      lastMsg !== null &&
      lastMsg.role === block.role;

    if (canMerge) {
      // 合并到前一条同 role 消息
      mergeContent(lastMsg, rendered);
      // 如果该块触发了图片，标记该消息
      if (needsImages) {
        imageMessageIndices.add(messages.length - 1);
      }
    } else {
      // 创建新消息
      messages.push({ role: block.role, content: rendered });
      if (needsImages) {
        imageMessageIndices.add(messages.length - 1);
      }
    }
  }

  // 3. 追加图片附件到标记的 user 消息
  const imageAttachments = email.attachments.filter(
    (att) => SUPPORTED_IMAGE_TYPES.includes(att.mimeType) && att.content,
  );

  if (imageAttachments.length > 0 && imageMessageIndices.size > 0) {
    for (const idx of imageMessageIndices) {
      const msg = messages[idx];
      // 将 string content 转为多模态数组
      const contentArray = stringToContentArray(msg.content as string);
      // 追加 image_url 块
      for (const att of imageAttachments) {
        contentArray.push({
          type: 'image_url',
          image_url: {
            url: `data:${att.mimeType};base64,${att.content}`,
            detail: 'auto',
          },
        });
      }
      msg.content = contentArray;
    }
  }

  return messages;
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 判断模板内容是否含触发图片追加的变量
 */
function containsImageTrigger(template: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_RE.exec(template)) !== null) {
    if (IMAGE_TRIGGER_VARS.has(match[1])) return true;
  }
  return false;
}

/**
 * 将渲染后的文本合并到已有消息的 content 中
 */
function mergeContent(msg: AIMessage, text: string): void {
  if (typeof msg.content === 'string') {
    msg.content = (msg.content as string) + '\n\n' + text;
  } else if (Array.isArray(msg.content)) {
    (msg.content as AIMessageContent[]).push({
      type: 'text',
      text: '\n\n' + text,
    });
  }
}

/**
 * 将纯文本 content 转为多模态 content 数组
 */
function stringToContentArray(text: string): AIMessageContent[] {
  return [{ type: 'text', text }];
}

// ============================================================
// 变量渲染辅助函数
// ============================================================

/** 获取邮件纯文本正文 */
function getEmailBody(email: ParsedEmail): string {
  if (email.text) return email.text;
  if (email.html) return stripHtml(email.html);
  return '';
}

/** 获取文本附件格式化内容 */
function getTextAttachments(email: ParsedEmail): string {
  const nonImageAttachments = email.attachments.filter(
    (att) => !SUPPORTED_IMAGE_TYPES.includes(att.mimeType),
  );
  const textAttachments = nonImageAttachments.filter((att) => att.textContent);
  if (textAttachments.length === 0) return '';

  const parts: string[] = ['--- 文本附件内容 ---'];
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
  return parts.join('\n');
}

/** 获取非文本附件列表 */
function getAttachmentList(email: ParsedEmail): string {
  const nonImageAttachments = email.attachments.filter(
    (att) => !SUPPORTED_IMAGE_TYPES.includes(att.mimeType),
  );
  const binaryAttachments = nonImageAttachments.filter((att) => !att.textContent);
  if (binaryAttachments.length === 0) return '';

  const parts: string[] = ['--- 附件列表 ---'];
  for (const att of binaryAttachments) {
    parts.push(`- ${att.filename} (${att.mimeType}, ${formatSize(att.size)})`);
  }
  return parts.join('\n');
}

/** 构建完整邮件描述（from + subject + body + text attachments + attachment list） */
function buildEmailDescription(email: ParsedEmail): string {
  const parts: string[] = [];

  parts.push(`发件人: ${email.from}`);
  parts.push(`主题: ${email.subject}`);
  parts.push('');
  parts.push('--- 邮件正文 ---');
  parts.push(getEmailBody(email));

  const textAttachments = getTextAttachments(email);
  if (textAttachments) {
    parts.push('');
    parts.push(textAttachments);
  }

  const attachmentList = getAttachmentList(email);
  if (attachmentList) {
    parts.push('');
    parts.push(attachmentList);
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
