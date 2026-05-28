-- ============================================================
-- Migration: 0001_create_emails_table
-- 创建 emails 表，用于存储邮件对话树
-- ============================================================

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT DEFAULT '',
  refs TEXT DEFAULT '',
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  thread_root_id TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引：按 Message-ID 快速查找
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);

-- 索引：按线程根 ID 查找整个对话线程
CREATE INDEX IF NOT EXISTS idx_emails_thread_root_id ON emails(thread_root_id);

-- 索引：按 In-Reply-To 查找子邮件
CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails(in_reply_to);
