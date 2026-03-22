import fs from "fs";
import path from "path";

/**
 * Interface configuring a chat group's workspace settings.
 */
export interface WorkspaceConfig {
  cwd: string;
}

// Stores the router map: chatId -> config
let workspaces: Record<string, WorkspaceConfig> = {};

// We put the JSON configuration in the root directory
const WORKSPACES_FILE = path.join(process.cwd(), "workspaces.json");

/**
 * Loads workspaces from the JSON file on disk.
 */
export function loadWorkspaces() {
  if (fs.existsSync(WORKSPACES_FILE)) {
    try {
      const data = fs.readFileSync(WORKSPACES_FILE, "utf-8");
      workspaces = JSON.parse(data);
      console.log(`Loaded ${Object.keys(workspaces).length} root workspaces from config.`);
    } catch (e) {
      console.error("Failed to parse workspaces.json", e);
    }
  } else {
    // If it doesn't exist, start with empty configuration
    workspaces = {};
    saveWorkspaces();
  }
}

/**
 * Saves current workspaces map to disk.
 */
function saveWorkspaces() {
  try {
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write to workspaces.json", e);
  }
}

/**
 * Retrieves the workspace root path associated with the given chatId.
 * @returns The absolute `cwd` path or null if no workspace is tied to this chat.
 */
export function getWorkspace(chatId: number | string): string | null {
  const config = workspaces[String(chatId)];
  if (config) {
    return config.cwd;
  }

  // Fallback default for private chats
  if (Number(chatId) > 0) {
    const home = process.env.HOME || require("os").homedir();
    const defaultDir = require("path").resolve(home, "lei_workspace");
    
    // Ensure the default workspace exists to avoid ENOENT on spawn
    if (!fs.existsSync(defaultDir)) {
      try {
        fs.mkdirSync(defaultDir, { recursive: true });
      } catch (e) {
        console.error(`Failed to create default workspace: ${defaultDir}`, e);
      }
    }
    
    return defaultDir;
  }

  return null;
}

/**
 * Binds a specific directory path to a chatId.
 * @param cwd Absolute path to the directory (workspace).
 */
export function bindWorkspace(chatId: number | string, cwd: string) {
  workspaces[String(chatId)] = { cwd };
  saveWorkspaces();
}

/**
 * Removes the workspace binding for a specific chatId.
 */
export function unbindWorkspace(chatId: number | string) {
  delete workspaces[String(chatId)];
  saveWorkspaces();
}

// Load workspace at module initialization
loadWorkspaces();
