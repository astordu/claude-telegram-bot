/**
 * Codex CLI provider.
 *
 * Spawns `codex exec --json` for non-interactive execution.
 * Uses --output-last-message for the final answer and parses JSONL
 * for session ID and streaming text updates.
 *
 * Key differences from Claude:
 * - No stdin input: prompt goes as positional arg (after --)
 * - Session resume: `codex exec resume <session_id>`
 * - Output is less structured: uses heuristic extraction
 * - No built-in thinking mode
 */

import { spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import { WORKING_DIR, STREAMING_THROTTLE_MS } from "../config";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "./types";

// ── Codex CLI path ─────────────────────────────────────────────────────────

function findCodexCli(): string {
  const envPath = process.env.CODEX_CLI_PATH;
  if (envPath) return envPath;
  // Common install paths
  for (const p of [
    `${os.homedir()}/.nvm/versions/node/v22.15.1/bin/codex`,
    `${os.homedir()}/.local/bin/codex`,
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "codex";
}

export const CODEX_CLI_PATH = findCodexCli();

// ── JSONL helpers (adapted from heyagent/codex-provider.js) ────────────────

function pickStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function extractText(content: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string" && item.trim()) {
        parts.push(item.trim());
      } else if (item && typeof item === "object") {
        const t =
          pickStr((item as Record<string, unknown>).text) ||
          pickStr((item as Record<string, unknown>).output_text) ||
          pickStr((item as Record<string, unknown>).output) ||
          extractText((item as Record<string, unknown>).content, depth + 1) ||
          extractText((item as Record<string, unknown>).message, depth + 1);
        if (t) parts.push(t);
      }
    }
    return parts.join("\n").trim();
  }
  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    const direct = pickStr(rec.text) || pickStr(rec.output_text) || pickStr(rec.output) || pickStr(rec.delta);
    if (direct) return direct;
    return (
      extractText(rec.content, depth + 1) ||
      extractText(rec.message, depth + 1) ||
      extractText(rec.output, depth + 1) ||
      extractText(rec.response, depth + 1) ||
      extractText(rec.result, depth + 1)
    );
  }
  return "";
}

function collectSessionId(event: Record<string, unknown>): string {
  return (
    pickStr(event.session_id) ||
    pickStr(event.sessionId) ||
    pickStr(event.thread_id) ||
    pickStr((event.payload as Record<string, unknown>)?.session_id) ||
    pickStr((event.data as Record<string, unknown>)?.session_id) ||
    pickStr((event.result as Record<string, unknown>)?.session_id) ||
    ""
  );
}

