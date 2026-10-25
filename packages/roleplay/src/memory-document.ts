import { join } from "node:path";
import {
  type ApplyResult,
  type MemoryBundle,
  type MemoryDoc,
  type MemoryDocKind,
  type MemoryDocKindConfig,
  type MemoryDocPaths,
  type MemoryDocRef,
  type MemoryDocumentConfig,
  MemoryDocumentStore as BaseMemoryDocumentStore,
  type MemoryHistoryEntry,
  type MemoryOperation,
  type MemorySection,
  type ParsedDocument,
  applyOperations as applyMemoryOperations,
  defaultSections as defaultMemorySections,
  defaultTitle as defaultMemoryTitle,
  docForPrompt as memoryDocForPrompt,
  isAllowedSection as isAllowedMemorySection,
  normalizeDocument as normalizeMemoryDocument,
  parseDocument as parseMemoryDocument,
  renderDocument as renderMemoryDocument,
  safeMemorySegment,
  sceneForPrompt as memorySceneForPrompt,
} from "@opencode-qq/memory";

export type {
  ApplyResult,
  MemoryBundle,
  MemoryDoc,
  MemoryDocKind,
  MemoryDocPaths,
  MemoryDocRef,
  MemoryHistoryEntry,
  MemoryOperation,
  MemorySection,
  ParsedDocument,
};

export const USER_SECTIONS = [
  "基本信息",
  "喜好",
  "边界",
  "约定",
  "关系",
  "最近发生",
  "手动记忆",
] as const;

export const SCENE_SECTIONS = ["最近发生", "群友关系", "约定"] as const;

export const MANUAL_SECTION = "手动记忆";

const userKind: MemoryDocKindConfig = {
  title: "用户记忆",
  sections: USER_SECTIONS,
  manualSection: MANUAL_SECTION,
};

const sceneKind: MemoryDocKindConfig = {
  title: "群聊场景",
  sections: SCENE_SECTIONS,
  manualSection: MANUAL_SECTION,
};

/** Roleplay-specific document layout and section policy. */
export const roleplayDocumentConfig: MemoryDocumentConfig = {
  user: userKind,
  scene: sceneKind,
  isShared(scope) {
    return /^group:\d+$/.test(scope);
  },
  paths(root, ref): MemoryDocPaths {
    const baseDir = join(root, safeMemorySegment(ref.namespace), safeMemorySegment(ref.scope));
    if (/^group:\d+$/.test(ref.scope)) {
      return {
        shared: true,
        baseDir,
        historyDir: join(baseDir, "history"),
        userPath: join(baseDir, "users", `${ref.actorQq}.md`),
        scenePath: join(baseDir, "scene.md"),
      };
    }
    return {
      shared: false,
      baseDir,
      historyDir: join(baseDir, "history"),
      userPath: join(baseDir, "memory.md"),
      scenePath: null,
    };
  },
};

export interface RoleplayMemoryDocumentStoreOptions {
  root: string;
  historyLimit?: number;
  now?: () => number;
}

export class MemoryDocumentStore extends BaseMemoryDocumentStore {
  constructor(options: RoleplayMemoryDocumentStoreOptions) {
    super({ ...options, config: roleplayDocumentConfig });
  }
}

export function parseDocument(content: string, kind: MemoryDocKind): ParsedDocument {
  return parseMemoryDocument(content, kind, roleplayDocumentConfig);
}

export function renderDocument(document: ParsedDocument, kind: MemoryDocKind): string {
  return renderMemoryDocument(document, kind, roleplayDocumentConfig);
}

export function applyOperations(
  content: string,
  operations: MemoryOperation[],
  kind: MemoryDocKind,
): ApplyResult {
  return applyMemoryOperations(content, operations, kind, roleplayDocumentConfig);
}

export function normalizeDocument(content: string, kind: MemoryDocKind): string {
  return normalizeMemoryDocument(content, kind, roleplayDocumentConfig);
}

export function docForPrompt(content: string, maxChars: number): string {
  return memoryDocForPrompt(content, maxChars, "user", roleplayDocumentConfig);
}

export function sceneForPrompt(content: string, maxChars: number): string {
  return memorySceneForPrompt(content, maxChars, roleplayDocumentConfig);
}

export function defaultTitle(kind: MemoryDocKind): string {
  return defaultMemoryTitle(kind, roleplayDocumentConfig);
}

export function defaultSections(kind: MemoryDocKind): readonly string[] {
  return defaultMemorySections(kind, roleplayDocumentConfig);
}

export function isAllowedSection(section: string, kind: MemoryDocKind): boolean {
  return isAllowedMemorySection(section, kind, roleplayDocumentConfig);
}
