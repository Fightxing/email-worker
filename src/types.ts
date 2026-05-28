// ============================================================
// src/types.ts — 全局类型定义
// ============================================================

/** 附件信息 */
export interface Attachment {
  /** 文件名 */
  filename: string;
  /** MIME 类型（如 image/png, application/pdf） */
  mimeType: string;
  /** Base64 编码的内容（仅图片附件填充） */
  content?: string;
  /** 文本附件的解码后字符内容（仅文本文件填充） */
  textContent?: string;
  /** 原始字节大小 */
  size: number;
}

/** 解析后的邮件结构 */
export interface ParsedEmail {
  /** 发件人地址 */
  from: string;
  /** 收件人地址 */
  to: string;
  /** 邮件主题 */
  subject: string;
  /** 纯文本正文 */
  text: string;
  /** HTML 正文（可能为空） */
  html: string;
  /** 附件列表 */
  attachments: Attachment[];
  /** Message-ID 头（用于 In-Reply-To 线程） */
  messageId: string;
  /** In-Reply-To 头（指向被回复邮件的 Message-ID） */
  inReplyTo: string;
  /** References 头（用于保持邮件线程） */
  references: string;
}

/** 对话树中的单封邮件节点 */
export interface ConversationEmail {
  /** 自增 ID */
  id: number;
  /** Message-ID 头 */
  messageId: string;
  /** In-Reply-To 头 */
  inReplyTo: string;
  /** References 头 */
  references: string;
  /** 发件人 */
  from: string;
  /** 收件人 */
  to: string;
  /** 主题 */
  subject: string;
  /** 纯文本正文 */
  text: string;
  /** 线程根 Message-ID（计算字段） */
  threadRootId: string;
  /** 创建时间 */
  createdAt: string;
}

/** 对话树节点（用于构建树结构） */
export interface ConversationNode {
  /** 当前邮件 */
  email: ConversationEmail;
  /** 子节点（回复当前邮件的邮件列表） */
  children: ConversationNode[];
}

/** AI API 调用配置 */
export interface AIConfig {
  /** API 基础 URL（如 https://api.openai.com/v1） */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名称（如 gpt-4o） */
  model: string;
}

/** OpenAI 兼容的 Chat Completion Message */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AIMessageContent[];
}

/** 多模态消息内容块 */
export interface AIMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/** AI API 响应结构 */
export interface AIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/** Resend API 发送邮件请求体 */
export interface ResendEmailPayload {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

/** 三层提示词配置 */
export interface PromptConfig {
  /** AI 角色定义 (system message) */
  systemPrompt: string;
  /** 邮件正文前插入的指令 */
  prePrompt: string;
  /** 邮件正文后插入的指令 */
  postPrompt: string;
}

/** 环境变量绑定 */
export interface Env {
  // KV 绑定
  PROMPT_KV: KVNamespace;

  // D1 数据库绑定
  EMAIL_DB: D1Database;

  // 环境变量（wrangler.jsonc vars）
  AI_BASE_URL: string;
  AI_MODEL: string;
  SENDER_EMAIL: string;
  SENDER_NAME: string;

  // Secrets（通过 `wrangler secret put` 设置，加密存储，不出现于配置文件）
  AUTH_TOKEN: string;
  ALLOWED_SENDERS: string;
  AI_API_KEY: string;
  RESEND_API_KEY: string;
}
