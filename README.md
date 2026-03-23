# Claude Telegram Bot（扩展版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**通过 Telegram，随时随地调用 Claude Code 和 Codex CLI，打造你的专属 AI 助手。**

支持文字、语音、图片、文件、音频、视频消息。实时查看 AI 的响应过程和工具调用。

![Demo](assets/demo.gif)

---

## 关于作者

- 🌐 网站：[leigeai.com](https://leigeai.com/)
- 💬 微信：`leigeaicom`
- 🏘️ 社群：[知识星球 · 探索使用AI通向自由之路](https://wx.zsxq.com/group/28882285418421)

---

## 致谢

本项目 fork 自 [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot)，一个将 Claude Code 与 Telegram 连接起来的优秀开源项目。非常感谢原作者及所有贡献者打下的坚实基础——核心消息处理、流式输出、语音转录、MCP 工具集成和个人助手模式均源自上游项目。

---

## 本 Fork 的新增功能

### 🤖 多 Provider 支持（Claude + Codex CLI）
通过 `/provider` 命令随时在不同 AI 后端之间切换。Claude Code CLI 和 OpenAI Codex CLI 均作为一等公民支持。`/status` 和 `/resume` 显示中会展示当前 Provider 信息。

### 📁 按会话的工作区隔离（`/bind`）
每个 Telegram 会话（群组或私聊）都可以绑定到独立的工作目录，让同一个 Bot 同时服务多个项目/工作区，互不干扰：

- **群组**：使用 `/bind <绝对路径>` 绑定工作区。未绑定的群组发送任何消息均会被拒绝并提示。
- **私聊**：如果未绑定，自动降级使用默认工作区，无需手动 bind。
- **会话隔离**：历史记录按会话独立存储于 `/tmp/telegram-sessions/session_{chatId}.json`，互不泄漏。
- **安全沙箱**：文件系统访问权限在运行时按每个会话的 `cwd` 动态计算，不再使用全局 `ALLOWED_PATHS`。

### 🔄 Session 自动恢复
Bot 重启后，活跃会话会自动恢复到上次的工作区和 Provider 状态，无需手动 `/resume`。

### 🎨 Markdown → HTML 渲染重构
Claude 的响应使用 Telegram HTML 解析模式渲染，正确支持代码块、行内代码、加粗/斜体、链接和嵌套格式，彻底解决了 MarkdownV2 的字符转义问题。

### ⚡ Claude CLI 事件处理优化
对 Claude CLI 子进程的流式事件处理更加可靠，改善了 JSON 分块和工具调用块的处理逻辑。

---

## 全部功能

- 💬 **文字**：提问、下达指令、自由对话
- 🎤 **语音**：自然语音输入，通过 OpenAI 转录后由 AI 处理
- 📸 **图片**：发送截图、文档图片等，进行视觉分析
- 📄 **文件**：PDF、文本文件以及压缩包（ZIP、TAR）会被解压分析
- 🎵 **音频**：音频文件（mp3、m4a、ogg、wav 等）通过 OpenAI 转录后处理
- 🎬 **视频**：视频消息和圆形视频消息均可处理
- 🔄 **会话持久化**：跨消息保持对话上下文，重启后自动恢复
- 📨 **消息队列**：AI 处理期间可继续发送消息，自动排队。以 `!` 开头或使用 `/stop` 可立即打断
- 🧠 **深度思考**：在消息中使用"think"、"reason"等关键词触发扩展思考，实时查看推理过程（可通过 `THINKING_TRIGGER_KEYWORDS` 配置）
- 🔘 **交互按钮**：Claude 可通过内置 `ask_user` MCP 工具弹出可点击的选项按钮
- 📎 **文件回传**：Claude 可通过 `send_file` MCP 工具将图片、视频、文档等发回聊天
- 🤖 **Provider 切换**：用 `/provider` 随时切换 Claude / Codex
- 📁 **工作区隔离**：用 `/bind` 为每个会话绑定专属代码目录

---

## 快速开始

```bash
git clone <your-fork-url>
cd claude-telegram-bot

cp .env.example .env
# 编辑 .env，填入你的配置

bun install
bun run src/index.ts
```

### 前置要求

- **Bun 1.0+** — [安装 Bun](https://bun.sh/)
- **Telegram Bot Token** — 通过 [@BotFather](https://t.me/BotFather) 创建
- **Claude Code CLI** — 通过 `claude` 命令登录（推荐），或使用 `ANTHROPIC_API_KEY`
- **Codex CLI** — 可选，使用 `codex` Provider 时需要
- **OpenAI API Key** — 可选，用于语音转录

### Claude 认证

| 方式 | 适用场景 | 配置 |
| --- | --- | --- |
| **CLI 认证**（推荐） | 高频使用，性价比高 | 运行一次 `claude` 登录即可 |
| **API Key** | CI/CD 或没有 Claude Code 的环境 | 在 `.env` 中设置 `ANTHROPIC_API_KEY` |

---

## 配置说明

### 1. 创建 Bot

1. 在 Telegram 打开 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 并按提示操作
3. 复制 Token（格式如 `1234567890:ABC-DEF...`）

然后向 BotFather 发送 `/setcommands` 并粘贴以下内容：

```
start - 显示状态和用户 ID
new - 开始新会话
resume - 选择最近的会话恢复
stop - 中断当前查询
status - 查看 AI 当前状态
restart - 重启 Bot
provider - 切换 AI Provider（claude / codex）
bind - 将当前会话绑定到工作区目录
```

### 2. 配置环境变量

创建 `.env` 文件：

```bash
# 必填
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...   # 来自 @BotFather
TELEGRAM_ALLOWED_USERS=123456789           # 你的 Telegram 用户 ID

# 推荐
# OPENAI_API_KEY=sk-...                      # 用于语音转录

# 可选 - Claude API Key（不使用 CLI 认证时）
# ANTHROPIC_API_KEY=sk-ant-api03-...

# 可选 - 深度思考触发词
# THINKING_KEYWORDS=think,reason
# THINKING_DEEP_KEYWORDS=ultrathink,think hard
```

> **注意：** `CLAUDE_WORKING_DIR` 在本 fork 中已**废弃**，请改用 `/bind <绝对路径>` 命令为每个会话设置工作目录。

**获取你的 Telegram 用户 ID：** 向 [@userinfobot](https://t.me/userinfobot) 发消息即可。

### 3. 绑定工作区

启动 Bot 后，在对应会话中执行：

```
/bind /你的项目路径
```

私聊时如果未绑定，Bot 会自动使用默认工作区。

### 4. 配置 MCP 服务器（可选）

```bash
cp mcp-config.ts mcp-config.local.ts
# 按需编辑 mcp-config.local.ts
```

内置 MCP 工具：
- **`ask_user`** — 让 Claude 以内联按钮形式展示选项
- **`send_file`** — 让 Claude 将文件发回聊天

可添加更多 MCP 服务器（Things、Notion、Typefully 等）扩展 AI 的能力边界。

---

## Bot 命令

| 命令 | 说明 |
| --- | --- |
| `/start` | 显示状态和用户 ID |
| `/new` | 开始新会话 |
| `/resume` | 从最近 5 个会话中选择恢复（含摘要） |
| `/stop` | 中断当前查询 |
| `/status` | 查看 AI 当前状态（含 Provider 信息） |
| `/restart` | 重启 Bot |
| `/provider <claude\|codex>` | 切换当前会话的 AI Provider |
| `/bind <路径>` | 将当前会话绑定到工作区目录（管理员专用） |

---

## 作为服务运行（macOS）

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# 编辑 plist，填入路径和环境变量
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

Bot 会在登录时自动启动，崩溃后自动重启。

**防止休眠：** 前往 **系统设置 → 电池 → 选项**，在接通电源时启用**"接通电源时防止自动进入睡眠"**。

**查看日志：**

```bash
tail -f /tmp/claude-telegram-bot-ts.log   # 标准输出
tail -f /tmp/claude-telegram-bot-ts.err   # 标准错误
```

**Shell 别名**（可加入 `~/.zshrc` 或 `~/.bashrc`）：

```bash
alias cbot='launchctl list | grep com.claude-telegram-ts'
alias cbot-stop='launchctl bootout gui/$(id -u)/com.claude-telegram-ts 2>/dev/null && echo "Stopped"'
alias cbot-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-telegram-ts.plist 2>/dev/null && echo "Started"'
alias cbot-restart='launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts && echo "Restarted"'
alias cbot-logs='tail -f /tmp/claude-telegram-bot-ts.log'
```

---

## 开发调试

```bash
# 热重载运行
bun --watch run src/index.ts

# 类型检查
bun run typecheck

# 或直接运行
bun run --bun tsc --noEmit
```

---

## 安全说明

> **⚠️ 重要：** 本 Bot 运行 Claude Code / Codex CLI 时**绕过了所有权限确认**。AI 可在允许的路径内直接读写文件、执行命令，无需二次确认。这是为了移动端无缝体验的有意设计，请在部署前充分理解其含义。

**→ [阅读完整安全模型说明](SECURITY.md)**

多层防护机制：

1. **用户白名单** — 仅允许 `.env` 中配置的 Telegram ID 使用
2. **意图分类** — AI 过滤器拦截危险请求
3. **工作区沙箱** — 文件访问权限在运行时动态限定为每个会话的 `cwd`
4. **命令安全** — 阻断 `rm -rf /` 等破坏性命令模式
5. **频率限制** — 防止滥用
6. **审计日志** — 所有交互记录于 `/tmp/claude-telegram-audit.log`
7. **群组隔离** — 未绑定工作区的群组无法触发任何 AI 操作

---

## 常见问题

**Bot 没有响应**
- 检查 `TELEGRAM_ALLOWED_USERS` 中是否有你的用户 ID
- 确认 Bot Token 正确
- 查看日志：`tail -f /tmp/claude-telegram-bot-ts.err`

**群组收到"No workspace bound"提示**
- 在群组中执行 `/bind <绝对路径>` 绑定工作区

**Claude 认证失败**
- CLI 认证：在终端运行 `claude`，确认已登录
- API Key：确认 `ANTHROPIC_API_KEY` 配置正确，账户有余额

**语音消息失败**
- 确认 `.env` 中已设置 `OPENAI_API_KEY`
- 确认 Key 有效且有余额

**AI 无法访问文件**
- 执行 `/bind <路径>` 设置当前会话的工作目录
- 确认 Bot 进程对绑定路径有读写权限

**MCP 工具不工作**
- 确认 `mcp-config.ts` 存在且导出正确
- 确认 MCP 服务器依赖已安装
- 查看日志中的 MCP 相关错误

---

## License

MIT
