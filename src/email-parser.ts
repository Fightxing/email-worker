// ============================================================
// src/email-parser.ts — postal-mime 封装，解析原始邮件
// ============================================================

import PostalMime from 'postal-mime';
import type { ParsedEmail, Attachment } from './types';
import {
  SUPPORTED_IMAGE_TYPES,
  TEXT_PROBE_SIZE,
  TEXT_DETECTION_THRESHOLD,
  KNOWN_TEXT_MIME_TYPES,
} from './config';

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
    const mimeType = att.mimeType || 'application/octet-stream';

    const attachment: Attachment = {
      filename: att.filename || 'unnamed',
      mimeType,
      size: contentBytes.byteLength,
    };

    // 对支持的图片格式提取 base64 内容
    if (SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
      attachment.content = bytesToBase64(contentBytes);
    } else if (isTextFile(contentBytes, mimeType)) {
      // 文本文件：解码为字符串存入 textContent
      attachment.textContent = decodeTextAttachment(contentBytes);
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
    inReplyTo: extractHeader(headers, 'in-reply-to') || '',
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
 * 判断附件是否为文本文件（MIME 类型预筛选 + 字节探测双重确认）
 *
 * 第一步：检查 MIME 类型是否以 text/ 开头或位于已知文本类型白名单中。
 *          不通过则直接返回 false，避免对所有二进制文件做字节扫描。
 * 第二步：对附件前 TEXT_PROBE_SIZE 字节进行可打印字符占比分析。
 *         检测 null 字节（0x00）— 存在则直接判定为二进制；
 *         计算可打印 ASCII + 常见空白符 + 有效 UTF-8 多字节序列的比例，
 *         若 >= TEXT_DETECTION_THRESHOLD 则判定为文本。
 *
 * @param contentBytes  附件原始字节
 * @param mimeType      附件 MIME 类型
 * @returns 是否为文本文件
 */
function isTextFile(contentBytes: Uint8Array, mimeType: string): boolean {
  // 第一步：MIME 类型预筛选
  const lowerMime = mimeType.toLowerCase();
  if (!lowerMime.startsWith('text/') && !KNOWN_TEXT_MIME_TYPES.has(lowerMime)) {
    return false;
  }

  // 第二步：字节探测
  const probeLen = Math.min(contentBytes.byteLength, TEXT_PROBE_SIZE);

  let printable = 0;
  let i = 0;

  while (i < probeLen) {
    const byte = contentBytes[i];

    // null 字节 — 强烈指示二进制内容
    if (byte === 0x00) {
      return false;
    }

    // ASCII 可打印字符 (空格到 ~) + 常见空白符 (\t, \n, \r)
    if (
      (byte >= 0x20 && byte <= 0x7e) ||
      byte === 0x09 /* \t */ ||
      byte === 0x0a /* \n */ ||
      byte === 0x0d /* \r */
    ) {
      printable++;
      i++;
      continue;
    }

    // UTF-8 多字节序列：检测前导字节并验证后续字节
    const seqLen = utf8SequenceLength(byte);
    if (seqLen > 1 && i + seqLen <= probeLen) {
      let valid = true;
      for (let j = 1; j < seqLen; j++) {
        if ((contentBytes[i + j] & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
      }
      if (valid) {
        printable += seqLen; // 整个序列计为可打印
        i += seqLen;
        continue;
      }
    }

    // 既不是可打印 ASCII 也不是有效 UTF-8，计为非可打印
    i++;
  }

  return printable / probeLen >= TEXT_DETECTION_THRESHOLD;
}

/**
 * 根据 UTF-8 前导字节返回序列长度
 *
 * 0xxxxxxx          → 1 (ASCII — 已在外层处理)
 * 110xxxxx          → 2
 * 1110xxxx          → 3
 * 11110xxx          → 4
 * 10xxxxxx / 其他   → 1（无效前导，回退为单字节）
 */
function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0x00) return 1; // 0xxxxxxx
  if ((byte & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((byte & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((byte & 0xf8) === 0xf0) return 4; // 11110xxx
  return 1; // 10xxxxxx 或其他（continuation byte / 无效）
}

/**
 * 将文本附件字节解码为字符串
 *
 * 使用 UTF-8 解码器，忽略无效字节（不抛异常）。
 */
function decodeTextAttachment(contentBytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  return decoder.decode(contentBytes);
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
