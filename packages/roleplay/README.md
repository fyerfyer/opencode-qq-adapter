# @opencode-qq/roleplay

Character Card V2/V3 roleplay plugin for `opencode-qq-adapter`. Worldbook selection supports one optional recursion pass, per-entry whole-word matching, and a debug command. Replies can append one emotion sticker. Memory is a human-readable Markdown document per persona/scope, consolidated by a background LLM; raw messages stay in SQLite for FTS and evidence. Reusable transcript/document primitives live in `@opencode-qq/memory`; roleplay policy stays here.

## What it does

- Imports Character Card V2/V3 JSON/PNG through `@character-foundry/character-foundry`.
- Stores each persona in a self-contained directory with `AGENTS.md`, card JSON, worldbook, greetings, and user notes.
- Runs OpenCode through the single core `qq-code` Agent configured by `projects.<roleplay>.agent`; the plugin never installs or selects an Agent/model.
- Injects worldbook matches, the Markdown memory document, and retrieved raw transcript snippets into each turn.
- Supports worldbook lite: keyword/secondary-key/constant activation, one optional recursion pass, ASCII whole-word matching, and `!worldbook check <text>`.
- Extracts CCv3 `emotion` assets (or manual `stickers/<emotion>/` files) and appends at most one sticker per reply.
- Uses Jev (System One decision model) to choose an emotion from the visible reply, with confidence/sticker-ok thresholds.
- Consolidates memory in the background through the core Agent (`opencode.default_agent`, fallback `qq-code`) in a tool-free ephemeral session using section-level JSON operations.
- Splits replies into 1-4 QQ bubbles with typing delays.
- Supports private chats and zero-config group chats (one independent conversation per member).
- Ships an iframe admin WebUI (`/admin/plugins/roleplay`) for cards, worldbook editing, stickers, Markdown memory, bindings and plugin options.

## Worldbook lite+

The plugin reads Character Book entries with `keys`, `secondary_keys`, `constant`, `selective`, `case_sensitive`, `priority`, `insertion_order`, and `position`.

```text
worldbook_recursion_steps: 1   # extra passes; 0 disables; 1 = selected content triggers one more scan
worldbook_match_whole_words: false
```

- Constants are selected first, then priority / insertion order.
- Recursion only uses **selected** entry content and shares the same `maxEntries` / `maxChars` budget. It stops when a pass adds nothing.
- `match_whole_words` is read per entry (`extensions.match_whole_words`). ASCII word keys use ASCII word boundaries; multi-word and CJK/mixed keys stay substring. This is intentionally not exact SillyTavern compatibility.
- `position` only controls ordering: `before_char` goes before memory, `after_char` after memory. The character card still lives in `AGENTS.md`, so the plugin cannot truly insert before/after character definitions.
- `!worldbook check <text>` prints matched keys, the source (current message / recent message / recursive entry), selected entries, and budget drops.

## Stickers

Emotion tags are optional and stripped before QQ delivery and memory storage:

```text
（把饭碗搂紧）……就半碗。[emotion:shy]
```

Assets live under the plugin data directory:

```text
<storage.plugins_dir>/roleplay/stickers/
  <persona-id>/
    happy/1.gif
    shy/1.gif
  _global/
    happy/1.gif
```

- CCv3 `assets` with `type: "emotion"` are copied during `!card import`.
- A persona emotion overrides the `_global` fallback for that emotion.
- One sticker per reply, random selection, avoiding the same file consecutively for the same chat/persona.
- Missing asset: the tag is removed and the text is sent normally.
- Empty text with no asset: the reply is suppressed.
- `sticker_enabled: false` disables selection but still strips tags.

### Jev emotion judge

The model tag is optional. For reliable automatic stickers, set `sticker_judge: jev`: the plugin sends only the current user message and the visible character reply to a Jev-style decision endpoint, asks one `Choice` question (`emotion`, including `none`) and one `Noul` question (`sticker_ok`), then thresholds `confidence` and `sticker_ok`.

```yaml
sticker_judge: jev          # off | tag | jev | hybrid
sticker_cooldown_ms: 30000  # minimum gap between automatic stickers; 0 disables
jev_base_url: https://api.typesafe.ai/v1
jev_endpoint: systemone     # decisions for OpenRouter/compatible relays
jev_model: jev-latest
jev_api_key_env: TYPESAFE_API_KEY
jev_min_confidence: 0.45
jev_min_sticker_ok: 0.8
jev_timeout_ms: 2500
```

