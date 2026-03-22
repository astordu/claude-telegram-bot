/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { sessionManager } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  require("fs").appendFileSync("/tmp/debug.log", `handleText entered: message=${message}, user=${userId}, chat=${chatId}\n`);

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    require("fs").appendFileSync("/tmp/debug.log", `blocked by isAuthorized\n`);
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message, chatId);
  if (!message.trim()) {
    require("fs").appendFileSync("/tmp/debug.log", `blocked by checkInterrupt\n`);
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    require("fs").appendFileSync("/tmp/debug.log", `blocked by rateLimiter\n`);
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Get active session for this chat
  const session = sessionManager.getOrCreate(chatId);
  if (!session) {
    require("fs").appendFileSync("/tmp/debug.log", `no session, sending reply\n`);
    try {
      await ctx.reply(
        "❌ <b>No workspace bound.</b>\n\nPlease use <code>/bind &lt;absolute_path&gt;</code> to bind a working directory for this chat first.",
        { parse_mode: "HTML" }
      );
      require("fs").appendFileSync("/tmp/debug.log", `no session reply sent ok\n`);
    } catch (e: any) {
      require("fs").appendFileSync("/tmp/debug.log", `no session reply FAILED: ${e.message}\n`);
    }
    return;
  }

  // 5. Store message for retry
  session.lastMessage = message;

  // 5. Set conversation title from first message (if new session)
  if (!session.isActive) {
    // Truncate title to ~50 chars
    const title =
      message.length > 50 ? message.slice(0, 47) + "..." : message;
    session.conversationTitle = title;
  }

  // 6. Mark processing started
  const stopProcessing = session.startProcessing();

  // 7. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 8. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  // 9. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );

      // 10. Audit log
      await auditLog(userId, username, "TEXT", message, response);
      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error("Error processing message:", error);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 11. Cleanup
  stopProcessing();
  typing.stop();
}
