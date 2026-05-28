// ============================================================
// src/log-buffer.ts — 内存环形缓冲区（日志监控）
// ============================================================
//
// 在模块级作用域维护一个最多 MAX_LOGS 条的日志环形缓冲区。
// email() 处理器写入，fetch() 管理面板 API 读取，Worker isolate
// 回收后自动丢弃。不依赖 D1/KV，零额外成本。
// ============================================================

/** 单条日志的类别 */
export type LogType =
  | 'email_accepted'
  | 'email_rejected'
  | 'ai_reply'
  | 'ai_error'
  | 'resend_sent'
  | 'resend_error'
  | 'system';

/** 单条日志条目 */
export interface LogEntry {
  /** 自增唯一 ID */
  id: number;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 日志类别 */
  type: LogType;
  /** 简短摘要（列表展示用） */
  summary: string;
  /** 详细内容（AI 回复全文等，可折叠展示） */
  detail?: string;
  /** API 调用耗时（毫秒），可选 */
  durationMs?: number;
  /** 附加结构化元数据 */
  metadata?: Record<string, unknown>;
}

// ---- 环形缓冲区 ----

const MAX_LOGS = 50;
const buffer: LogEntry[] = [];
let nextId = 1;

/**
 * 向环形缓冲区追加一条日志。
 * 超出 MAX_LOGS 时自动移除最旧条目（FIFO）。
 */
export function addLog(
  type: LogType,
  summary: string,
  options?: {
    detail?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    type,
    summary,
    detail: options?.detail,
    durationMs: options?.durationMs,
    metadata: options?.metadata,
  };

  buffer.push(entry);

  // FIFO 淘汰
  while (buffer.length > MAX_LOGS) {
    buffer.shift();
  }
}

/**
 * 获取当前所有日志（按时间正序，最新在末尾）。
 */
export function getLogs(): LogEntry[] {
  return [...buffer];
}

/**
 * 清空所有日志。
 */
export function clearLogs(): void {
  buffer.length = 0;
}