- `jev` is Jev-led; a model tag is ignored. If the key is missing, the plugin falls back to a valid model tag; if Jev fails or confidence is low, it sends text only.
- `sticker_cooldown_ms` limits automatic stickers to at most one per window; `0` disables the cooldown. `!sticker test` bypasses it.
- `hybrid` tries a valid tag first, then Jev.
- `tag` keeps the original tag-only behavior; `off` disables stickers but still strips tags.
- The key is read from the environment variable named by `jev_api_key_env`; never put it in YAML. The Roleplay WebUI settings tab can write this `.env` key (write-only field) and has a **Test connection** button that performs one real Jev request and reports latency/confidence.
- Only the current user message and visible assistant reply are sent (no system prompt, memory, or worldbook). `jev_timeout_ms` is kept under the core 4s reply-hook budget; failures degrade to text.
- Jev input is roughly 600-700 tokens per turn for this prompt; output tokens are free on Jev. Check your provider's current pricing and data policy.
- For OpenRouter/compatible relays, use e.g. `jev_base_url: https://openrouter.ai/api`, `jev_endpoint: alpha/decisions`, `jev_model: typesafe/jev-1.14`, and an `OPENROUTER_API_KEY` env var.

## Memory model

```text
memory.md                 stable memory for one persona + chat scope + user
scene.md                  legacy shared-group scene (not used by the current core)
users/<qq>.md             legacy per-member memory inside a shared group
history/*.md              previous document versions
memory_events (SQLite)    audit: consolidate / manual_add / manual_delete
messages (SQLite)         raw transcript + FTS5 trigram retrieval
```

User documents use these sections:

```md
# 用户记忆

## 基本信息
## 喜好
## 边界
## 约定
## 关系
## 最近发生
## 手动记忆
```

- `手动记忆` is written only by `!remember`; the LLM is not allowed to edit it.
- The LLM returns **section operations**, not a free-form rewrite:

```json
{
  "user_operations": [
    { "op": "upsert", "section": "喜好", "content": "- 喜欢吃白米饭\n- 讨厌香菜", "reason": "合并偏好" },
    { "op": "delete_line", "section": "约定", "match": "旧的下周三考试", "reason": "已过期" }
  ],
  "scene_operations": [],
  "summary": "合并香菜偏好，删除过期约定"
}
```

- `upsert` replaces a section, `append` adds lines, `delete_line` removes lines containing `match`, and `delete_section` removes an outdated section.
- The code validates section names and lengths, protects `手动记忆`, writes atomically (temp file + rename), and keeps the last `memory_history_limit` versions.
- Raw messages are searched with an exact-phrase pass, then CJK overlapping trigrams, then `LIKE` for short queries. FTS5 is keyword/trigram retrieval; vector search is intentionally not enabled yet.
- `sqlite-vec` can be added later as an optional retrieval backend if keyword recall proves insufficient.
- Worldbook recursion is limited to the plugin's small lite model; sticky/cooldown/delay/probability/minActivations/group/regex/depth are intentionally not implemented yet.

## Consolidation trigger

- Every `memory_consolidate_every_turns` user turns (default 8), or
- after `memory_idle_debounce_ms` of no new messages (default 2 minutes), or
- manually with `!memory refresh`.

There is no hardcoded "memorable word" regex. The model sees the current Markdown document + recent conversation and decides what to merge, replace, or delete. If the model returns malformed JSON or the utility run fails, the old document is kept and the job retries later.

## Not in 0.3

- Vector/embedding retrieval and external memory services (mem0/Letta/Memobase).
- Proactive messages, passive group observation, multi-character scenes, TTS.
- Time-aware or alternate greetings.

## Install

With the setup wizard (recommended):

```bash
opencode-qq setup --with-roleplay \
  --roleplay-path /path/to/opencode-qq-adapter/packages/roleplay \
  --roleplay-personas ~/.local/share/opencode-qq/plugins/roleplay/personas \
  --yes
```

From the monorepo:

```bash
pnpm install
pnpm build:sdk
pnpm build:roleplay
```

### Configure the bridge

Create the persona root first so config validation can see it:

```bash
mkdir -p ~/.local/share/opencode-qq/plugins/roleplay/personas
```

If your config sets `security.allowed_roots`, include the persona root's parent, for example `~/.local/share/opencode-qq`.

Merge this into `config.yaml`; the repository also contains `config/roleplay.example.yaml`:

