# 多租户与工作区隔离机制 (Multi-Tenant & Workspace Isolation)

**目标**：允许 Telegram Bot 在不同群组中独立运作，支持按群组映射独立的工作路径，同时保持每个工作路径内部独立的 `Provider` 会话。为了方便单人使用，还引入了私聊自动补齐路径的降级机制。

## 主要架构设计

### 1. 工作区系统 (Workspace System)
- **动态寻址中心**：通过 `src/workspace.ts` 和 `workspaces.json`，实现了类似 `chatId => 绝对路径` 的动态路由。
- **动态分配 (`/bind`)**：新增 `/bind <absolute_path>` 管理员命令，无需重启即可将当前群组绑定到相应的代码库目录。
- **私聊智能兜底策略**：为了保证个人单机日常使用的流畅性，在**私聊场景**下（Telegram 中 `chat_id > 0`），如果识别到尚未绑定路径，系统会自动降级将其映射到默认工作路径 `~/lei_workspace`。不仅避免了每次启动都需要手动 bind，同时也保留了完整的群聊严格隔离要求。

### 2. 连接池重构 (SessionManager)
- **分离单例逻辑**：拔除了全局唯一的 `session` 实例，重新设计了 `SessionManager` 作为会话路由分发中心。
- **按需分发**：每个 `chatId`（群或用户）向 Agent 提问前，会拿到专属于自己的带 `cwd` 环境的沙盒化 `AgentSession`。
- **上下文记录隔离**：各大平台的历史文件被自动路由为 `/tmp/telegram-sessions/session_{chatId}.json`，群组上下文彻底物理隔绝。

### 3. 安全沙箱下放 (Security Sandbox)
- **取代静态管控**：移除了早期硬编码的全局 `WORKING_DIR` 安全屏障以及粗放的 `ALLOWED_PATHS`。
- **按权运行**：在 `AgentProvider` (如 Claude / Codex) 被调用时，安全引擎与指令黑名单会在**运行时（Runtime）**精确提取对应群组的 `cwd`，只有位于其自身工作路径内的文件读写或者 Bash 命令，才会被最终放行入沙盒 (`--add-dir <sandbox>`)。

## 测试场景覆盖

* **未绑定拦截机制**：在尚未执行过 `/bind` 的讨论组（Group）内，发出的任何指令、文字或图片消息均会被拦截，并提示 “No workspace bound”，拒绝启动大模型操作。
* **群组互不干扰**：A 群组与 B 群组使用同一个 Bot 但可以独立设置 `/provider claude` 与 `/provider codex` 进行协同开发。
* **Session 防泄露**：A 群组里的历史交互记录无法在 B 群组内通过 `/resume` 看见，彼此发送消息时会启动相互独立的本地 CLI 子进程进程树。
* **开箱即用体验**：在私聊界面直接对话时，即便不 `/bind`，机器人也会主动挂载 `~/lei_workspace` 接收所有的编程和终端指派。
