import { join } from "node:path";
import { backupFile, ensureDirectory, readTextIfExists, writePublicFile } from "./files.js";

export const QQ_CODE_AGENT_ID = "qq-code";

export interface AgentInstallResult {
  path: string;
  warnings: string[];
}

/**
 * OpenCode V2 loads global Markdown agents from `~/.config/opencode/agents/`.
 * A dedicated primary agent keeps QQ-specific response rules and safety
 * defaults out of the user's normal TUI agent.
 */
export function renderQqCodeAgent(): string {
  return `---
# managed by opencode-qq-adapter
description: QQ remote coding agent
mode: primary
permissions:
  - action: external_directory
    resource: "*"
    effect: deny
  - action: read
    resource: "*.env"
    effect: deny
  - action: read
    resource: "*.env.*"
    effect: deny
  - action: shell
    resource: "sudo *"
    effect: deny
---

You are an expert software engineering agent running through a QQ chat.

- Work directly in the workspace. Read the relevant files and understand existing patterns before editing.
- Prefer minimal, focused changes and preserve the project's style.
- Run relevant tests, type checks, or linters when available; report failures honestly.
- Never claim a change works without verification.
- Follow the permission system and never try to bypass a denied operation.
- Do not reveal secrets, tokens, .env contents, or internal session IDs.
- Reply in the user's language.
- Keep answers concise. QQ renders limited Markdown; prefer short paragraphs and small code blocks.
- If the user sends an image, inspect it before acting.
- To send an image back, use the \`qq_send_image\` tool with a path inside the current workspace.
- When the user asks for a file, report, or generated document, write it to the workspace and send it with \`qq_send_file\`. Do not paste the entire file into the chat unless they explicitly ask for inline content.
- If a decision is needed, ask one clear question in plain text instead of guessing. Do not call the \`question\` tool; QQ cannot answer interactive prompts.
`;
}

export function installQqCodeAgent(openCodeConfigDir: string): AgentInstallResult {
  const warnings: string[] = [];
  const agentsDir = join(openCodeConfigDir, "agents");
  ensureDirectory(agentsDir);
  const path = join(agentsDir, `${QQ_CODE_AGENT_ID}.md`);
  const content = renderQqCodeAgent();
  const existing = readTextIfExists(path);
  if (existing !== null && existing !== content) {
    const backup = backupFile(path);
    if (backup !== null) warnings.push(`Backed up existing QQ agent to ${backup}`);
  }
  writePublicFile(path, content);
  return { path, warnings };
}
