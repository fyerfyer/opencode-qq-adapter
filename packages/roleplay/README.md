# @opencode-qq/roleplay

Character Card V2/V3 roleplay plugin for `opencode-qq-adapter`. The current M1 slice supports private chat, one active persona per chat, raw transcript memory, and segmented QQ replies.

## What it does

- Imports Character Card V2/V3 JSON/PNG through `@character-foundry/character-foundry`.
- Stores each persona in a self-contained directory with `AGENTS.md`, card JSON, worldbook, greetings, and user notes.
- Runs OpenCode through a dedicated tool-free `qq-rp` primary agent.
- Injects worldbook matches and retrieved transcript snippets into each turn.
- Splits replies into 1-4 QQ bubbles with typing delays.
- Keeps raw user and assistant text in SQLite for later retrieval.
- Supports a configurable fallback project when roleplay is turned off.

## Not in M1

- Group passive observation, proactive messages, and multi-character scenes.
- LLM fact/episode extraction and relationship state.
- WebUI, TTS, voice, and image generation.
- A separate OpenCode service for roleplay isolation.
- Time-aware or randomized greetings; M1 uses the card's `first_mes`.

## Install

From the monorepo:

```bash
pnpm install
pnpm build:sdk
pnpm build:roleplay
```

The bridge loads the package from this directory, and `pnpm build` builds it as part of the full build.

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
      install_agent: true
      fallback_project: demo
      max_segments: 4
      max_chars_per_segment: 180
      delay_per_char_ms: 28
      max_delay_ms: 2500
      memory_top_k: 6
      memory_max_chars: 800
      memory_exclude_recent: 10
```

`install_agent: true` writes the fixed engine agent to `~/.config/opencode/agents/qq-rp.md` if it does not exist. An existing user-owned file is never overwritten. Set `install_agent: false` if you want to manage the agent yourself. After the first install, reload or restart OpenCode so the new agent is visible.

The persona root must be inside the configured `projects.roleplay.path`. The bridge validates the profile directory with `realpath` and rejects escapes.

## Use

```text
!card import /path/to/card.png blue-fat-fish
!persona list
!persona use blue-fat-fish
!rp status
!memory
!forget confirm
!rp off
```

`!persona use` switches the chat to the `roleplay` project, resets the OpenCode session, stores the first message, and returns it as the first QQ reply. When there is no previous project, `!rp off` restores `fallback_project` if configured.

A test card is available at `examples/blue-fat-fish.card.json` and `examples/blue-fat-fish.card.png`. It is an original text persona inspired by the public "蓝色大肥鱼 / DeepSeek娘" meme.

## How it works

```text
QQ private message
  -> bridge authorization
  -> roleplay profile: directory = personas/<id>
  -> beforePrompt: worldbook + transcript retrieval
  -> OpenCode qq-rp session (AGENTS.md is the system baseline)
  -> formatReply: sentence groups + delays
  -> QQ
  -> afterRun: store raw user text + assistant reply
```

Stable character data lives in `personas/<id>/AGENTS.md`, so it stays at the front of the prompt. Engine rules live only in the `qq-rp` agent prompt; `AGENTS.md` contains the card and user notes, not a duplicated safety footer. Volatile memory is a bounded user-message prefix. The engine agent has `steps: 1` and denies every tool.

## Memory

M1 stores raw transcript rows and retrieves them with FTS5 trigram. SQLite's trigram tokenizer requires at least three characters, so shorter Chinese queries fall back to `LIKE`. This keeps the first version deterministic and service-free. Fact and episode extraction are planned for a later stage, not M1.

Memory scopes are isolated by private chat or group, and `!forget confirm` deletes the current persona's transcript for that scope. Timestamps in prompts and `!memory` use the bridge host's local time.

## Development

```bash
pnpm --dir packages/roleplay typecheck
pnpm --dir packages/roleplay build
pnpm vitest run tests/unit/roleplay-*.test.ts
```

## License

MIT. Character Card parsing is provided by the MIT-licensed `@character-foundry/character-foundry`. The example persona is original test text; no third-party card text or art is bundled.
