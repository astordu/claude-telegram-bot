/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard markdown to Telegram-compatible HTML.
 *
 * HTML is more reliable than Telegram's Markdown which breaks on special chars.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="">
 */
export function convertMarkdownToHtml(text: string): string {
  // All pre-rendered HTML blocks are stored here and swapped back after escaping
  const htmlBlocks: string[] = [];
  const saveHtmlBlock = (html: string): string => {
    htmlBlocks.push(html);
    return `\x00HTMLBLOCK${htmlBlocks.length - 1}\x00`;
  };

  // 1. Save fenced code blocks (```...```)
  text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    return saveHtmlBlock(`<pre>${escapeHtml(code)}</pre>`);
  });

  // 2. Save inline code (`...`)
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    return saveHtmlBlock(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Save blockquotes (match raw '>' before HTML escaping)
  text = text.replace(/(?:^> ?.*\n?)+/gm, (block) => {
    const inner = block
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (l.startsWith("> ") ? l.slice(2) : l.startsWith(">") ? l.slice(1) : l))
      .join("\n");
    return saveHtmlBlock(`<blockquote>${escapeHtml(inner)}</blockquote>`);
  });

  // 4. Save markdown tables (lines starting with '|')
  // Use \n? on last line so the final row is captured even without trailing newline
  text = text.replace(/(?:^\|.+\n)*^\|.+/gm, (tableBlock) => {
    const rows = tableBlock
      .trim()
      .split("\n")
      .filter((row) => !/^\|[-| :]+\|$/.test(row.trim()));
    const formatted = rows
      .map((row) =>
        row
          .split("|")
          .filter((_, i, arr) => i > 0 && i < arr.length - 1)
          .map((cell) => cell.trim())
          .join("  │  ")
      )
      .join("\n");
    return saveHtmlBlock(`<pre>${escapeHtml(formatted)}</pre>`);
  });

  // 5. Escape remaining HTML entities (safe now - HTML blocks are in placeholders)
  text = escapeHtml(text);

  // 6. Markdown conversions
  // H1 (# Title) -> bold with decorative separator
  text = text.replace(/^# (.+)$/gm, "\n🔷 <b>$1</b>\n");
  // H2 (## Title) -> bold with line above
  text = text.replace(/^## (.+)$/gm, "\n<b>── $1 ──</b>\n");
  // H3+ (### Title) -> bold with ▸ prefix
  text = text.replace(/^#{3,6} (.+)$/gm, "\n<b>▸ $1</b>\n");

  // Bold: **text** -> <b>text</b>  (no s-flag: must not span newlines)
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Double underscore __text__ -> <b>text</b>
  text = text.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic: _text_ -> <i>text</i>
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");

  // Bullet lists: - item or * item -> • item
  text = text.replace(/^[-*] /gm, "• ");

  // Numbered list: clean up stray backslash escapes ("1\. item" -> "1. item")
  text = text.replace(/^(\d+)\\\. /gm, "$1. ");

  // Horizontal rules --- -> visual separator
  text = text.replace(/^[-*]{3,}$/gm, "──────────");

  // Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Restore all HTML blocks
  for (let i = 0; i < htmlBlocks.length; i++) {
    text = text.replace(`\x00HTMLBLOCK${i}\x00`, htmlBlocks[i]!);
  }

  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text;
}


/**
 * Convert blockquotes (handles multi-line). Must be called BEFORE escapeHtml.
 */
function convertBlockquotes(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inBlockquote = false;
  const blockquoteLines: string[] = [];

  for (const line of lines) {
    // Match '> ' at line start (raw, before HTML escaping)
    if (line.startsWith("> ") || line === ">") {
      const content = line === ">" ? "" : line.slice(2).replace(/#/g, "");
      blockquoteLines.push(content);
      inBlockquote = true;
    } else {
      if (inBlockquote) {
        result.push(
          "<blockquote>" + blockquoteLines.join("\n") + "</blockquote>"
        );
        blockquoteLines.length = 0;
        inBlockquote = false;
      }
      result.push(line);
    }
  }

  // Handle blockquote at end
  if (inBlockquote) {
    result.push("<blockquote>" + blockquoteLines.join("\n") + "</blockquote>");
  }

  return result.join("\n");
}

/**
 * Convert markdown tables to <pre> blocks (Telegram does not support HTML tables).
 * Must be called BEFORE escapeHtml.
 */
function convertTables(text: string): string {
  // Match a block of lines that all start with '|'
  return text.replace(/(?:^\|.+\n)+/gm, (tableBlock) => {
    // Strip alignment rows (| --- | --- |)
    const rows = tableBlock
      .trim()
      .split("\n")
      .filter((row) => !/^\|[-| :]+\|$/.test(row.trim()));

    const formatted = rows
      .map((row) =>
        row
          .split("|")
          .filter((_, i, arr) => i > 0 && i < arr.length - 1) // drop empty first/last
          .map((cell) => cell.trim())
          .join("  |  ")
      )
      .join("\n");

    return `<pre>${formatted}</pre>\n`;
  });
}

// Legacy alias
export const convertMarkdownForTelegram = convertMarkdownToHtml;

// ============== Tool Status Formatting ==============

/**
 * Shorten a file path for display (last 2 components).
 */
function shortenPath(path: string): string {
  if (!path) return "file";
  const parts = path.split("/");
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[parts.length - 1] || path;
}

/**
 * Truncate text with ellipsis.
 */
function truncate(text: string, maxLen = 60): string {
  if (!text) return "";
  // Clean up newlines for display
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "...";
}

/**
 * Wrap text in HTML code tags, escaping special chars.
 */
function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/**
 * Format tool use for display in Telegram with HTML formatting.
 */
export function formatToolStatus(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const emojiMap: Record<string, string> = {
    Read: "📖",
    Write: "📝",
    Edit: "✏️",
    Bash: "▶️",
    Glob: "🔍",
    Grep: "🔎",
    WebSearch: "🔍",
    WebFetch: "🌐",
    Task: "🎯",
    TodoWrite: "📋",
    mcp__: "🔧",
  };

  // Find matching emoji
  let emoji = "🔧";
  for (const [key, val] of Object.entries(emojiMap)) {
    if (toolName.includes(key)) {
      emoji = val;
      break;
    }
  }

  // Format based on tool type
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "file");
    const shortPath = shortenPath(filePath);
    const imageExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".svg",
      ".ico",
    ];
    if (imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
      return "👀 Viewing";
    }
    return `${emoji} Reading ${code(shortPath)}`;
  }

  if (toolName === "Write") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Writing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Edit") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Editing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} ${escapeHtml(desc)}`;
    }
    return `${emoji} ${code(truncate(cmd, 50))}`;
  }

  if (toolName === "Grep") {
    const pattern = String(toolInput.pattern || "");
    const path = String(toolInput.path || "");
    if (path) {
      return `${emoji} Searching ${code(truncate(pattern, 30))} in ${code(
        shortenPath(path)
      )}`;
    }
    return `${emoji} Searching ${code(truncate(pattern, 40))}`;
  }

  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    return `${emoji} Finding ${code(truncate(pattern, 50))}`;
  }

  if (toolName === "WebSearch") {
    const query = String(toolInput.query || "");
    return `${emoji} Searching: ${escapeHtml(truncate(query, 50))}`;
  }

  if (toolName === "WebFetch") {
    const url = String(toolInput.url || "");
    return `${emoji} Fetching ${code(truncate(url, 50))}`;
  }

  if (toolName === "Task") {
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} Agent: ${escapeHtml(desc)}`;
    }
    return `${emoji} Running agent...`;
  }

  if (toolName === "Skill") {
    const skillName = String(toolInput.skill || "");
    if (skillName) {
      return `💭 Using skill: ${escapeHtml(skillName)}`;
    }
    return `💭 Using skill...`;
  }

  if (toolName.startsWith("mcp__")) {
    // Generic MCP tool formatting
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      const server = parts[1]!;
      let action = parts[2]!;
      // Remove redundant server prefix from action
      if (action.startsWith(`${server}_`)) {
        action = action.slice(server.length + 1);
      }
      action = action.replace(/_/g, " ");

      // Try to get meaningful summary
      const summary =
        toolInput.title ||
        toolInput.query ||
        toolInput.content ||
        toolInput.text ||
        toolInput.id ||
        "";

      if (summary) {
        return `🔧 ${server} ${action}: ${escapeHtml(
          truncate(String(summary), 40)
        )}`;
      }
      return `🔧 ${server}: ${action}`;
    }
    return `🔧 ${escapeHtml(toolName)}`;
  }

  return `${emoji} ${escapeHtml(toolName)}`;
}
