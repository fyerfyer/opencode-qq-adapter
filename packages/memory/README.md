# @opencode-qq/memory

Reusable memory primitives for `opencode-qq-adapter` plugins:

- `TranscriptStore`: SQLite messages, FTS5 retrieval, and memory-change events.
- `MemoryDocumentStore`: atomic Markdown documents with section operations, manual sections, and bounded history.
- Retrieval helpers: exact phrase, CJK trigram OR, and LIKE fallback.

The package deliberately does **not** know about personas, roleplay sections, QQ chat keys, or LLM prompts. A plugin or core component supplies a `namespace`/`scope` pair and a `MemoryDocumentConfig` describing document layout and sections.

```ts
import { MemoryDocumentStore, TranscriptStore } from "@opencode-qq/memory";

const transcript = new TranscriptStore("memory.db");
transcript.addMessage({
  namespace: "persona-1",
  chatKey: "private:10001",
  scope: "private:10001",
  role: "user",
  speaker: "鱼片",
  text: "我喜欢白米饭",
  ts: Date.now(),
});
```

Roleplay policy lives in `@opencode-qq/roleplay`:

- persona -> namespace;
- ChatKey -> scope;
- `memory.md` / `scene.md` / `users/<qq>.md`;
- RP section names and consolidation prompt.

This split keeps core memory infrastructure reusable without putting roleplay vocabulary into the bridge core.