```yaml
projects:
  roleplay:
    path: ~/.local/share/opencode-qq/plugins/roleplay/personas
    description: Roleplay personas
    workspace: none
    # The org-wide core Agent. Model comes from its frontmatter (`model:`),
    # edited on the core Agents page; keep model: null here.
    agent: qq-code
    model: null
    hidden: true
    managed_by: roleplay

plugins:
  roleplay:
    path: /absolute/path/to/packages/roleplay
    options:
      project_id: roleplay
      # The plugin injects roleplay instructions, persona context, worldbook,
      # memory and reply formatting. It never installs or selects an Agent or
      # model. Configure qq-code and its frontmatter model on the core Agents
      # page (/agents?name=qq-code.md).
      # Must match projects.roleplay.path. The default is
      # <storage.plugins_dir>/roleplay/personas, which is only correct when that
      # path is the same as projects.roleplay.path.
      personas_dir: ~/.local/share/opencode-qq/plugins/roleplay/personas
      fallback_project: demo
      max_segments: 4
      max_chars_per_segment: 180
      delay_per_char_ms: 28
      max_delay_ms: 2500
      worldbook_scan_depth: 6
      worldbook_max_entries: 4
      worldbook_max_chars: 1200
      worldbook_recursion_steps: 1
      worldbook_match_whole_words: false

      sticker_enabled: true
      sticker_delay_ms: 600
      sticker_cooldown_ms: 30000
      sticker_judge: jev
      jev_base_url: https://api.typesafe.ai/v1
      jev_endpoint: systemone
      jev_model: jev-latest
      jev_api_key_env: TYPESAFE_API_KEY
      jev_min_confidence: 0.45
      jev_min_sticker_ok: 0.8
      jev_timeout_ms: 2500

      memory_enabled: true
      # Consolidation uses the core Agent (opencode.default_agent, fallback
      # qq-code) in a tool-free ephemeral session. The plugin cannot set a model.
      memory_utility_timeout_ms: 90000
      memory_consolidate_every_turns: 8
      memory_idle_debounce_ms: 120000
      memory_user_max_chars: 1200
      memory_scene_max_chars: 800
      memory_raw_top_k: 6
      memory_raw_max_chars: 600
      memory_max_chars: 2400
      memory_exclude_recent: 10
      memory_history_limit: 20
      memory_refresh_cooldown_ms: 60000
```

The plugin no longer installs or owns `qq-rp`/`qq-rp-utility` Agent files, and it has no `agent`, `memory_utility_agent` or `install_agent` options. Every roleplay turn uses `projects.roleplay.agent` (setup writes `qq-code`); the model comes from that Agent's frontmatter. Edit the single Agent and its model on the core **Agents** page (`/agents?name=qq-code.md`). Roleplay behaviour rules are injected by the plugin as a prompt prefix, while persona cards and memory remain in the Roleplay page.

**Set `personas_dir` to exactly the same directory as `projects.roleplay.path`.** If they differ, the core logs `Plugin profile directory escapes the project root; ignoring`, falls back to the project root, and the persona card's `AGENTS.md` is not loaded.

## WebUI

The bridge mounts the plugin admin API at `/admin/api/plugins/roleplay/*` and an iframe page at `/admin/plugins/roleplay` (legacy `/admin/roleplay` redirects):

- Overview: persona/sticker/memory/binding counts, Jev/path diagnostics.
- Personas: drag-and-drop CCv2/V3 import, card preview, notes (`notes.md` → `AGENTS.md`), worldbook add/edit/delete/enable and keyword trace, per-persona memory/bindings.
- Stickers: per-persona/`_global` grid, multi-upload with magic-byte + SHA-256 dedupe, WebP thumbnails via `sharp`, emotion rename/delete, preview and a test send to a bound QQ chat.
- Memory: scope tree, Markdown editor/preview, protected `手动记忆`, history diff/restore, raw FTS search, background refresh jobs and scope purge.
- Bindings: enable/disable/delete chat → persona bindings.
- Settings: structured YAML-backed options; saves validate, back up, atomically replace and hot-reload. Secrets only show configured/missing.

The page is built into `packages/roleplay/ui` and talks to the core through `@opencode-qq/plugin-ui`: a sandboxed iframe with no cookies or `localStorage`, a MessageChannel bridge, and parent-brokered admin API calls. Images are fetched as blobs through the same bridge.

All routes inherit the core admin session, CSRF, loopback restriction and audit. Plugin data stays under `storage.plugins_dir/roleplay`; the core never reads the plugin tables directly.

