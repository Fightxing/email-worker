// ============================================================
// src/email-parser.ts — postal-mime 封装，解析原始邮件
// ============================================================

import PostalMime from 'postal-mime';
import type { ParsedEmail, Attachment } from './types';
import { SUPPORTED_IMAGE_TYPES } from './config';

/**
 * 解析原始 MIME 邮件流
 *
 * @param rawStream  邮件原始 ReadableStream
 * @param rawSize    原始内容大小（字节）
 * @returns 解析后的邮件对象
 */
export async function parseEmail(
  rawStream: ReadableStream<Uint8Array>,
  rawSize: number,
): Promise<ParsedEmail> {
  // 从 ReadableStream 读取全部字节
  const rawBytes = await readAllBytes(rawStream, rawSize);

  // 使用 postal-mime 解析
  const parser = new PostalMime();
  const parsed = await parser.parse(rawBytes);

  // 提取附件
  const attachments: Attachment[] = (parsed.attachments || []).map((att) => {
    // content 可能是 string | ArrayBuffer | Uint8Array，统一转为 Uint8Array
    const contentBytes = normalizeToUint8Array(att.content);

    const attachment: Attachment = {
      filename: att.filename || 'unnamed',
      mimeType: att.mimeType || 'application/octet-stream',
      size: contentBytes.byteLength,
    };

    // 仅对支持的图片格式提取 base64 内容
    if (SUPPORTED_IMAGE_TYPES.includes(att.mimeType)) {
      attachment.content = bytesToBase64(contentBytes);
    }

    return attachment;
  });

  // 提取邮件头信息
  const headers = parsed.headers || [];

  return {
    from: extractHeader(headers, 'from') || parsed.from?.address || '',
    to: extractHeader(headers, 'to') || parsed.to?.[0]?.address || '',
    subject: parsed.subject || '(无主题)',
    text: parsed.text || '',
    html: parsed.html || '',
    attachments,
    messageId: extractHeader(headers, 'message-id') || '',
    references: extractHeader(headers, 'references') || '',
  };
}

/**
 * 从 ReadableStream 读取全部字节
 */
async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  estimatedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  // 合并所有 chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

/**
 * 将 postal-mime 的 content（string | ArrayBuffer | Uint8Array）统一转为 Uint8Array
 */
function normalizeToUint8Array(
  content: string | ArrayBuffer | Uint8Array,
): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  // string 类型：Uint8Array 构造器不支持 string，需手动编码
  const encoder = new TextEncoder();
  return encoder.encode(content);
}

/**
 * 将 Uint8Array 转为 Base64 字符串
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 从邮件头数组中提取指定头的值
 * postal-mime 的 headers 格式为 `{ key: string, value: string }[]`
 */
function extractHeader(
  headers: Array<{ key: string; value: string }>,
  name: string,
): string {
  const lowerName = name.toLowerCase();
  const header = headers.find(
    (h) => h.key.toLowerCase() === lowerName,
  );
  return header?.value || '';
}
