# @opencode-qq/roleplay

Character Card V2/V3 roleplay plugin for `opencode-qq-adapter`. Memory is a human-readable Markdown document per persona/scope, consolidated by a background LLM; raw messages stay in SQLite for FTS and evidence.

## What it does

- Imports Character Card V2/V3 JSON/PNG through `@character-foundry/character-foundry`.
- Stores each persona in a self-contained directory with `AGENTS.md`, card JSON, worldbook, greetings, and user notes.
- Runs OpenCode through a dedicated tool-free `qq-rp` primary agent.
- Injects worldbook matches, the Markdown memory document, and retrieved raw transcript snippets into each turn.
- Consolidates memory in the background through a hidden, tool-free `qq-rp-utility` agent using section-level JSON operations.
- Splits replies into 1-4 QQ bubbles with typing delays.
- Supports private chats, group `per_user`, group `shared`, and group `readonly`.

## Memory model

```text
memory.md                 stable memory for one persona + chat scope + user
scene.md                  shared group scene (shared/readonly groups)
users/<qq>.md             per-member memory inside a shared group
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

## Consolidation trigger

- Every `memory_consolidate_every_turns` user turns (default 8), or
- after `memory_idle_debounce_ms` of no new messages (default 2 minutes), or
- manually with `!memory refresh`.

There is no hardcoded "memorable word" regex. The model sees the current Markdown document + recent conversation and decides what to merge, replace, or delete. If the model returns malformed JSON or the utility run fails, the old document is kept and the job retries later.

## Not in 0.3

- Vector/embedding retrieval and external memory services (mem0/Letta/Memobase).
- Proactive messages, passive group observation, multi-character scenes, TTS.
- A WebUI memory editor.
- Time-aware or alternate greetings.

## Install

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
    policy: roleplay
    workspace: none
    agent: qq-rp
    model: null
    allowed_users: ["10001"]

policies:
  roleplay:
    read: allow
    glob: deny
    grep: deny
    edit: deny
    shell: deny
    webfetch: deny
    websearch: deny
    external_directory: deny

plugins:
  roleplay:
    path: /absolute/path/to/packages/roleplay
    options:
      project_id: roleplay
      agent: qq-rp
      model: null
      # Must match projects.roleplay.path. The default is
      # <storage.plugins_dir>/roleplay/personas, which is only correct when that
      # path is the same as projects.roleplay.path.
      personas_dir: ~/.local/share/opencode-qq/plugins/roleplay/personas
      install_agent: true
      fallback_project: demo
      max_segments: 4
      max_chars_per_segment: 180
      delay_per_char_ms: 28
      max_delay_ms: 2500
      worldbook_scan_depth: 6
      worldbook_max_entries: 4
      worldbook_max_chars: 1200

      memory_enabled: true
      memory_utility_agent: qq-rp-utility
      # null inherits the OpenCode default:
      # memory_utility_model: opencode-go/deepseek-v4.1-flash
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

`install_agent: true` writes two managed agents to `~/.config/opencode/agents/`:

- `qq-rp.md`: the tool-free roleplay engine.
- `qq-rp-utility.md`: the hidden, JSON-only memory consolidator (`hidden: true`, `steps: 1`, all tools denied).

Existing user-owned files are never overwritten. After the first install, reload or restart OpenCode so the agents are visible.

**Set `personas_dir` to exactly the same directory as `projects.roleplay.path`.** If they differ, the core logs `Plugin profile directory escapes the project root; ignoring`, falls back to the project root, and the persona card's `AGENTS.md` is not loaded.

## Use

```text
!card import /path/to/card.png blue-fat-fish
!persona list
!persona use blue-fat-fish
!rp status
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

The plugin follows the core group mode:

| Mode | Memory layout | Who can manage |
| --- | --- | --- |
| `per_user` | `group_<gid>_<uid>/memory.md` per member | the member |
| `shared` | `group_<gid>/scene.md` + `group_<gid>/users/<uid>.md` | owner/admin |
| `readonly` | Same as shared | owner/admin |

- In `shared`/`readonly` groups, `!persona use`, `!rp on/off`, `!forget confirm`, and `!memory` are owner/admin only.
- `!remember` is allowed for every member; it writes to that member's `users/<uid>.md`.
- `!memory` / `!memory search` / `!memory history` / `!memory diff` in a group send details to the member's private chat; the group only gets a short acknowledgement.
- Shared scene memory is shared; per-user documents stay per-user. Owner/admin can view all user documents for moderation.
- `!forget confirm` as owner/admin removes the whole group memory directory and its `memory_events`.

Example group config:

```yaml
groups:
  "30001":
    enabled: true
    mode: per_user # or shared / readonly
    require_mention: true
    allowed_users: ["10001", "10002"]
    projects: ["roleplay"]

projects:
  roleplay:
    # ...
    allowed_groups: ["30001"]
```

## How it works

```text
QQ private/group message
  -> bridge authorization and @bot policy
  -> roleplay profile: directory = personas/<id>
  -> beforePrompt: memory.md + scene.md + raw FTS + worldbook
  -> OpenCode qq-rp session (AGENTS.md is the system baseline)
  -> formatReply: sentence groups + delays
  -> QQ
  -> afterRun: store raw text, schedule consolidation
                 |
                 v
          qq-rp-utility (hidden, tool-free)
            current memory.md/scene.md + recent transcript
            -> section operations JSON
                 |
                 v
          atomic write + history snapshot + memory_events
```

Stable character data lives in `personas/<id>/AGENTS.md`, so it stays at the front of the prompt. Engine rules live only in the `qq-rp` agent prompt; `AGENTS.md` contains the card and user notes, not a duplicated safety footer. Volatile memory is a bounded user-message prefix at the end of the conversation prefix.

The utility call uses the bridge's `context.agent.complete()` plugin API: an ephemeral OpenCode session in the plugin data directory, every tool denied, a timeout, and the session deleted afterwards. It never touches the user's roleplay session.

## Privacy and cost

- Memory documents live under `<storage.plugins_dir>/roleplay/memory/`; the plugin data directory is created with `0700`.
- LLM consolidation sends the current document plus recent conversation text to `memory_utility_model` (or the OpenCode default). Set `memory_enabled: false` to keep memory local and use only `!remember` + raw FTS.
- `memory_events` records action, summary, changed sections, source message id, and timestamps; document versions are kept under `history/`.
- `!forget confirm` deletes the document directory, history, raw messages, and memory events for the scope in one operation.
- Group memory is isolated by ChatKey. `per_user` members never share a scope; `shared` groups share `scene.md` but keep `users/<qq>.md` separate.

## Development

```bash
pnpm --dir packages/roleplay typecheck
pnpm --dir packages/roleplay build
pnpm vitest run tests/unit/roleplay-*.test.ts
```

## License

MIT. Character Card parsing is provided by the MIT-licensed `@character-foundry/character-foundry`. The example persona is original test text; no third-party card text or art is bundled.
