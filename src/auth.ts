// ============================================================
// src/auth.ts — URL Token 鉴权中间件
// ============================================================

import type { Env } from './types';
import { getAuthToken } from './config';

/**
 * 校验请求是否携带有效的认证 Token
 *
 * 从 URL query string 中提取 `token` 参数与 `AUTH_TOKEN` 环境变量对比。
 * 若 `AUTH_TOKEN` 未配置则拒绝所有请求（安全优先）。
 *
 * @param request  HTTP 请求
 * @param env      环境变量
 * @returns 是否通过认证
 */
export function checkAuth(request: Request, env: Env): boolean {
  const expectedToken = getAuthToken(env);

  // 未配置 AUTH_TOKEN 时拒绝所有请求
  if (!expectedToken) {
    console.error('[AUTH] AUTH_TOKEN 未配置，拒绝请求');
    return false;
  }

  const url = new URL(request.url);
  const providedToken = url.searchParams.get('token') || '';

  const isValid = providedToken === expectedToken;

  if (!isValid) {
    console.warn('[AUTH] Token 验证失败');
  }

  return isValid;
}
