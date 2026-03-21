/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions by spawning the `claude` CLI
 * as a child process, using --output-format stream-json for NDJSON streaming.
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  CLAUDE_CLI_PATH,
  MCP_SERVERS,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
} from "./config";
import { formatToolStatus } from "./formatting";
import {
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
} from "./handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "./security";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

// ============== NDJSON event types from claude CLI ==============

interface CliSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  mcp_servers?: unknown[];
}

interface CliAssistantEvent {
  type: "assistant";
  session_id: string;
  message: {
    content: CliContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface CliUserEvent {
  type: "user";
  session_id: string;
  message: unknown;
}

interface CliResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  session_id: string;
  result?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

type CliEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliUserEvent
  | CliResultEvent;

type CliContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

// ============== Helpers ==============

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }
  return 0;
}

/**
 * Build MCP config JSON for --mcp-config CLI argument.
 * Converts from McpServerConfig map to the CLI's expected format.
 */
function buildMcpConfigArg(): string | null {
  if (Object.keys(MCP_SERVERS).length === 0) return null;

  const mcpServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(MCP_SERVERS)) {
    if ("command" in cfg) {
      // Stdio server
      mcpServers[name] = {
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    } else if ("url" in cfg) {
      // HTTP server
      mcpServers[name] = {
        type: "http",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    }
  }

  return JSON.stringify({ mcpServers });
}

// ============== Session class ==============

const MAX_SESSIONS = 5;

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;

  private childProcess: ReturnType<typeof spawn> | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      this.stopRequested = false;
    }
    return was;
  }

  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  clearStopRequested(): void {
    this.stopRequested = false;
  }

  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  async stop(): Promise<"stopped" | "pending" | false> {
    if (this.isQueryRunning && this.childProcess) {
      this.stopRequested = true;
      this.childProcess.kill("SIGTERM");
      console.log("Stop requested - sending SIGTERM to claude process");
      return "stopped";
    }

    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude by spawning the claude CLI with streaming JSON output.
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build CLI arguments
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-4-5",
      "--permission-mode", "bypassPermissions",
      "--dangerously-skip-permissions",
      "--setting-sources", "user,project",
      "--system-prompt", SAFETY_PROMPT,
    ];

    // Add thinking budget if needed (via append-system-prompt workaround or budget_tokens)
    // Claude CLI doesn't expose --max-thinking-tokens directly, but we can hint via system prompt
    if (thinkingTokens > 0) {
      args.push("--append-system-prompt", `[Thinking budget: ${thinkingTokens} tokens]`);
    }

    // Add MCP config if available
    const mcpConfigJson = buildMcpConfigArg();
    if (mcpConfigJson) {
      args.push("--mcp-config", mcpConfigJson);
    }

    // Add allowed directories
    for (const dir of ALLOWED_PATHS) {
      args.push("--add-dir", dir);
    }

    // Resume existing session
    if (this.sessionId && !isNewSession) {
      args.push("--resume", this.sessionId);
      console.log(
        `RESUMING session ${this.sessionId.slice(0, 8)}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // Pass prompt via stdin (more reliable than positional arg for multiline/unicode text)
    // --input-format text reads from stdin when no positional prompt arg is given
    args.push("--input-format", "text");

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log("Query cancelled before starting");
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    try {
      await new Promise<void>((resolve, reject) => {
        console.log(`Spawning: ${CLAUDE_CLI_PATH} ${args.slice(0, 6).join(" ")} ...`);

        const child = spawn(CLAUDE_CLI_PATH, args, {
          cwd: WORKING_DIR,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.childProcess = child;

        // Write prompt to stdin and close it
        child.stdin!.write(messageToSend, "utf8");
        child.stdin!.end();

        let lineBuffer = "";
        let stderrBuffer = "";

        // Process stdout line by line (NDJSON)
        child.stdout!.on("data", async (chunk: Buffer) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? ""; // last incomplete line stays buffered

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let event: CliEvent;
            try {
              event = JSON.parse(trimmed) as CliEvent;
            } catch {
              console.warn(`Non-JSON stdout line: ${trimmed.slice(0, 120)}`);
              continue;
            }

            try {
              await handleCliEvent(event);
            } catch (err) {
              reject(err);
            }
          }
        });

        child.stderr!.on("data", (chunk: Buffer) => {
          stderrBuffer += chunk.toString();
        });

        child.on("error", (err) => {
          console.error("Failed to spawn claude:", err);
          reject(err);
        });

        child.on("close", (code) => {
          // Process any remaining buffered line
          const remaining = lineBuffer.trim();
          if (remaining) {
            try {
              const event = JSON.parse(remaining) as CliEvent;
              handleCliEvent(event).catch(() => {});
            } catch {}
          }

          if (stderrBuffer.trim()) {
            console.warn(`claude stderr: ${stderrBuffer.trim().slice(0, 500)}`);
          }

          if (this.stopRequested) {
            console.log("Query stopped by user");
            resolve();
            return;
          }

          if (code !== 0 && !queryCompleted) {
            reject(new Error(`claude exited with code ${code}: ${stderrBuffer.slice(0, 200)}`));
            return;
          }

          resolve();
        });

        // ---- Event handler (async, runs in the stdout data callback) ----
        const handleCliEvent = async (event: CliEvent): Promise<void> => {
          if (this.stopRequested) return;

          // Capture session_id from first event
          if (!this.sessionId && event.session_id) {
            this.sessionId = event.session_id;
            console.log(`GOT session_id: ${this.sessionId.slice(0, 8)}...`);
            this.saveSession();
          }

          if (event.type === "assistant") {
            for (const block of event.message.content) {
              // Thinking block
              if (block.type === "thinking") {
                const thinkingText = block.thinking;
                if (thinkingText) {
                  console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                  await statusCallback("thinking", thinkingText);
                }
              }

              // Tool use block
              if (block.type === "tool_use") {
                const toolName = block.name;
                const toolInput = block.input;

                // Safety check for Bash commands
                if (toolName === "Bash") {
                  const command = String(toolInput.command || "");
                  const [isSafe, reason] = checkCommandSafety(command);
                  if (!isSafe) {
                    console.warn(`BLOCKED: ${reason}`);
                    await statusCallback("tool", `BLOCKED: ${reason}`);
                    child.kill("SIGTERM");
                    throw new Error(`Unsafe command blocked: ${reason}`);
                  }
                }

                // Safety check for file operations
                if (["Read", "Write", "Edit"].includes(toolName)) {
                  const filePath = String(toolInput.file_path || "");
                  if (filePath) {
                    const isTmpRead =
                      toolName === "Read" &&
                      (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                        filePath.includes("/.claude/"));

                    if (!isTmpRead && !isPathAllowed(filePath)) {
                      console.warn(`BLOCKED: File access outside allowed paths: ${filePath}`);
                      await statusCallback("tool", `Access denied: ${filePath}`);
                      child.kill("SIGTERM");
                      throw new Error(`File access blocked: ${filePath}`);
                    }
                  }
                }

                // Segment ends when tool starts
                if (currentSegmentText) {
                  await statusCallback("segment_end", currentSegmentText, currentSegmentId);
                  currentSegmentId++;
                  currentSegmentText = "";
                }

                // Format and show tool status
                const toolDisplay = formatToolStatus(toolName, toolInput);
                this.currentTool = toolDisplay;
                this.lastTool = toolDisplay;
                console.log(`Tool: ${toolDisplay}`);

                if (
                  !toolName.startsWith("mcp__ask-user") &&
                  !toolName.startsWith("mcp__send-file")
                ) {
                  await statusCallback("tool", toolDisplay);
                }

                // Check for pending ask_user requests
                if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                  await new Promise((resolve) => setTimeout(resolve, 200));
                  for (let attempt = 0; attempt < 3; attempt++) {
                    const buttonsSent = await checkPendingAskUserRequests(ctx, chatId);
                    if (buttonsSent) {
                      askUserTriggered = true;
                      break;
                    }
                    if (attempt < 2) {
                      await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                  }
                  if (askUserTriggered) {
                    // Stop reading — user will respond via button
                    child.kill("SIGTERM");
                    return;
                  }
                }

                // Send file after send-file MCP tool
                if (toolName.startsWith("mcp__send-file") && ctx && chatId) {
                  await new Promise((resolve) => setTimeout(resolve, 200));
                  for (let attempt = 0; attempt < 3; attempt++) {
                    const sent = await checkPendingSendFileRequests(ctx, chatId);
                    if (sent) break;
                    if (attempt < 2) {
                      await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                  }
                }
              }

              // Text content block
              if (block.type === "text") {
                responseParts.push(block.text);
                currentSegmentText += block.text;

                const now = Date.now();
                if (
                  now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                  currentSegmentText.length > 20
                ) {
                  await statusCallback("text", currentSegmentText, currentSegmentId);
                  lastTextUpdate = now;
                }
              }
            }
          }

          // Result event — capture usage
          if (event.type === "result") {
            console.log("Response complete");
            queryCompleted = true;

            if (event.usage) {
              this.lastUsage = event.usage as TokenUsage;
              const u = this.lastUsage;
              console.log(
                `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_create=${u.cache_creation_input_tokens || 0}`
              );
            }
          }
        };
      });
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") ||
        errorStr.includes("abort") ||
        errorStr.includes("sigterm");

      if (isCleanupError && (queryCompleted || askUserTriggered || this.stopRequested)) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.childProcess = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    console.log("Session cleared");
  }

  /**
   * Save session to disk for resume after restart.
   */
  saveSession(): void {
    if (!this.sessionId) return;

    try {
      const history = this.loadSessionHistory();

      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Sessione senza titolo",
      };

      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        history.sessions.unshift(newSession);
      }

      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }
      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === WORKING_DIR
    );
  }

  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Sessione non trovata"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Sessione per directory diversa: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [true, `Ripresa sessione: "${sessionData.title}"`];
  }

  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "Nessuna sessione salvata"];
    }
    return this.resumeSession(sessions[0]!.session_id);
  }
}

// Global session instance
export const session = new ClaudeSession();
