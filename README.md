# Email Worker

基于 Cloudflare Workers 的 AI 自动邮件回复机器人。接收邮件后，通过白名单校验、解析邮件内容、查询对话历史上下文，调用 OpenAI 兼容的 AI 大模型生成回复，最后通过 Resend API 发送回信。同时提供一个 Web 管理面板，用于查看配置和动态修改提示词。

## 工作原理

```
收件 (Cloudflare Email Routing)
  -> 白名单检查
  -> 邮件解析 (postal-mime)
  -> 对话树查询 (D1)
  -> 构建 Prompt (KV 三层提示词 + 对话历史 + 当前邮件)
  -> 调用 AI 大模型生成回复
  -> 通过 Resend API 发送回信
```

对话历史通过 D1 数据库持久化存储，利用邮件头中的 `Message-ID`、`In-Reply-To`、`References` 构建完整的对话树，使 AI 在多轮邮件往来中保持上下文连贯。

## 项目结构

```
email-worker/
  package.json          # 项目依赖与脚本
  tsconfig.json         # TypeScript 配置
  wrangler.jsonc        # Cloudflare Wrangler 配置
  SECRETS.md            # 机密变量管理说明
  migrations/           # D1 数据库迁移
    ...sql
  src/
    index.ts            # Worker 主入口 (email handler + HTTP fetch)
    config.ts           # 环境变量读取与配置常量
    types.ts            # 全局类型定义
    ai-client.ts        # AI API 调用封装
    email-parser.ts     # MIME 邮件解析 (postal-mime)
    prompt-builder.ts   # 构建发送给 AI 的多模态消息
    resend-sender.ts    # 通过 Resend API 发送回复
    conversation-tree.ts # D1 对话树存储与查询
    whitelist.ts        # 发件人白名单检查 (支持域名通配符)
    auth.ts             # 管理面板 URL Token 鉴权
    web-gui.ts          # Web 管理界面 HTML 与 API
```

## 环境变量

### 机密变量 (通过 `wrangler secret put` 设置)

| 变量名 | 用途 | 说明 |
|---|---|---|
| `AI_API_KEY` | AI API 密钥 | 调用大模型生成回复时必须 |
| `RESEND_API_KEY` | Resend API 密钥 | 通过 Resend 发送回复邮件时必须 |
| `AUTH_TOKEN` | 管理面板鉴权 Token | 访问 `/admin` 面板时需在 URL 附带 `?token=xxx`，未配置则拒绝所有请求 |

### 普通变量 (在 `wrangler.jsonc` 的 `vars` 中配置)

| 变量名 | 默认值 | 用途 |
|---|---|---|
| `AI_BASE_URL` | `https://api.openai.com/v1` | AI API 基础地址，兼容 OpenAI 接口规范的服务均可使用 |
| `AI_MODEL` | `gpt-4o` | 使用的 AI 模型名称，支持任意 OpenAI 兼容模型 (如 `gpt-4o`, `gemini-2.5-flash`, `deepseek-chat` 等) |
| `SENDER_EMAIL` | (必填，无默认值) | 机器人发件邮箱地址 |
| `SENDER_NAME` | `AI Assistant` | 发件人显示名称 |
| `ALLOWED_SENDERS` | `""` (空，需手动填写) | 白名单发件人列表，逗号分隔。支持精确匹配 `user@example.com` 和域名通配符 `*@example.com` |

## 可调整参数

### AI 回复相关 (位于 `src/ai-client.ts`)

| 参数 | 所在位置 | 默认值 | 说明 |
|---|---|---|---|
| `max_tokens` | `ai-client.ts` 第 56 行 | `128000` | AI 单次回复的最大 token 数。值越大，回复可以越长，但消耗也越多 |
| `temperature` | `ai-client.ts` 第 55 行 | `0.7` | 生成温度 (0-2)。越低越确定、越保守；越高越有创造性。建议回复邮件场景保持在 0.5-0.8 |

### AI API 超时与重试 (位于 `src/config.ts`)

| 常量 | 默认值 | 说明 |
|---|---|---|
| `AI_TIMEOUT_MS` | `300000` (5 分钟) | AI API 调用的超时时间 (毫秒)。使用耗时较长的大模型时可能需要调大 |
| `AI_MAX_RETRIES` | `2` | AI API 调用失败时的最大重试次数。重试采用指数退避 (1s, 2s) |

### Resend API (位于 `src/config.ts`)

| 常量 | 默认值 | 说明 |
|---|---|---|
| `RESEND_TIMEOUT_MS` | `15000` (15 秒) | Resend 发送邮件 API 的超时时间 (毫秒) |
| `RESEND_API_BASE_URL` | `https://api.resend.com` | Resend API 基础地址，一般不需要修改 |

### 支持的图片附件类型 (位于 `src/config.ts`)

| 常量 | 默认值 |
|---|---|
| `SUPPORTED_IMAGE_TYPES` | `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp` |