// ── Provider ───────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;

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
    const { message, sessionId, cwd, statusCallback } = opts;

    // Temp file to receive the last assistant message
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputFile = path.join(os.tmpdir(), `codex-last-${nonce}.txt`);

    // Build args — always use --output-last-message so we reliably capture the response.
    // Resume: `codex exec <opts> --output-last-message <file> resume --json <sessionId> -- <prompt>`
    // New:    `codex exec <opts> --output-last-message <file> --json -- <prompt>`
    let args: string[];
    if (sessionId) {
      args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C", cwd,
        "--output-last-message", outputFile,
        "resume",
        "--json",
        sessionId,
        "--",
        message,
      ];
      console.log(`[codex] RESUMING session ${sessionId.slice(0, 8)}...`);
    } else {
      args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C", cwd,
        "--json",
        "--output-last-message", outputFile,
        "--",
        message,
      ];
      console.log("[codex] STARTING new session");
    }

    let capturedSessionId: string | null = null;
    let stderrBuffer = "";

    // segmentCounter: each distinct piece of content gets a NEW id → creates a new Telegram message.
    // We start at a random offset so IDs don't conflict with any leftover state.
    let segmentCounter = Math.floor(Math.random() * 1_000_000) + 1;

    // Helper: send a new standalone Telegram message for this text.
    // Using segment_end with a never-seen segmentId hits the safety-net in streaming.ts
    // which calls ctx.reply() directly.
    const sendNewMessage = async (text: string) => {
      if (!text.trim()) return;
      await statusCallback("segment_end", text, segmentCounter++);
    };

    this._running = true;

    try {
      const fullStdout = await new Promise<string>((resolve, reject) => {
        console.log(`[codex] Spawning: ${CODEX_CLI_PATH} ${args.slice(0, 5).join(" ")} ...`);

        const child = spawn(CODEX_CLI_PATH, args, {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        this._child = child;

        let lineBuffer = "";
        let stdoutAccum = "";
        let lastSentChunk = "";       // deduplicate identical consecutive chunks
        let lastChunkTime = 0;

        child.stdout!.on("data", async (chunk: Buffer) => {
          const raw = chunk.toString();
          stdoutAccum += raw;
          lineBuffer += raw;

          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{")) continue;
            try {
              const event = JSON.parse(trimmed) as Record<string, unknown>;

              // Capture session ID
              if (!capturedSessionId) {
                capturedSessionId = collectSessionId(event) || null;
                if (capturedSessionId) {
                  console.log(`[codex] GOT session_id: ${capturedSessionId.slice(0, 8)}...`);
                }
              }

              // Tool invocations → ephemeral tool message (deleted at done)
              const eventType = pickStr(event.type).toLowerCase();
              if (eventType.includes("function_call") || eventType.includes("tool_call") || eventType.includes("exec")) {
                const toolName =
                  pickStr(event.name) ||
                  pickStr((event.call as Record<string, unknown>)?.name) ||
                  pickStr((event.function as Record<string, unknown>)?.name) ||
                  "tool";
                await statusCallback("tool", `🔧 ${toolName}`);
              }

              // Streaming text delta — accumulate and send when substantial
              if (eventType.endsWith(".delta") || eventType === "content_block_delta") {
                const delta = pickStr(event.delta) || extractText(event.delta);
                if (delta && delta !== lastSentChunk) {
                  const now = Date.now();
                  if (now - lastChunkTime > STREAMING_THROTTLE_MS && delta.trim().length > 30) {
                    lastSentChunk = delta;
                    lastChunkTime = now;
                    await sendNewMessage(delta);
                  }
                }
              }

              // Full assistant message chunks (non-delta)
              const textChunk =
                extractText(event.content) ||
                extractText(event.message) ||
                extractText(event.item);
              if (textChunk && textChunk !== lastSentChunk) {
                const now = Date.now();
                if (textChunk.trim().length > 10 && now - lastChunkTime > STREAMING_THROTTLE_MS) {
                  lastSentChunk = textChunk;
                  lastChunkTime = now;
                  await sendNewMessage(textChunk);
                }
              }
            } catch {
              // non-JSON line, skip
            }
          }
        });

        child.stderr!.on("data", (c: Buffer) => { stderrBuffer += c.toString(); });
        child.on("error", reject);

        child.on("close", (code) => {
          if (stderrBuffer.trim()) {
            console.warn(`[codex] stderr: ${stderrBuffer.trim().slice(0, 300)}`);
          }
          if (code !== 0) {
            reject(new Error(`codex exited with code ${code}: ${stderrBuffer.slice(0, 200)}`));
          } else {
            resolve(stdoutAccum);
          }
        });
      });

      // Get the canonical final response from the output-last-message file (most reliable)
      let responseText = "";
      try {
        if (fs.existsSync(outputFile)) {
          responseText = fs.readFileSync(outputFile, "utf8").trim();
        }
      } catch {}

      if (!responseText) {
        responseText = parseCodexFinalText(fullStdout);
      }

      if (!responseText) {
        responseText = "Codex returned no response.";
      }

      // Send the final response as a new independent message
      await sendNewMessage(responseText);

      return {
        text: responseText,
        sessionId: capturedSessionId,
        usage: null, // Codex CLI doesn't expose token usage in JSONL
        askUserTriggered: false,
      };
    } finally {
      this._running = false;
      this._child = null;
      // Clean up temp file
      try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch {}
    }
  }
}

/** Parse Codex JSONL output and return the best final text. */
function parseCodexFinalText(rawText: string): string {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const texts: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const direct =
        pickStr(event.text) ||
        pickStr(event.message as string) ||
        pickStr(event.output_text) ||
        pickStr(event.output as string) ||
        pickStr(event.delta as string);
      const fromContent =
        extractText(event.content) ||
        extractText((event.message as Record<string, unknown>)?.content) ||
        extractText((event.response as Record<string, unknown>)?.output) ||
        extractText(event.result);
      if (direct) texts.push(direct);
      if (fromContent) texts.push(fromContent);
    } catch {}
  }

  return texts.length > 0 ? texts[texts.length - 1]! : "";
}