All QQ runs use the single core `qq-code` Agent. The Roleplay settings page links directly to its Agents-page entry for model configuration; the plugin does not create, own or override Agent files. Persona content, notes, worldbook and memory stay in the Roleplay page.

## Use

```text
!card import /path/to/card.png blue-fat-fish
!persona list
!persona use blue-fat-fish
!rp status
!worldbook check Bessie 提到了 Rufus
!sticker list
!sticker test happy
!remember 我不喜欢吃香菜
!memory
!memory diff
!memory history
!memory search 香菜
!memory refresh
!forget section 喜好
!forget confirm
!rp off
```

`!persona use` switches the chat to the `roleplay` project, resets the OpenCode session, stores the first message, and returns it as the first QQ reply. When there is no previous project, `!rp off` restores `fallback_project` if configured.

## Group chats

## Groups

The core bridge no longer has group configuration. Every authorized QQ gets an independent conversation in private chats and in any group, so roleplay memory is isolated per member:

| Context | Memory layout | Who can manage |
| --- | --- | --- |
| private | `private_<qq>/memory.md` | the user |
| group | `group_<gid>_<uid>/memory.md` per member | the member |

- `!persona use`, `!rp on/off`, `!forget confirm`, and `!memory` are available to the member in their own conversation.
- `!memory` / `!memory search` / `!memory history` / `!memory diff` in a group send details to the member's private chat; the group only gets a short acknowledgement.
- Legacy `shared` / `readonly` branches remain in the plugin code for tests and future use, but the current bridge never selects them.

Example: no group config is needed. Ensure the QQ is in `config.yaml` under `users` and has access to at least one visible project.

```yaml
users:
  "10001":
    role: owner
    projects: ["*"]
    write_projects: ["*"]
```

## How it works

```text
QQ private/group message
  -> bridge authorization and @bot policy
  -> roleplay profile: directory = personas/<id>
  -> beforePrompt: roleplay mode rules + memory.md + scene.md + raw FTS + worldbook + available emotions
  -> OpenCode qq-code session (AGENTS.md is the system baseline)
  -> formatReply: strip [emotion:xxx], sentence groups + delays + optional sticker
  -> QQ
  -> afterRun: store raw text, schedule consolidation
                 |
                 v
          core Agent utility session (tool-free, ephemeral)
            current memory.md/scene.md + recent transcript
            -> section operations JSON
                 |
                 v
          atomic write + history snapshot + memory_events
```

Stable character data lives in `personas/<id>/AGENTS.md`, so it stays at the front of the prompt. Roleplay mode rules are injected by the plugin in `beforePrompt`; `AGENTS.md` contains the card and user notes, not a duplicated safety footer. Volatile memory is a bounded user-message prefix near the end of the prompt prefix.

The utility call uses the bridge's `context.agent.complete()` plugin API: an ephemeral OpenCode session in the plugin data directory using `opencode.default_agent` (fallback `qq-code`), every tool denied, a timeout, and the session deleted afterwards. Plugins cannot supply an Agent or model. It never touches the user's roleplay session.

The generic SQLite/Markdown/retrieval primitives are in `@opencode-qq/memory`. This plugin supplies the persona/scope mapping, RP section schema, consolidation prompt, commands, and sticker semantics. It is a project-level component, not a core runtime dependency; if a second consumer appears, the package can be promoted to a core `context.memory` API without putting RP vocabulary into `src/`.

## Privacy and cost

- Memory documents live under `<storage.plugins_dir>/roleplay/memory/`; the plugin data directory is created with `0700`.
- LLM consolidation sends the current document plus recent conversation text to the core Agent (`opencode.default_agent`, fallback `qq-code`); that Agent's frontmatter `model:` selects the model. Set `memory_enabled: false` to keep memory local and use only `!remember` + raw FTS.
- `memory_events` records action, summary, changed sections, source message id, and timestamps; document versions are kept under `history/`.
- `!forget confirm` deletes the document directory, history, raw messages, and memory events for the scope in one operation.
- Group memory is isolated by ChatKey. Every member has an independent `group_<gid>_<uid>/memory.md`; the core bridge does not expose shared group memory.

## Development

```bash
pnpm --dir packages/roleplay typecheck
pnpm --dir packages/roleplay build
pnpm vitest run tests/unit/roleplay-*.test.ts
```

## License

MIT. Character Card parsing is provided by the MIT-licensed `@character-foundry/character-foundry`. The example persona is original test text; no third-party card text or art is bundled.
