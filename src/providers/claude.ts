/**
 * Claude CLI provider.
 *
 * Spawns `claude --print --output-format stream-json --verbose` and
 * parses the NDJSON stream into StatusCallback events.
 */

import { spawn } from "child_process";
import {
  ALLOWED_PATHS,
  CLAUDE_CLI_PATH,
  MCP_SERVERS,
  SAFETY_PROMPT,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
} from "../config";
import { formatToolStatus } from "../formatting";
import {
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
} from "../handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "../security";
import type { TokenUsage } from "../types";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "./types";

// ── NDJSON event types ─────────────────────────────────────────────────────

interface CliAssistantEvent {
  type: "assistant";
  session_id: string;
  message: { content: CliContentBlock[] };
}
interface CliResultEvent {
  type: "result";
  session_id: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}
interface CliOtherEvent {
  type: string;
  session_id?: string;
}
type CliEvent = CliAssistantEvent | CliResultEvent | CliOtherEvent;

type CliContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

// ── Helpers ────────────────────────────────────────────────────────────────

function getThinkingLevel(message: string): number {
  const lower = message.toLowerCase();
  if (THINKING_DEEP_KEYWORDS.some((k) => lower.includes(k))) return 50000;
  if (THINKING_KEYWORDS.some((k) => lower.includes(k))) return 10000;
  return 0;
}

function buildMcpConfigArg(): string | null {
  if (Object.keys(MCP_SERVERS).length === 0) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(MCP_SERVERS)) {
    if ("command" in cfg) {
      mcpServers[name] = { command: cfg.command, ...(cfg.args ? { args: cfg.args } : {}), ...(cfg.env ? { env: cfg.env } : {}) };
    } else if ("url" in cfg) {
      mcpServers[name] = { type: "http", url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) };
    }
  }
  return JSON.stringify({ mcpServers });
}

