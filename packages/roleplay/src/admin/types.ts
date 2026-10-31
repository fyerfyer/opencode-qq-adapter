import type { TranscriptStore } from "@opencode-qq/memory";
import type { PluginLogger, PluginMessages } from "@opencode-qq/plugin-sdk";
import type { BindingStore } from "../bindings.js";
import type { JevEmotionJudge } from "../jev.js";
import type { MemoryDocumentStore } from "../memory-document.js";
import type { MemoryService } from "../memory-service.js";
import type { RoleplayOptions } from "../options.js";
import type { PersonaRecord } from "../persona.js";
import type { StickerCatalog } from "../stickers.js";
import type { WorldbookEntry } from "../worldbook.js";

export interface RoleplayAdminDeps {
  options: RoleplayOptions;
  personasDir: string;
  stickerRoot: string;
  memoryRoot: string;
  databasePath: string;
  memory: MemoryService;
  documents: MemoryDocumentStore;
  transcript: TranscriptStore;
  bindings: BindingStore;
  messages: PluginMessages;
  logger: PluginLogger;
  worldbookCache: Map<string, WorldbookEntry[]>;
  stickerCache: Map<string, StickerCatalog>;
  worldbookFor(persona: PersonaRecord): Promise<WorldbookEntry[]>;
  stickerCatalogFor(persona: PersonaRecord | string): Promise<StickerCatalog>;
  jev: JevEmotionJudge | null;
}
