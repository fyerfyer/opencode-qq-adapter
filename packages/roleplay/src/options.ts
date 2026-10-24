export interface RoleplayOptions {
  projectId: string;
  agent: string;
  model: string | null;
  personasDir: string | null;
  defaultPersona: string | null;
  fallbackProject: string | null;
  maxSegments: number;
  maxCharsPerSegment: number;
  delayPerCharMs: number;
  maxDelayMs: number;
  worldbookScanDepth: number;
  worldbookMaxEntries: number;
  worldbookMaxChars: number;
  memoryTopK: number;
  memoryMaxChars: number;
  memoryExcludeRecent: number;
  installAgent: boolean;
  opencodeConfigDir: string | null;
}

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseRoleplayOptions(input: unknown): RoleplayOptions {
  const value = record(input);
  const projectId = text(value.project_id, "roleplay");
  const agent = text(value.agent, "qq-rp");
  if (
    value.project_id !== undefined &&
    (typeof value.project_id !== "string" || value.project_id.trim().length === 0)
  ) {
    throw new Error("project_id must be a non-empty string");
  }
  if (value.agent !== undefined && (typeof value.agent !== "string" || value.agent.trim().length === 0)) {
    throw new Error("agent must be a non-empty string");
  }

  return {
    projectId,
    agent,
    model: optionalText(value.model),
    personasDir: optionalText(value.personas_dir),
    defaultPersona: optionalText(value.default_persona),
    fallbackProject: optionalText(value.fallback_project),
    maxSegments: number(value.max_segments, 4, 1, 8),
    maxCharsPerSegment: number(value.max_chars_per_segment, 180, 40, 1000),
    delayPerCharMs: number(value.delay_per_char_ms, 28, 0, 200),
    maxDelayMs: number(value.max_delay_ms, 2500, 0, 5000),
    worldbookScanDepth: number(value.worldbook_scan_depth, 6, 0, 50),
    worldbookMaxEntries: number(value.worldbook_max_entries, 4, 0, 20),
    worldbookMaxChars: number(value.worldbook_max_chars, 1200, 0, 8000),
    memoryTopK: number(value.memory_top_k, 6, 1, 20),
    memoryMaxChars: number(value.memory_max_chars, 800, 0, 4000),
    memoryExcludeRecent: number(value.memory_exclude_recent, 10, 0, 100),
    installAgent: value.install_agent !== false,
    opencodeConfigDir: optionalText(value.opencode_config_dir),
  };
}
