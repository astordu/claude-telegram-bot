/**
 * Provider factory — creates the correct AgentProvider based on config.
 */

import { ClaudeProvider } from "./claude";
import { CodexProvider } from "./codex";
import type { AgentProvider, ProviderName } from "./types";

export type { AgentProvider, ProviderName, ProviderRunOptions, ProviderRunResult } from "./types";
export { ClaudeProvider } from "./claude";
export { CodexProvider } from "./codex";

/**
 * Create a provider instance by name.
 */
export function createProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case "codex":
      return new CodexProvider();
    case "claude":
    default:
      return new ClaudeProvider();
  }
}
