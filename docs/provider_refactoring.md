# Telegram Agent - Provider 重构与多模型支持技术总结

本文档总结了本项目从单一的 `Claude Agent SDK` 迁移到基于 CLI 的多 Provider（提供商）架构，以及相关的交互和 UI 改进。

## 1. 核心架构演进：从 SDK 到基于 CLI 的 Provider 模式

### 1.1 动机
最初的实现依赖于 `@anthropic-ai/claude-agent-sdk`，但这存在几个局限性：
- 难以直接将原生的 Agent CLI 交互（如格式化的终端输出、工具调用流式输出）完整透传给 Telegram 用户。
- 难以扩展支持其他底层使用完全不同架构或 SDK 的 AI 模型。
- 用户期望能像在终端使用 `claude` 或 `codex` 命令一样，在 Telegram 中获得一致且完整的中间过程可见性。

### 1.2 解决方案
- **抽象 `AgentProvider` 接口**：定义统一的方法约定（主要围绕 `run` 方法），供统一的 `AgentSession` 调用。
- **改用 `child_process.spawn`**：完全抛弃强依赖的 SDK，转而直接启动底层的 CLI 工具。通过拦截标准输出（`stdout`）的 JSON/JSONL 流或 NDJSON 流，解析出消息、事件与工具调用，再格式化发送给 Telegram 客户端。
- **工厂模式实现 (`src/providers/index.ts`)**：支持根据配置或用户输入快速实例化对应的 `ClaudeProvider` 或 `CodexProvider`。

## 2. 关键实现细节与问题修复

### 2.1 Codex 集成与流式响应覆盖修复
**问题现象**：
在引入 `CodexProvider` 后，由于 Codex CLI 将整个运行过程和最终回复以 JSONL 格式一次性或分块输出，原先适配 Claude 的流式解析逻辑（假设每次 `text` 更新都是对同一段文本的拼接，即默认 `segmentId = 0`）导致 Telegram 的一条消息被反复 `editMessageText` 覆盖。用户只能看到最新的一条输出，丢失了 Agent 的思考过程和中间的文字说明。

**修复方案**：
- 为每条独立且实质性的文本内容（无论是包含 `.delta` 的流式更新，还是完整的 `chunk`）分配一个**递增且唯一的 `segmentId`**。
- `segmentId` 的改变会触发底层 `streaming.ts` 中的安全网（当 `state.textMessages.has(segmentId)` 为 false 时），从而调用 `ctx.reply()` 为该内容创建一条**全新且独立**的 Telegram 消息，实现了信息展示的**追加（Append）**而非覆盖。
- 对于耗时操作，在 spawn `codex` 子进程之前立即调用一次 `statusCallback`（如 `⏳ Codex is thinking...`），确保最初的等待也能呈现给用户。

### 2.2 Markdown HTML 转义问题
**问题现象**：
Telegram 的 `parse_mode: "HTML"` 会因为未成对的闭合标签抛出 400 异常。如果模型回复的文本中包含下划线（例如路径名 `selfagent_workspace/minesweeper.html`），我们的 Markdown 转义函数会误将其解析为 HTML 的 `<i>` 标签，导致 Telegram 渲染崩溃。

**修复方案**：
加强了 `streaming.ts` 的弹性（Resilience）：当 `editMessageText` 抛出由于 HTML 解析导致的错误时，增加了一个降级（Fallback）处理：直接使用没有 `parse_mode: "HTML"` 选项的原始文本进行发送/编辑（纯文本降级）。

## 3. 交互与 UI (Telegram Inline Keyboard) 优化

### 3.1 基于内联键盘 (Inline Keyboard) 的快捷操作
为了提升移动端与桌面端 Telegram 的操作便利性，对 `/provider` 与 `/resume` 命令的返回方式进行了重大调整：
弃用传统的命令参数输入，全面改写为返回一个带有 `inline_keyboard` 的消息。

### 3.2 `/provider` 命令增强
- **直接操作**：发送 `/provider` 会弹出带有 `Claude` 和 `Codex` 的按钮面板，当前处于激活状态的 Provider 会以 `✅` 高亮标出。
- **安全切换**：点击按钮时（触发 `provider:{name}` 回调），由于 Provider 不同导致 Session 不互通，系统会自动终止（Stop）当前活跃的交互并清理 Session 状态，确保下次对话在一个干净的环境中启动。

### 3.3 `/resume` 命令增强
- **不再拦截活跃状态**：移除了原本“因为当前有 session 活跃而直接报错拒绝”的保守逻辑。现在无论是否有活跃 Session，都会展示出持久化保存的历史 Session 列表。
- **明确标示**：在历史列表中，当前活跃的 `Session` 按钮后会带有 `✅` 标识；并在顶部文本区域显著地打印出 `Current: ${sessionId} (provider: ${providerName})`。
- **自动中止冲突**：如果用户点击了一个不同于当前运行的 Session 按钮，底层逻辑（`callback.ts`）会自动调用 `session.stop()` 等待退出后，再执行对目标 Session 的 Resume，带来更无缝的切换体验。

### 3.4 `/status` 命令更新
增加了当前挂载的 Provider 类型的显示，并在下方给出 `/provider` 命令的快捷操作提示。此外，鉴于 Codex CLI 没有暴露 Token usage 使用量数据，针对非 Claude provider 隐藏了空白的 Token 数据展示板块。

## 4. 后续演进可能
- **多模型持久化管理**：目前 `session_id` 是各个 CLI 自己生成的 UUID。后续可以考虑在 Bot 在本地包裹一层元数据缓存模块，用来记录每个 `session_id` 对应的具体模型与历史文本。
- **历史上下文迁移**：对于当前 “切换 Provider 即丢失上下文” 的限制，未来可在切换触发时，自动摘要 (Summarize) 当前模型的最后 10 条历史交互，作为 System Prompt 注射给下一个即将启动的 Provider。
