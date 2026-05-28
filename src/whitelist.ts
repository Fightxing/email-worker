// ============================================================
// src/whitelist.ts — 白名单检查（支持通配符域名）
// ============================================================

/**
 * 检查发件人是否在白名单中
 *
 * 支持两种匹配模式：
 * - 精确匹配: `user@example.com` 完整地址匹配
 * - 域名通配符: `*@example.com` 匹配该域名下所有地址
 *
 * @param sender  发件人地址（如 "John <john@example.com>" 或 "john@example.com"）
 * @param allowList  白名单列表
 * @returns 是否允许
 */
export function isAllowed(sender: string, allowList: string[]): boolean {
  if (allowList.length === 0) {
    return false;
  }

  const email = extractEmailAddress(sender).toLowerCase();

  for (const entry of allowList) {
    const normalized = entry.trim().toLowerCase();

    // 精确匹配
    if (normalized === email) {
      return true;
    }

    // 域名通配符匹配: *@example.com
    if (normalized.startsWith('*@')) {
      const domain = normalized.slice(2); // 去掉 "*@" 前缀
      if (email.endsWith('@' + domain)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 从 "Display Name <user@example.com>" 格式中提取纯邮箱地址
 */
function extractEmailAddress(raw: string): string {
  // 匹配 <...> 中的内容
  const match = raw.match(/<([^>]+)>/);
  if (match) {
    return match[1].trim();
  }
  // 没有尖括号，直接返回（去除首尾空格）
  return raw.trim();
}
