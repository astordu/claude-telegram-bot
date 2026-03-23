/**
 * Session management for Claude Telegram Bot.
 *
 * AgentSession manages conversation state (session IDs, history, activity
 * tracking) and delegates actual CLI invocation to a pluggable AgentProvider.
 *
 * Switch provider via AGENT_PROVIDER env var: "claude" (default) | "codex"
 */

import { readFileSync, mkdirSync } from "fs";
import path from "path";
import type { Context } from "grammy";
import { AGENT_PROVIDER } from "./config";
import { createProvider } from "./providers";
import type { AgentProvider } from "./providers";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";
import { getWorkspace } from "./workspace";

// Maximum number of sessions to keep in history
const MAX_SESSIONS = 5;

export class AgentSession {
  public chatId: number;
  public cwd: string;

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

  private provider: AgentProvider = createProvider(AGENT_PROVIDER);
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;
  private stopRequested = false;

  constructor(chatId: number, cwd: string) {
    this.chatId = chatId;
    this.cwd = cwd;
    // Auto-restore last session from disk so bot restarts don't cause amnesia
    this._restoreLastSession();
  }

  private _restoreLastSession(): void {
    try {
      const sessions = this.getSessionList();
      if (sessions.length > 0 && sessions[0]) {
        this.sessionId = sessions[0].session_id;
        this.conversationTitle = sessions[0].title;
        console.log(`[session] Auto-restored session ${this.sessionId.slice(0, 8)}... for chat ${this.chatId}`);
      }
    } catch {
      // Ignore restore errors - start fresh
    }
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.provider.isRunning || this._isProcessing;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get modelName(): string {
    return this.provider.modelName ?? this.provider.name;
  }

  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) this.stopRequested = false;
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
    return () => { this._isProcessing = false; };
  }

  async stop(): Promise<"stopped" | "pending" | false> {
    if (this.provider.isRunning) {
      this.stopRequested = true;
      this.provider.abort();
      console.log(`[${this.provider.name}] Stop requested`);
      return "stopped";
    }
    if (this._isProcessing) {
      this.stopRequested = true;
      return "pending";
    }
    return false;
  }

  /**
   * Switch to a different provider at runtime.
   * Implicitly clears the current session (different provider can't resume).
   */
  switchProvider(name: "claude" | "codex"): void {
    if (name === this.provider.name) return;
    this.provider = createProvider(name);
    this.sessionId = null;          // can't resume across providers
    this.conversationTitle = null;
    this.lastActivity = null;
    console.log(`Switched to provider: ${name}`);
  }

  /**
   * Send a message, streaming status updates via callback.
   */
  async sendMessageStreaming(
    message: string,
    _username: string,
    _userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool (Claude-specific)
    if (chatId) process.env.TELEGRAM_CHAT_ID = String(chatId);

    const isNewSession = !this.isActive;

    // Inject current date/time at session start
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      })}]\n\n`;
      messageToSend = datePrefix + message;
    }

    if (this.stopRequested) {
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    this.queryStarted = new Date();
    this.currentTool = null;

    // Wrap statusCallback to track currentTool
    const wrappedCallback: StatusCallback = async (type, content, segmentId?) => {
      if (type === "tool") {
        this.currentTool = content;
        this.lastTool = content;
      } else if (type === "done" || type === "segment_end") {
        this.currentTool = null;
      }
      return statusCallback(type, content, segmentId);
    };

    try {
      const result = await this.provider.run({
        message: messageToSend,
        sessionId: this.sessionId,
        cwd: this.cwd,
        statusCallback: wrappedCallback,
        ctx,
        chatId,
      });

      this.lastActivity = new Date();
      this.lastError = null;
      this.lastErrorTime = null;

      // Persist session ID
      if (result.sessionId && result.sessionId !== this.sessionId) {
        this.sessionId = result.sessionId;
        this.saveSession();
      }

      if (result.usage) {
        this.lastUsage = result.usage;
      }

      await statusCallback("done", "");

      return result.text;
    } catch (error) {
      this.lastError = String(error).slice(0, 100);
      this.lastErrorTime = new Date();
      this.queryStarted = null;
      this.currentTool = null;
      throw error;
    } finally {
      this.queryStarted = null;
      this.currentTool = null;
    }
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
        working_dir: this.cwd,
        title: this.conversationTitle || "Untitled Session",
      };
      const idx = history.sessions.findIndex((s) => s.session_id === this.sessionId);
      if (idx !== -1) {
        history.sessions[idx] = newSession;
      } else {
        history.sessions.unshift(newSession);
      }
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);
      const sessionFile = this.getSessionFile();
      Bun.write(sessionFile, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${sessionFile}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  private getSessionFile(): string {
    const dir = "/tmp/telegram-sessions";
    try { mkdirSync(dir, { recursive: true }); } catch {}
    return path.join(dir, `session_${this.chatId}.json`);
  }

  private loadSessionHistory(): SessionHistory {
    const sessionFile = this.getSessionFile();
    try {
      const file = Bun.file(sessionFile);
      if (!file.size) return { sessions: [] };
      const text = readFileSync(sessionFile, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    return history.sessions;
  }

  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);
    if (!sessionData) return [false, "Session not found"];
    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();
    console.log(`Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`);
    return [true, `Resumed session: "${sessionData.title}"`];
  }

  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) return [false, "No saved sessions"];
    return this.resumeSession(sessions[0]!.session_id);
  }
}

/**
 * Manages multiple AgentSessions mapped by chatId.
 */
class SessionManager {
  private sessions = new Map<number, AgentSession>();

  /**
   * Gets or creates a session for the given chatId.
   * Recreates the session if the workspace configuration has changed.
   */
  getOrCreate(chatId: number): AgentSession | null {
    const cwd = getWorkspace(chatId);
    if (!cwd) {
      // No workspace bound. Can return null or throw. 
      // We return null so the handler can reply with an error message to bind first.
      return null;
    }

    let session = this.sessions.get(chatId);
    if (!session || session.cwd !== cwd) {
      // Re-initialize if missing or if the cwd was changed config-side
      session = new AgentSession(chatId, cwd);
      this.sessions.set(chatId, session);
    }
    return session;
  }
  
  get(chatId: number): AgentSession | undefined {
    return this.sessions.get(chatId);
  }
}

export const sessionManager = new SessionManager();