// ── Provider ───────────────────────────────────────────────────────────────

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude" as const;

  private _child: ReturnType<typeof spawn> | null = null;
  private _running = false;

  get isRunning(): boolean {
    return this._running;
  }

  abort(): void {
    if (this._child) {
      this._child.kill("SIGTERM");
    }
  }

  async run(opts: ProviderRunOptions): Promise<ProviderRunResult> {
    const { message, sessionId, cwd, statusCallback, ctx, chatId } = opts;

    const thinkingTokens = getThinkingLevel(message);

    // Build CLI args
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

    if (thinkingTokens > 0) {
      args.push("--append-system-prompt", `[Thinking budget: ${thinkingTokens} tokens]`);
    }

    const mcpConfigJson = buildMcpConfigArg();
    if (mcpConfigJson) args.push("--mcp-config", mcpConfigJson);

    for (const dir of ALLOWED_PATHS) args.push("--add-dir", dir);

    if (sessionId) {
      args.push("--resume", sessionId);
      console.log(`[claude] RESUMING session ${sessionId.slice(0, 8)}...`);
    } else {
      console.log("[claude] STARTING new session");
    }

    args.push("--input-format", "text");

    // State
    const responseParts: string[] = [];
    let capturedSessionId: string | null = sessionId;
    let capturedUsage: TokenUsage | null = null;
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    this._running = true;

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(CLAUDE_CLI_PATH, args, {
          cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this._child = child;

        child.stdin!.write(message, "utf8");
        child.stdin!.end();

        let lineBuffer = "";
        let stderrBuffer = "";

        child.stdout!.on("data", (chunk: Buffer) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: CliEvent;
            try { event = JSON.parse(trimmed) as CliEvent; }
            catch { continue; }
            processEvent(event).catch(reject);
          }
        });

        child.stderr!.on("data", (c: Buffer) => { stderrBuffer += c.toString(); });
        child.on("error", reject);

        child.on("close", (code) => {
          const rem = lineBuffer.trim();
          if (rem) { try { processEvent(JSON.parse(rem) as CliEvent).catch(() => {}); } catch {} }
          if (stderrBuffer.trim()) console.warn(`[claude] stderr: ${stderrBuffer.trim().slice(0, 300)}`);
          if (code !== 0 && !queryCompleted && !askUserTriggered) {
            reject(new Error(`claude exited with code ${code}: ${stderrBuffer.slice(0, 200)}`));
          } else {
            resolve();
          }
        });

        const processEvent = async (event: CliEvent): Promise<void> => {
          // Capture session_id
          if (!capturedSessionId && event.session_id) {
            capturedSessionId = event.session_id;
            console.log(`[claude] GOT session_id: ${capturedSessionId.slice(0, 8)}...`);
          }

          if (event.type === "assistant") {
            const assistantEvent = event as CliAssistantEvent;
            for (const block of assistantEvent.message.content) {
              if (block.type === "thinking") {
                const b = block as { type: "thinking"; thinking: string };
                if (b.thinking) {
                  await statusCallback("thinking", b.thinking);
                }
              }

              if (block.type === "tool_use") {
                const b = block as { type: "tool_use"; name: string; input: Record<string, unknown> };

                // Safety: Bash
                if (b.name === "Bash") {
                  const cmd = String(b.input.command || "");
                  const [safe, reason] = checkCommandSafety(cmd);
                  if (!safe) {
                    await statusCallback("tool", `BLOCKED: ${reason}`);
                    child.kill("SIGTERM");
                    throw new Error(`Unsafe command blocked: ${reason}`);
                  }
                }

                // Safety: file ops
                if (["Read", "Write", "Edit"].includes(b.name)) {
                  const filePath = String(b.input.file_path || "");
                  if (filePath) {
                    const isTmpRead = b.name === "Read" && (TEMP_PATHS.some((p) => filePath.startsWith(p)) || filePath.includes("/.claude/"));
                    if (!isTmpRead && !isPathAllowed(filePath)) {
                      await statusCallback("tool", `Access denied: ${filePath}`);
                      child.kill("SIGTERM");
                      throw new Error(`File access blocked: ${filePath}`);
                    }
                  }
                }

                // Flush pending segment
                if (currentSegmentText) {
                  await statusCallback("segment_end", currentSegmentText, currentSegmentId);
                  currentSegmentId++;
                  currentSegmentText = "";
                }

                const toolDisplay = formatToolStatus(b.name, b.input);
                console.log(`[claude] Tool: ${toolDisplay}`);
                if (!b.name.startsWith("mcp__ask-user") && !b.name.startsWith("mcp__send-file")) {
                  await statusCallback("tool", toolDisplay);
                }

                // ask_user MCP
                if (b.name.startsWith("mcp__ask-user") && ctx && chatId) {
                  await new Promise((r) => setTimeout(r, 200));
                  for (let i = 0; i < 3; i++) {
                    const sent = await checkPendingAskUserRequests(ctx, chatId);
                    if (sent) { askUserTriggered = true; break; }
                    if (i < 2) await new Promise((r) => setTimeout(r, 100));
                  }
                  if (askUserTriggered) { child.kill("SIGTERM"); return; }
                }

                // send_file MCP
                if (b.name.startsWith("mcp__send-file") && ctx && chatId) {
                  await new Promise((r) => setTimeout(r, 200));
                  for (let i = 0; i < 3; i++) {
                    const sent = await checkPendingSendFileRequests(ctx, chatId);
                    if (sent) break;
                    if (i < 2) await new Promise((r) => setTimeout(r, 100));
                  }
                }
              }

              if (block.type === "text") {
                const b = block as { type: "text"; text: string };
                responseParts.push(b.text);
                currentSegmentText += b.text;
                const now = Date.now();
                if (now - lastTextUpdate > STREAMING_THROTTLE_MS && currentSegmentText.length > 20) {
                  await statusCallback("text", currentSegmentText, currentSegmentId);
                  lastTextUpdate = now;
                }
              }
            }
          }

          if (event.type === "result") {
            queryCompleted = true;
            const r = event as CliResultEvent;
            if (r.usage) {
              capturedUsage = r.usage as TokenUsage;
              console.log(`[claude] Usage: in=${capturedUsage.input_tokens} out=${capturedUsage.output_tokens} cache_read=${capturedUsage.cache_read_input_tokens || 0}`);
            }
          }
        };
      });
    } finally {
      this._running = false;
      this._child = null;
    }

    // Flush remaining segment
    if (currentSegmentText && !askUserTriggered) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    return {
      text: askUserTriggered ? "[Waiting for user selection]" : (responseParts.join("") || "No response from Claude."),
      sessionId: capturedSessionId,
      usage: capturedUsage,
      askUserTriggered,
    };
  }
}