这些类型的图片附件会以 base64 编码嵌入 AI 请求中，使多模态模型能够"看到"图片内容。如需支持其他图片格式，在此数组中添加对应的 MIME 类型即可。

### 文本附件检测与提取 (位于 `src/config.ts`)

对于非图片附件，系统会通过"MIME 类型预筛选 + 字节探测"双重确认来判断是否为文本文件。确认后提取文本内容并发送给 AI。

| 常量 | 默认值 | 说明 |
|---|---|---|
| `TEXT_PROBE_SIZE` | `4096` | 字节探测时的采样大小（字节）。只读取附件前 N 字节进行分析，避免对超大文件全文扫描造成 CPU 开销 |
| `TEXT_DETECTION_THRESHOLD` | `0.95` | 可打印字符占比阈值。采样字节中可打印字符（含空白符、UTF-8 多字节序列）占比 >= 该值时判定为文本文件 |
| `MAX_TEXT_ATTACHMENT_CHARS` | `10000` | 单个文本附件内容在 AI Prompt 中的最大字符数。超出部分截断并标记原始长度，防止超大文本文件撑爆上下文窗口 |
| `KNOWN_TEXT_MIME_TYPES` | `application/json`, `application/xml`, `application/javascript`, `application/x-yaml`, `application/x-sh`, `application/x-httpd-php`, `application/x-latex`, `application/rtf` | 已知文本 MIME 类型白名单。MIME 检测时，所有 `text/*` 类型自动命中，此外还需在此集合中声明常见的 `application/*` 文本类型 |

文本检测流程：
1. 检查 MIME 类型是否为 `text/*` 或命中的已知文本类型，不通过则直接跳过
2. 对附件前 N 字节采样，检查 null 字节（存在则直接判定为二进制）
3. 计算可打印字符 + 有效 UTF-8 序列占比，>= 阈值则判定为文本
4. 判定为文本后，以 UTF-8 解码全文并存入 Prompt 的"文本附件内容"段落

### 默认提示词 (位于 `src/config.ts`)

| 常量 | 说明 |
|---|---|
| `DEFAULT_SYSTEM_PROMPT` | AI 角色定义 (System Message)。当 KV 中无对应值时使用 |
| `DEFAULT_PRE_PROMPT` | 正文前指令，插在邮件内容之前。当 KV 中无对应值时使用 |
| `DEFAULT_POST_PROMPT` | 正文后指令，插在邮件内容之后。当 KV 中无对应值时使用 |

提示词采用三层结构，可在管理面板中动态修改（存储在 KV 中），无需重新部署。修改后立即生效。

### 对话历史上下文 Token 控制

对话历史的长度通过以下方式间接控制：

- **数据库存储**：所有邮件对话历史存储在 D1 的 `emails` 表中，查询时获取完整线程树
- **上下文拼接**：`conversation-tree.ts` 中的 `formatConversationTree()` 函数将对话树格式化为文本，按时间顺序排列，不设硬截断
- **实际限制**：受限于 AI 模型的上下文窗口大小。如果对话历史过长，建议在 `formatConversationTree()` 中添加截断逻辑（例如只保留最近 N 轮对话），或在 `buildMessages()` 中对 `conversationContext` 的字符数进行限制

### Cloudflare 可观测性 (位于 `wrangler.jsonc`)

| 参数 | 默认值 | 说明 |
|---|---|---|
| `observability.enabled` | `true` | 是否启用 Workers 可观测性 |
| `observability.head_sampling_rate` | `1` | 采样率 (0-1)，1 表示采集全部日志 |

## 快速开始

### 前置条件

1. Cloudflare 账号
2. 在 Cloudflare 控制台中配置 Email Routing，将目标域名绑定到此 Worker
3. 一个 Resend 账号及 API Key（用于发送邮件）
4. 一个兼容 OpenAI 接口的 AI API Key

### 安装与部署

```bash
# 安装依赖
npm install

# 创建 D1 数据库并执行迁移
npx wrangler d1 create email-worker-db
npx wrangler d1 execute email-worker-db --file=migrations/0001_create_emails_table.sql

# 在 wrangler.jsonc 中更新 D1 database_id 和 KV namespace id

# 设置机密变量
npx wrangler secret put AI_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put AUTH_TOKEN

# 本地开发
npm run dev

# 部署到 Cloudflare
npm run deploy
```

### 管理面板

部署后访问 `https://<your-worker>/admin?token=<AUTH_TOKEN>` 即可打开管理面板。面板支持：

- **提示词管理**：在线查看和修改三层提示词（system / pre / post），保存后即时生效
- **配置查看**：查看当前的白名单、AI 模型、发件人等只读配置

## 技术栈

- **运行时**：Cloudflare Workers
- **语言**：TypeScript
- **邮件解析**：postal-mime
- **数据存储**：Cloudflare D1 (对话历史) + KV (提示词)
- **邮件发送**：Resend API
- **AI 接口**：OpenAI 兼容 API (Chat Completions)
