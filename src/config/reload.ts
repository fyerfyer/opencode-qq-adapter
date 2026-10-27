import type { AppConfig } from "./schema.js";

export interface ConfigReloadResult {
  ok: boolean;
  applied: string[];
  restartRequired: string[];
  warnings: string[];
  error?: string;
}

type MutableRecord = Record<string, unknown>;

const RECORD_SECTIONS = ["users", "projects", "plugins"] as const;
const IN_PLACE_SECTIONS = [
  "security",
  "features",
  "qq",
  "notifications",
  "workspaces",
  "admin",
  "logging",
] as const;
const RESTART_SECTIONS = ["onebot", "server", "storage"] as const;

/**
 * Apply the safe-to-hot-reload parts of `next` to `current`.
 *
 * Object sections are merged in place so services that captured a reference
 * (the sender holds `config.qq`, OpenCode holds `config.opencode`, etc.) see the
 * new values. Record sections are replaced so deleted users/projects disappear.
 */
export function applyHotConfig(
  current: AppConfig,
  next: AppConfig,
): { applied: string[]; restartRequired: string[] } {
  const applied: string[] = [];
  const restartRequired: string[] = [];

  for (const section of RECORD_SECTIONS) {
    if (!sameJson(current[section], next[section])) {
      (current as unknown as MutableRecord)[section] = next[section];
      applied.push(section);
    }
  }

  if (current.default_project !== next.default_project) {
    current.default_project = next.default_project;
    applied.push("default_project");
  }

  const prettyChanged = current.logging.pretty !== next.logging.pretty;
  const adminEnabledChanged = current.admin.enabled !== next.admin.enabled;

  for (const section of IN_PLACE_SECTIONS) {
    if (!sameJson(current[section], next[section])) {
      deepReplace(current[section] as MutableRecord, next[section] as MutableRecord);
      applied.push(section);
    }
  }

  const currentOpenCode = current.opencode as unknown as MutableRecord;
  const nextOpenCode = next.opencode as unknown as MutableRecord;
  for (const [key, value] of Object.entries(nextOpenCode)) {
    if (key === "service") continue;
    if (!sameJson(currentOpenCode[key], value)) {
      currentOpenCode[key] = value;
      applied.push(`opencode.${key}`);
    }
  }
  if (!sameJson(current.opencode.service, next.opencode.service)) {
    restartRequired.push("opencode.service");
  }

  for (const section of RESTART_SECTIONS) {
    if (!sameJson(current[section], next[section])) restartRequired.push(section);
  }

  if (prettyChanged) {
    restartRequired.push("logging.pretty");
  }
  if (adminEnabledChanged) {
    restartRequired.push("admin.enabled");
  }

  return { applied: [...new Set(applied)], restartRequired: [...new Set(restartRequired)] };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Recursively update an object, preserving its identity and deleting removed keys. */
function deepReplace(target: MutableRecord, source: MutableRecord): void {
  const dangerous = new Set(["__proto__", "constructor", "prototype"]);
  for (const key of Object.keys(target)) {
    if (!(key in source) && !dangerous.has(key)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (dangerous.has(key)) continue;
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      deepReplace(current, value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is MutableRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
