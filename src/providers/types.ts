/**
 * Provider interface for agentic CLI backends.
 *
 * Each provider knows how to spawn its CLI, parse its streaming output,
 * and map events to the shared StatusCallback interface.
 */

import type { Context } from "grammy";
import type { StatusCallback, TokenUsage } from "../types";

/** Which AI agent provider to use */
export type ProviderName = "claude" | "codex";

/** Shared options passed to every provider invocation */
export interface ProviderRunOptions {
  /** The user's message to send */
  message: string;
  /** Session ID to resume (provider-specific interpretation) */
  sessionId: string | null;
  /** Working directory for the agent */
  cwd: string;
  /** Callback to stream status updates to Telegram */
  statusCallback: StatusCallback;
  /** grammY context (for MCP ask_user buttons) */
  ctx?: Context;
  /** Telegram chat ID */
  chatId?: number;
}

/** Result returned by a provider run */
export interface ProviderRunResult {
  /** Full text response from the agent */
  text: string;
  /** Session ID for future resume (null if not applicable) */
  sessionId: string | null;
  /** Token usage (null if not available) */
  usage: TokenUsage | null;
  /** Whether run ended because ask_user was triggered */
  askUserTriggered: boolean;
}

/** Abstract interface all providers must implement */
export interface AgentProvider {
  readonly name: ProviderName;

  /** Human-readable model name (e.g. "claude-sonnet-4-5") */
  readonly modelName?: string;

  /**
   * Run a single prompt and stream updates via statusCallback.
   * Must handle cancellation via the AbortController set by setAbortController.
   */
  run(options: ProviderRunOptions): Promise<ProviderRunResult>;

  /**
   * Abort any currently running invocation (SIGTERM to child process).
   */
  abort(): void;

  /**
   * Whether a run is currently in progress.
   */
  readonly isRunning: boolean;
}
