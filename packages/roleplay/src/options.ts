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
  memoryEnabled: boolean;
  memoryUtilityAgent: string;
  memoryUtilityModel: string | null;
  memoryUtilityTimeoutMs: number;
  memoryConsolidateEveryTurns: number;
  memoryIdleDebounceMs: number;
  memoryUserMaxChars: number;
  memorySceneMaxChars: number;
  memoryRawTopK: number;
  memoryRawMaxChars: number;
  memoryMaxChars: number;
  memoryExcludeRecent: number;
  memoryHistoryLimit: number;
  memoryRefreshCooldownMs: number;
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
    memoryEnabled: value.memory_enabled !== false && value.memory_llm !== false,
    memoryUtilityAgent: text(value.memory_utility_agent, "qq-rp-utility"),
    memoryUtilityModel: optionalText(value.memory_utility_model),
    memoryUtilityTimeoutMs: number(value.memory_utility_timeout_ms, 90_000, 5_000, 300_000),
    memoryConsolidateEveryTurns: number(
      value.memory_consolidate_every_turns ?? value.memory_extract_every_turns,
      8,
      1,
      100,
    ),
    memoryIdleDebounceMs: number(value.memory_idle_debounce_ms, 120_000, 0, 1_800_000),
    memoryUserMaxChars: number(value.memory_user_max_chars, 1200, 200, 4000),
    memorySceneMaxChars: number(value.memory_scene_max_chars, 800, 0, 4000),
    memoryRawTopK: number(value.memory_raw_top_k ?? value.memory_top_k, 6, 1, 20),
    memoryRawMaxChars: number(value.memory_raw_max_chars, 600, 0, 4000),
    memoryMaxChars: number(value.memory_max_chars, 2400, 200, 8000),
    memoryExcludeRecent: number(value.memory_exclude_recent, 10, 0, 100),
    memoryHistoryLimit: number(value.memory_history_limit, 20, 1, 100),
    memoryRefreshCooldownMs: number(value.memory_refresh_cooldown_ms, 60_000, 0, 3_600_000),
    installAgent: value.install_agent !== false,
    opencodeConfigDir: optionalText(value.opencode_config_dir),
  };
}
