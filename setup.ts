#!/usr/bin/env bun
/**
 * Interactive first-run setup for Claude Telegram Bot.
 *
 * Checks if TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS are set.
 * If missing, prompts the user and writes them to .env automatically.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = resolve(ROOT, ".env");
const ENV_EXAMPLE_FILE = resolve(ROOT, ".env.example");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Read current .env content (or use example as base). */
function readEnvContent(): string {
  if (existsSync(ENV_FILE)) {
    return readFileSync(ENV_FILE, "utf-8");
  }
  if (existsSync(ENV_EXAMPLE_FILE)) {
    return readFileSync(ENV_EXAMPLE_FILE, "utf-8");
  }
  return "# Claude Telegram Bot - Environment Configuration\n\n";
}

/** Extract value for a key from .env content. */
function getEnvValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? (match[1] ?? "").trim() : "";
}

/** Set or add a key=value line in .env content. */
function setEnvValue(content: string, key: string, value: string): string {
  const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  return content.trimEnd() + `\n${line}\n`;
}

/** Prompt user for input using readline (reliable for sequential prompts). */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Validate Telegram bot token format. */
function isValidToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{35,}$/.test(token);
}

/** Validate numeric user ID. */
function isValidUserId(id: string): boolean {
  return /^\d+$/.test(id.trim());
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log("\n🤖 \x1b[1mClaude Telegram Bot - Setup\x1b[0m");
console.log("─".repeat(40));

let envContent = readEnvContent();
let changed = false;

// ── Token ──────────────────────────────────────────────────────────────────

let token = getEnvValue(envContent, "TELEGRAM_BOT_TOKEN");

// Treat placeholder value as missing
if (!token || token.startsWith("1234567890")) token = "";

if (!token) {
  console.log("\n📌 \x1b[33mTELEGRAM_BOT_TOKEN\x1b[0m is not set.");
  console.log("   Get your token from \x1b[36m@BotFather\x1b[0m on Telegram.");
  console.log("   (Send /newbot to @BotFather and copy the token)\n");

  while (true) {
    token = await prompt("   Enter bot token: ");
    if (isValidToken(token)) break;
    console.log("   ❌ Invalid token format. Should look like: 123456789:ABCdef...");
  }

  envContent = setEnvValue(envContent, "TELEGRAM_BOT_TOKEN", token);
  changed = true;
  console.log("   ✅ Token saved.");
} else {
  console.log(`\n✅ TELEGRAM_BOT_TOKEN: already set (${token.split(":")[0] ?? "???"}:***)`);
}

// ── Allowed Users ──────────────────────────────────────────────────────────

let allowedUsers = getEnvValue(envContent, "TELEGRAM_ALLOWED_USERS");

// Treat placeholder/empty as missing
if (!allowedUsers || allowedUsers === "123456789") allowedUsers = "";

if (!allowedUsers) {
  console.log("\n📌 \x1b[33mTELEGRAM_ALLOWED_USERS\x1b[0m is not set.");
  console.log("   This is YOUR Telegram user ID (a number, not a username).");
  console.log("   To find it: message \x1b[36m@userinfobot\x1b[0m on Telegram and it will reply with your ID.\n");

  while (true) {
    allowedUsers = await prompt("   Enter your Telegram user ID: ");
    // Support comma-separated multiple IDs
    const ids = allowedUsers.split(",").map((s) => s.trim());
    if (ids.every(isValidUserId)) break;
    console.log("   ❌ Invalid format. Enter numeric ID(s), e.g.: 123456789");
  }

  envContent = setEnvValue(envContent, "TELEGRAM_ALLOWED_USERS", allowedUsers);
  changed = true;
  console.log("   ✅ User ID saved.");
} else {
  console.log(`✅ TELEGRAM_ALLOWED_USERS: already set (${allowedUsers})`);
}

// ── Write .env ─────────────────────────────────────────────────────────────

if (changed) {
  writeFileSync(ENV_FILE, envContent, "utf-8");
  console.log(`\n💾 Configuration written to \x1b[32m.env\x1b[0m`);
} else {
  console.log("\n✨ All required settings are already configured.");
}

console.log("\n" + "─".repeat(40));
console.log("🚀 Starting bot...\n");
