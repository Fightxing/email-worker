// ============================================================
// src/index.ts — Cloudflare Email Worker 主入口
// ============================================================

import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env } from './types';
import { isAllowed } from './whitelist';
import { parseEmail } from './email-parser';
import { buildMessages } from './prompt-builder';
import { generateReply } from './ai-client';
import { sendReply } from './resend-sender';
import {
  getAIConfig,
  getAllowedSenders,
  readPrompts,
} from './config';
import { checkAuth } from './auth';
import { renderAdminPage, handleApiRequest } from './web-gui';
import {
  findThreadRootId,
  getConversationTree,
  formatConversationTree,
  saveEmail,
} from './conversation-tree';
import { addLog } from './log-buffer';

export default {
  /**
   * Cloudflare Email Workers email handler
   *
   * 接收邮件 → 白名单检查 → 解析内容 → AI 生成回复 → 发送回信
   */
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    try {
      // ============================================
      // 1. 白名单检查
      // ============================================
      const allowedSenders = getAllowedSenders(env);
      if (!isAllowed(message.from, allowedSenders)) {
        console.log(`[REJECT] 发件人不在白名单: ${message.from}`);
        addLog('email_rejected', `发件人不在白名单: ${message.from}`, {
          metadata: { from: message.from },
        });
        message.setReject('Address not allowed');
        return;
      }

      console.log(`[ACCEPT] 收到来自 ${message.from} 的邮件`);

      // ============================================
      // 2. 解析邮件
      // ============================================
      const parsed = await parseEmail(message.raw, message.rawSize);
      console.log(
        `[PARSED] 主题: ${parsed.subject}, 附件: ${parsed.attachments.length} 个, Message-ID: ${parsed.messageId}`,
      );
      addLog('email_accepted', `来自 ${parsed.from} — "${parsed.subject}"`, {
        metadata: {
          from: parsed.from,
          subject: parsed.subject,
          messageId: parsed.messageId,
          attachmentCount: parsed.attachments.length,
        },
      });

      // ============================================
      // 3. 查询对话树上下文
      // ============================================
      const threadRootId = await findThreadRootId(
        env.EMAIL_DB,
        parsed.inReplyTo,
        parsed.references,
      );
      console.log(`[CONV] 线程根: ${threadRootId || '(新线程)'}`);

      const conversationNodes = await getConversationTree(
        env.EMAIL_DB,
        threadRootId || parsed.messageId,
      );
      const conversationContext = formatConversationTree(conversationNodes);
      if (conversationContext) {
        console.log(
          `[CONV] 对话历史 (${conversationContext.length} 字符)`,
        );
      }

      // ============================================
      // 4. 读取三层提示词
      // ============================================
      const prompts = await readPrompts(env);
      console.log(`[PROMPT] 三层提示词已加载 (system: ${prompts.systemPrompt.length} 字符, pre: ${prompts.prePrompt.length} 字符, post: ${prompts.postPrompt.length} 字符)`);

      // ============================================
      // 5. 构建 AI messages
      // ============================================
      const messages = buildMessages(parsed, prompts, conversationContext || undefined);
      console.log(`[BUILD] 构建了 ${messages.length} 条消息`);

      // ============================================
      // 6. 调用 AI 生成回复
      // ============================================
      const aiConfig = getAIConfig(env);
      console.log(`[AI] 调用模型: ${aiConfig.model}`);
      const aiStart = Date.now();
      let replyText: string;
      try {
        replyText = await generateReply(messages, aiConfig);
        const aiDuration = Date.now() - aiStart;
        console.log(`[AI] 生成回复 (${replyText.length} 字符, ${aiDuration}ms)`);
        addLog('ai_reply', `AI 回复生成成功 (${replyText.length} 字符)`, {
          detail: replyText,
          durationMs: aiDuration,
          metadata: { model: aiConfig.model },
        });
      } catch (aiError) {
        const aiDuration = Date.now() - aiStart;
        const errMsg = aiError instanceof Error ? aiError.message : String(aiError);
        console.error(`[AI] 调用失败 (${aiDuration}ms): ${errMsg}`);
        addLog('ai_error', `AI 调用失败: ${errMsg}`, {
          durationMs: aiDuration,
          metadata: { model: aiConfig.model },
        });
        throw aiError;
      }

      // ============================================
      // 7. 通过 Resend 发送回复
      // ============================================
      const resendStart = Date.now();
      try {
        await sendReply(parsed, replyText, env);
        const resendDuration = Date.now() - resendStart;
        console.log(
          `[SENT] 回复已发送至 ${parsed.from} (${resendDuration}ms)`,
        );
        addLog('resend_sent', `回复已发送至 ${parsed.from}`, {
          durationMs: resendDuration,
          metadata: { to: parsed.from, subject: `Re: ${parsed.subject}` },
        });
      } catch (resendError) {
        const resendDuration = Date.now() - resendStart;
        const errMsg =
          resendError instanceof Error ? resendError.message : String(resendError);
        console.error(`[SENT] 发送失败 (${resendDuration}ms): ${errMsg}`);
        addLog('resend_error', `Resend 发送失败: ${errMsg}`, {
          durationMs: resendDuration,
          metadata: { to: parsed.from },
        });
        throw resendError;
      }

      // ============================================
      // 8. 将当前邮件保存到 D1 对话树
      // ============================================
      await saveEmail(env.EMAIL_DB, parsed, threadRootId);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] 处理邮件失败: ${errorMessage}`);
      addLog('system', `处理邮件失败: ${errorMessage}`, {
        metadata: { from: message.from },
      });

      // 不抛出错误，避免 Worker 崩溃
    }
  },

  /**
   * HTTP fetch handler — Web 管理界面入口
   *
   * 路由:
   *   GET  /admin              → 管理界面 HTML 页面
   *   GET  /admin/api/prompts  → 获取三层提示词
   *   PUT  /admin/api/prompts  → 更新三层提示词
   *   GET  /admin/api/config   → 获取只读配置
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // === 认证检查 ===
    if (!checkAuth(request, env)) {
      return new Response('Unauthorized — 请在 URL 中提供有效的 ?token= 参数', {
        status: 401,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // === 路由分发 ===
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    // GET /admin — 管理界面 HTML
    if (pathname === '/admin' && request.method === 'GET') {
      const html = renderAdminPage();
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // API 路由 — 委托给 web-gui 模块
    if (pathname.startsWith('/admin/api/')) {
      return handleApiRequest(request, env);
    }

    // 404
    return new Response('Not Found', { status: 404 });
  },
};
