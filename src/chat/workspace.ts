import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureDirectory } from "../setup/files.js";

const CHAT_AGENTS = `# QQ Q&A mode

This directory is the bridge's project-less chat workspace.

- No project is selected. Answer the user's question directly.
- Do not create, edit, move, or delete files.
- Do not run shell commands or access directories outside this workspace.
- If you need clarification, ask in plain text. Never call the question tool.
`;

/**
 * Create the project-less chat directory and its workspace instructions.
 * Relative paths are ignored: only the resolved configuration path is used in
 * production, and tests that construct configs directly should stay isolated.
 */
export function ensureChatWorkspace(path: string | null): string | null {
  if (path === null || !isAbsolute(path)) return null;
  ensureDirectory(path);
  const agentsPath = join(path, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, CHAT_AGENTS, { encoding: "utf8", mode: 0o600 });
  }
  return path;
}
