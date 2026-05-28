// ============================================================
// src/conversation-tree.ts — D1 对话树存储与查询
// ============================================================

import type { ParsedEmail, ConversationEmail, ConversationNode } from './types';

// ============================================================
// 数据库操作
// ============================================================

/**
 * 将解析后的邮件保存到 D1 数据库
 *
 * @param db           D1 数据库实例
 * @param parsed       解析后的邮件
 * @param threadRootId 线程根 Message-ID（可能为空，表示自身为根）
 */
export async function saveEmail(
  db: D1Database,
  parsed: ParsedEmail,
  threadRootId: string,
): Promise<void> {
  // 如果 messageId 为空，跳过存储
  if (!parsed.messageId) {
    console.log('[CONV] 邮件无 Message-ID，跳过存储');
    return;
  }

  const finalRootId = threadRootId || parsed.messageId;

  try {
    // 使用 INSERT OR IGNORE 避免重复插入同一封邮件
    await db
      .prepare(
        `INSERT OR IGNORE INTO emails (message_id, in_reply_to, refs, from_address, to_address, subject, text_body, thread_root_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        parsed.messageId,
        parsed.inReplyTo,
        parsed.references,
        parsed.from,
        parsed.to,
        parsed.subject,
        parsed.text,
        finalRootId,
      )
      .run();

    console.log(
      `[CONV] 邮件已保存: messageId=${parsed.messageId}, threadRootId=${finalRootId}`,
    );
  } catch (error) {
    console.error(
      `[CONV] 保存邮件失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 查找线程根 Message-ID
 *
 * 逻辑：
 *   1. 如果有 inReplyTo，在数据库中查找其对应的邮件
 *      - 找到 → 使用该邮件的 threadRootId
 *      - 未找到 → inReplyTo 即为根
 *   2. 如果没有 inReplyTo 但有 references，取 references 的第一个作为根
 *   3. 如果都没有，当前邮件自身即为根
 *
 * @param db         D1 数据库实例
 * @param inReplyTo  当前邮件的 In-Reply-To
 * @param references 当前邮件的 References
 * @returns 线程根 Message-ID
 */
export async function findThreadRootId(
  db: D1Database,
  inReplyTo: string,
  references: string,
): Promise<string> {
  // 情况 1：有 In-Reply-To，尝试在数据库中查找其祖先
  if (inReplyTo) {
    const row = await db
      .prepare('SELECT thread_root_id FROM emails WHERE message_id = ?')
      .bind(inReplyTo)
      .first<{ thread_root_id: string }>();

    if (row && row.thread_root_id) {
      console.log(`[CONV] 找到已存在的线程根: ${row.thread_root_id} (通过 In-Reply-To: ${inReplyTo})`);
      return row.thread_root_id;
    }

    // 数据库中不存在被回复的邮件，inReplyTo 即为根
    console.log(`[CONV] 未找到被回复邮件，In-Reply-To 作为根: ${inReplyTo}`);
    return inReplyTo;
  }

  // 情况 2：没有 In-Reply-To，但有 References
  if (references) {
    // References 格式: <msg1> <msg2> ... <msgN>，第一个是最早的
    const refIds = parseReferences(references);
    if (refIds.length > 0) {
      const firstRef = refIds[0];
      // 尝试在数据库中查找
      const row = await db
        .prepare('SELECT thread_root_id FROM emails WHERE message_id = ?')
        .bind(firstRef)
        .first<{ thread_root_id: string }>();

      if (row && row.thread_root_id) {
        console.log(`[CONV] 找到已存在的线程根: ${row.thread_root_id} (通过 References)`);
        return row.thread_root_id;
      }

      console.log(`[CONV] References 首个作为根: ${firstRef}`);
      return firstRef;
    }
  }

  // 情况 3：既无 In-Reply-To 也无 References，自身为根
  return '';
}

/**
 * 获取整个对话树（从根开始的所有邮件）
 *
 * @param db           D1 数据库实例
 * @param threadRootId 线程根 Message-ID
 * @returns 对话树根节点数组
 */
export async function getConversationTree(
  db: D1Database,
  threadRootId: string,
): Promise<ConversationNode[]> {
  if (!threadRootId) {
    return [];
  }

  // 查询该线程下的所有邮件，按创建时间排序
  const result = await db
    .prepare(
      `SELECT id, message_id AS messageId, in_reply_to AS inReplyTo, refs AS "references",
              from_address AS "from", to_address AS "to", subject,
              text_body AS text, thread_root_id AS threadRootId, created_at AS createdAt
       FROM emails WHERE thread_root_id = ? ORDER BY created_at ASC`,
    )
    .bind(threadRootId)
    .all<ConversationEmail>();

  const emails = result.results || [];

  if (emails.length === 0) {
    console.log(`[CONV] 线程 ${threadRootId} 下无邮件记录`);
    return [];
  }

  console.log(
    `[CONV] 线程 ${threadRootId} 共 ${emails.length} 封邮件`,
  );

  // 构建树结构
  return buildTree(emails);
}

/**
 * 将对话树格式化为纯文本，供 AI 理解上下文
 *
 * @param nodes 对话树根节点数组
 * @returns 格式化的对话历史文本
 */
export function formatConversationTree(nodes: ConversationNode[]): string {
  if (nodes.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('=== 邮件对话历史 ===');
  lines.push('');

  for (const node of nodes) {
    formatNode(node, lines, 0);
  }

  return lines.join('\n');
}

// ============================================================
// 内部工具函数
// ============================================================

/**
 * 构建对话树（将扁平邮件列表转为树结构）
 */
function buildTree(emails: ConversationEmail[]): ConversationNode[] {
  // 创建 messageId → node 的映射
  const nodeMap = new Map<string, ConversationNode>();

  for (const email of emails) {
    nodeMap.set(email.messageId, { email, children: [] });
  }

  const roots: ConversationNode[] = [];

  for (const email of emails) {
    const node = nodeMap.get(email.messageId)!;

    // 查找父节点（通过 inReplyTo）
    if (email.inReplyTo && nodeMap.has(email.inReplyTo)) {
      nodeMap.get(email.inReplyTo)!.children.push(node);
    } else {
      // 没有父节点 → 是根节点
      roots.push(node);
    }
  }

  return roots;
}

/**
 * 递归格式化树节点
 */
function formatNode(
  node: ConversationNode,
  lines: string[],
  depth: number,
): void {
  const indent = '  '.repeat(depth);
  const { email } = node;

  lines.push(`${indent}---`);
  lines.push(`${indent}发件人: ${email.from}`);
  lines.push(`${indent}主题: ${email.subject}`);
  lines.push(`${indent}时间: ${email.createdAt}`);
  lines.push(`${indent}正文:`);

  // 限制每封邮件的正文长度，避免上下文过长
  const maxLen = 2000;
  const body =
    email.text.length > maxLen
      ? email.text.slice(0, maxLen) + '\n...(正文过长，已截断)'
      : email.text;

  for (const line of body.split('\n')) {
    lines.push(`${indent}  ${line}`);
  }
  lines.push('');

  // 递归处理子节点
  for (const child of node.children) {
    formatNode(child, lines, depth + 1);
  }
}

/**
 * 解析 References 头，提取 Message-ID 列表
 *
 * References 格式示例:
 *   <abc123@example.com> <def456@example.com> <ghi789@example.com>
 */
function parseReferences(references: string): string[] {
  const ids: string[] = [];
  // 匹配 <...> 中的内容
  const regex = /<([^>]+)>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(references)) !== null) {
    ids.push(match[1]);
  }

  return ids;
}
