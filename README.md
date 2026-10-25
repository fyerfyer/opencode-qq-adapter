# OpenCode QQ Adapter

通过 [NapCat](https://napneko.github.io/) / OneBot 11，把本机的 [OpenCode](https://opencode.ai/) 接入 QQ 私聊和群聊。你可以在 QQ 里让 coding agent 读写项目、执行命令、查看 diff、收发图片，并通过 QQ 审批危险操作。

```text
QQ 客户端
   │
   ▼
NapCat（OneBot 11 WebSocket）
   │
   ▼
opencode-qq-adapter（本项目，独立 Node 进程）
   │  HTTP / SSE
   ▼
OpenCode V2 service
   │
   ▼
项目目录 / shell / git / workspace
```

> `src/` 是 bridge 本体。`plugin/` 只是可选的 OpenCode 侧小插件，用来让 agent 主动把图片发回 QQ，不是整个应用的打包形式。

## 功能

- QQ 私聊 / 群聊中使用 OpenCode。
- 项目切换、会话新建/恢复、运行中断、队列管理。
- YAML 定义用户、群、项目、权限策略和预算。
- 危险操作通过 QQ 审批：允许一次 / 本会话总是允许 / 拒绝。
- 入站图片：QQ 发图，agent 能看图。
- 出站图片/文件：agent 调用 `qq_send_image` / `qq_send_file` 把 workspace 内媒体发回 QQ。
- shared workspace 锁：同一项目跨 QQ 会话串行执行；bridge 重启后自动恢复遗留锁。
- 群聊 `per_user` / `shared` / `readonly` 模式、@bot、群 allowlist。
- owner TOTP 2FA、每日预算/限流、owner 告警。
- SQLite 持久化会话、运行、审批、工作区、用量和审计。
- 本机 WebUI：登录、状态、用户/群/项目/策略、会话、Prompt、插件、审计、用量和 YAML 编辑。
- QQ 侧插件 SDK：命令、prompt/run hooks、事件、独立数据目录、文本/图片/文件发送。
- 可选 Roleplay 插件：Character Card V2/V3、私聊人设、世界书、原文记忆和分段延迟回复。
- `/health` 健康检查、JSON 日志和密钥脱敏。

## 前置条件

- Node.js >= 22.11
- pnpm >= 10
- 一个可登录的 QQ 小号
- NapCat（推荐 Docker Compose）
- 本机 OpenCode V2 service
- 一个支持工具调用（需要发图时还需要 vision）的模型

## 安装（npm 推荐）

需要 Node.js >= 22.11，以及已经安装并配置好的 [OpenCode](https://opencode.ai/)。

```bash
npm install -g opencode-qq-adapter
opencode-qq setup
```

向导会完成这些事：

- 写入 `~/.config/opencode-qq/config.yaml`
- 写入 `~/.config/opencode-qq/.env`（权限 `0600`）
- 生成 NapCat access token 和 bridge internal token
- 安装 `qq_send_image` 插件到 `~/.config/opencode/plugins/`
- 写入 `~/.config/opencode/qq-bridge.json`
- 可选：生成并启动一个隔离的 NapCat Docker 容器，自动写入 `onebot11.json`
- 跑一遍本地配置校验

### setup 的三种 NapCat 模式

| 模式 | 说明 |
| --- | --- |
| `docker` | 生成 `napcat-compose.yaml`，启动 `opencode-qq-napcat`，自动配置 WS 端口和 token |
| `existing` | 使用已经运行的 NapCat，只填写 WS 地址和 token |
| `skip` | 只写 bridge 配置，稍后手动配置 NapCat |

非交互示例：

```bash
opencode-qq setup \
  --owner-qq 123456789 \
  --project demo=/home/me/code/blog \
  --napcat docker \
  --yes
```

常用参数：

```text
--config <path>       指定配置文件
--data-dir <path>     指定数据目录
--owner-qq <qq>       owner QQ
--project <id=path>   项目，可重复
--napcat docker|existing|skip
--agent qq-code      创建/更新独立的 qq-code agent（推荐）
--agent default      使用 OpenCode 默认 agent
--agent <existing>   使用已有的 OpenCode agent ID
--napcat-url <url>    已有 NapCat 的 WS 地址
--napcat-token <tok>  NapCat access token
--admin-password <p>  首次 /admin 登录密码（默认自动生成）
--yes                 非交互
--force               覆盖已有配置（会先备份）
--skip-plugin         不安装 OpenCode 插件
```

如果 `npx` 报 `Could not locate the bindings file` 或 `better_sqlite3.node`，通常是 npx 缓存里跳过了原生模块安装：

```bash
npm cache clean --force
npm install -g opencode-qq-adapter
opencode-qq setup
```

`npx` 也不适合长期运行 bridge：它可能每次重新安装依赖，并卡在 npm audit 网络请求。推荐先全局安装或直接使用源码：

```bash
# 从本地 tarball 安装
npm install -g ./opencode-qq-adapter-0.1.1.tgz
opencode-qq start

# 或在源码目录
pnpm build
pnpm start
```

如果只是临时用 npx 调试，可以关闭 audit/fund：

```bash
npm_config_audit=false npm_config_fund=false \
  npx -y -p ./opencode-qq-adapter-0.1.1.tgz opencode-qq start
```

### OpenCode agent

OpenCode V2 支持全局 Markdown agent。`setup` 默认会创建：

```text
~/.config/opencode/agents/qq-code.md
```

它包含：

- `mode: primary`
- QQ 场景的简洁回复提示
- `external_directory`、`.env`、`sudo` 的额外禁止规则
- 通过 `qq_send_image` 发图的提示

如果不想创建独立 agent：

```bash
opencode-qq setup --agent default          # 使用 OpenCode 默认 agent
opencode-qq setup --agent build            # 使用已有的 build agent
```

也可以使用任意已有 agent ID。创建 agent 后需要重启 OpenCode service：

```bash
opencode service restart
```

Docker 模式只绑定 `127.0.0.1`，不会暴露到公网。扫码登录仍然需要手动完成：

```bash
docker logs -f opencode-qq-napcat
```

打开日志里的 WebUI 地址扫码。登录态保存在 `~/.local/share/opencode-qq/napcat/qq`，不要删除。

### 启动 OpenCode 和 bridge

```bash
opencode serve --service
# 如果 OpenCode 已经在运行，重启一次让 qq_send_image 插件生效：
# opencode service restart
opencode-qq start
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health | jq
```

状态含义：

- `ok`：OneBot 和 OpenCode 都正常
- `degraded`：OneBot 未连接或 OpenCode 不可用，HTTP 仍返回 200
- `error`：数据库异常，返回 503

### 在 QQ 中验证

私聊机器人：

```text
!ping
!whoami
!projects
!use demo
请只回复：hello
!status
!model list
!sessions
!stop
```

审批演示：

```text
请使用 shell 工具执行 `echo hello`，然后回复命令输出。
```

随后在 QQ 回复 `1`、`2` 或 `3`。

图片入站：

```text
这张图片是什么颜色？
```

图片出站（需要插件）：

```text
请用 qq_send_image 把 chart.png 发给我，并附一句说明。
```

## WebUI

bridge 启动后，本机打开：

```text
http://127.0.0.1:8787/admin
```

管理台默认只监听 loopback，使用单管理员密码登录。`opencode-qq setup` 会生成一个首次登录密码，写入权限 `0600` 的 `.env` 并打印在 setup 摘要里；bridge 第一次启动时用它创建管理员。没有走 setup 时，首次启动会生成随机密码并打印到 bridge 日志。如果错过了：

```bash
opencode-qq admin reset-password -c ~/.config/opencode-qq/config.yaml
```

也可以用 `OPENCODE_QQ_ADMIN_PASSWORD`（或 `setup --admin-password`）在**首次**创建管理员时指定密码；账号已存在后该变量不再生效。

管理台提供：

- 概览：OneBot / OpenCode / SQLite / 事件流状态、活跃 run、今日用量、待审批和审计。
- 用户与群：角色、项目 allowlist、群模式、@bot、默认项目和可收紧的个人限制。
- 项目与策略：项目路径、默认策略、agent/model、workspace 模式，以及 permission/shell 规则。
- 会话：QQ chat ↔ OpenCode session 绑定、中断、解绑、切换和删除项目 session。
- Prompt：编辑 OpenCode 全局 `agents/*.md`，保存前自动备份，可预览/恢复历史版本。
- 配置：直接编辑 YAML；保存时执行 zod + 路径校验、备份、原子替换和热加载。
- 审计 / 用量：事件明细和按天 token / cost 汇总。
- 插件：查看加载状态、命令、能力、数据来源和失败原因；插件代码仍只从 YAML 启用。

安全边界：

- 默认 `admin.allow_remote: false`，非 loopback 请求会被拒绝。
- 管理员密码用 scrypt 哈希存入 SQLite；浏览器只保留 HttpOnly session cookie。
- 所有写操作要求 CSRF token 和同源 Origin 校验。
- WebUI 不编辑 `.env`；密钥仍通过环境变量注入。
- 如果确实需要局域网访问，请显式开启 `admin.allow_remote`，并放在 TLS 反向代理后。

```yaml
admin:
  enabled: true
  allow_remote: false
  trust_proxy: false
  session_hours: 12
  login_attempts: 5
```

## 从源码开发

```bash
git clone <repo-url> opencode-qq-adapter
cd opencode-qq-adapter
pnpm install
cp .env.example .env
cp config/config.example.yaml config/config.yaml
pnpm setup -- --force
pnpm dev
```

管理前端是 `packages/webui` 下的 Vite + React + shadcn/ui SPA：

```bash
pnpm dev:webui       # http://127.0.0.1:5173/admin/，/admin/api 代理到 8787
pnpm build:webui     # 构建到 dist/admin，由 bridge 的 Hono 托管
pnpm build           # tsc + build:webui
```

`pnpm dev` 不会自动重建前端；改前端时同时开 `pnpm dev:webui`，或者改完后执行一次 `pnpm build:webui` 再刷新 `http://127.0.0.1:8787/admin`。

`pnpm setup` 使用仓库内的 `config/config.yaml`，方便开发时直接修改。也可以手动编辑：

```dotenv
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=change-me
QQ_BRIDGE_INTERNAL_TOKEN=change-me-too
```

`config.yaml` 里的相对路径按配置文件所在目录解析；密钥只放 `.env`，不要写进 YAML。

本地 NapCat：

```bash
docker compose up -d
docker logs -f opencode-qq-napcat
```

默认端口：

| 端口 | 用途 |
| --- | --- |
| `6099` | NapCat WebUI |
| `3001` | NapCat 正向 WebSocket（bridge 连接） |
| `8787` | bridge health / internal HTTP / `/admin` WebUI |

生产构建：

```bash
pnpm build
pnpm start
```

## QQ 插件 SDK

项目有两类“插件”，不要混淆：

- **OpenCode 插件**（`plugin/`）：运行在 OpenCode 进程里，只负责 `qq_send_image` / `qq_send_file`。
- **QQ 插件**（本文）：运行在 bridge 进程里，用来注册 QQ 命令、注入 prompt 上下文、监听 run 完成、发送媒体和保存插件数据。

QQ 插件只从 YAML 显式加载，是可信代码，没有沙箱：

```yaml
plugins:
  hello:
    path: ../examples/hello-plugin
    options:
      greeting: "你好"
      injectContext: false
  notes:
    path: ../examples/notes-plugin
    options:
      maxNotes: 50
```

`path` 相对于配置文件解析；也可以用 `package: "@scope/plugin"` 从 npm 包加载。配置 key 必须与插件 manifest 的 `opencodeQq.id` 一致。插件数据默认位于 `storage.plugins_dir/<plugin-id>/`。

插件可以声明并使用这些能力：

| 能力 | 用途 |
| --- | --- |
| `commands` | 注册 `!command`，核心统一做用户/角色/群模式检查 |
| `hooks` | `beforePrompt`、`afterRun`、`onConfigReload` |
| `messages` | 发送文本、图片、文件（受数据目录和大小限制） |
| `sessions` | 只读查看当前会话绑定 |
| `events` | 订阅 `run.finished` / `config.reloaded` |
| `admin` | 预留：插件管理页面 |

最小示例：

```ts
import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "hello",
        description: "插件连通性示例",
        handler: (command) => `你好，${command.message.senderName}`,
      }),
    );
    context.hooks.register({
      beforePrompt: (prompt) => ({ append: `[project=${prompt.projectId}]` }),
    });
  },
});
```

加载后：

```text
!plugins        # 查看插件状态、命令和失败原因
!hello
!note add ...   # notes 示例插件
!sticker        # media-demo 示例插件发送图片
```

示例位于 [`examples/`](examples)，SDK 源码和文档位于 [`packages/plugin-sdk`](packages/plugin-sdk)。开发流程：

```bash
pnpm install
pnpm build:sdk
pnpm typecheck:examples
pnpm test
```

插件加载失败只会标记该插件为 `failed`，不会影响核心和其它插件；发送 `!plugins` 或打开 `/admin` 的“插件”页可以查看错误。

## Roleplay（实验）

`packages/roleplay` 提供角色扮演：导入 Character Card V2/V3、按角色目录运行 OpenCode、注入世界书与 Markdown 长期记忆、把回复拆成多条短消息并加打字延迟。

当前 0.3 能力：

- 私聊 + 群聊 `per_user` / `shared` / `readonly`；私聊一个 chat 一个角色，`per_user` 群每个成员各自绑定，`shared` 群由 owner/admin 管理；
- 长期记忆是一份可读、可手改的 `memory.md`（shared 群为 `scene.md` + 每人 `users/<qq>.md`），原文保存在 SQLite 供 FTS5 检索；
- 后台 consolidation：隐藏的 `qq-rp-utility` 临时 session，工具全 deny，按 section 级 JSON 操作更新 MD；
- `memory_events` 记录每次 consolidate/manual_add/manual_delete，`history/` 保留最近版本；
- 触发条件是每 N 轮或 idle debounce，不再使用硬编码的“记忆关键词”正则；
- `!remember` 写入手动记忆，`!memory diff|history|search|refresh`，`!forget section|confirm`；
- 中文原文检索使用 FTS5 trigram OR 查询 + 短查询 LIKE 回退；
- 群聊记忆详情私聊发送；`shared` 群仅 owner/admin 可查看/清空。

仍不在本阶段：

- 主动消息、群聊旁听、多角色同场、WebUI 记忆编辑器、TTS、表情包管线；
- 向量/embedding 检索和外部记忆服务；
- 时间段开场白、备选开场白轮换。

配置片段见 [`config/roleplay.example.yaml`](config/roleplay.example.yaml)，完整说明见 [`packages/roleplay/README.md`](packages/roleplay/README.md)。

```bash
pnpm build:sdk
pnpm build:roleplay
mkdir -p ~/.local/share/opencode-qq/plugins/roleplay/personas
```

在 `config.yaml` 中增加 `projects.roleplay`、`policies.roleplay` 和 `plugins.roleplay` 后：

```text
!card import /path/to/card.png blue-fat-fish
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

`install_agent` 默认写入两个 agent：`~/.config/opencode/agents/qq-rp.md`（角色引擎）和 `qq-rp-utility.md`（隐藏的 JSON 记忆整理器）。已有用户文件不会被覆盖。首次安装后需要重启或 reload OpenCode 才能看到新 agent。角色卡会被渲染到 `<persona>/AGENTS.md`，作为稳定的人格前缀。

`memory_enabled: false` 可关闭后台 LLM consolidation，只保留手动 `!remember` 和原文检索；consolidation 会把当前 MD + 最近对话发送给你配置的模型，详情和隐私说明见角色扮演 README。

注意：插件选项里的 `personas_dir` 必须与 `projects.roleplay.path` 完全一致。两者不一致时，核心会拒绝角色目录（`Plugin profile directory escapes the project root`），bot 会退回项目根目录运行，角色卡的 `AGENTS.md` 不会生效。

## OpenCode 图片插件安装

`opencode-qq setup` 会自动安装 V2 插件。手动安装方式：

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf "$(pwd)/plugin/opencode-qq-plugin.ts" \
  ~/.config/opencode/plugins/opencode-qq-plugin.ts
```

`setup` 还会写入 `~/.config/opencode/qq-bridge.json`，这样即使 OpenCode 由 TUI 自动拉起、没有继承 shell 环境，插件也能找到 bridge。

确认插件已加载：

```bash
opencode plugin list
```

如果 `qq_send_image` 返回 `unauthorized`，检查 `~/.config/opencode/qq-bridge.json` 的 `token` 是否与 bridge **解析后**的 `server.internal_token` 一致（通常就是 `.env` 里的 `QQ_BRIDGE_INTERNAL_TOKEN`）。插件每次调用都会重新读取该文件，修改后不需要重启 OpenCode。

OpenCode 1.x 请使用 `plugin/v1-opencode-qq-plugin.ts`，详见 [`plugin/README.md`](plugin/README.md)。

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `!ping` | 返回 `pong` |
| `!help` | 命令帮助（按会话 / 项目 / 模型 / 管理分组） |
| `!whoami` | 显示 QQ、角色、群号、chatKey、可用项目 |
| `!projects` | 列出可用项目 |
| `!use <项目>` / `!cd <项目>` | 切换项目并重置会话 |
| `!new` | 清除当前会话，保留模型/agent 偏好 |
| `!status` | OneBot / OpenCode / 项目 / 工作区锁 / 会话 / 运行状态 |
| `!sessions` | 列出当前项目最近 20 个 OpenCode 会话 |
| `!switch <ID前缀>` | 恢复指定会话（shared 群仅 owner/admin） |
| `!diff` | 当前会话 diff + 工作区 git 改动摘要 |
| `!ws` | 当前工作区、锁持有者和租约 |
| `!ws list` | 列出可用工作区及状态 |
| `!ws clean` | 释放过期租约（owner；启用 2FA 时需先 `!sudo`） |
| `!stop` | 中断当前 run，清空排队任务 |
| `!model` | 查看当前模型 |
| `!model list [provider]` | 列出可用模型 |
| `!model <provider/model[#variant]>` | 切换当前会话模型 |
| `!agent` | 查看当前 agent |
| `!agent list` | 列出 primary agents |
| `!agent <ID>` | 切换当前会话 agent |
| `!reload` | 热加载配置（owner，仅私聊） |
| `!plugins` | 查看已加载插件的状态、命令和错误 |
| `!sudo <TOTP>` | 为 owner 危险操作开启短窗口（仅私聊） |
| `!approvals` | 查看当前会话待审批请求 |
| `!approve <id> once\|always\|reject` | 处理审批 |
| `!reject <id>` | 拒绝审批 |
| `!audit N` | 查看最近 N 条审计记录（owner/admin） |

普通文本会作为 prompt 发送给 OpenCode。最终回答会做 Markdown 降级和长消息分段；群里默认 @ 发起人并引用原消息。默认只发送最终回答；如需长任务占位提示，可启用 `qq.progress_ack`。

## 图片与文件

### 入站图片

```text
QQ 发图
  → NapCat
  → bridge 下载并校验
  → 保存到 storage.inbox_dir
  → session.prompt({ files: [file://...] })
  → OpenCode 模型看图
```

支持 PNG / JPEG / GIF / WebP，默认：

- 每条消息最多 4 张
- 单张最大 10 MB
- inbox 保留 24 小时
- 默认拒绝 loopback / 私有地址的图片 URL（SSRF 防护）

### 出站图片

```text
agent 调用 qq_send_image
  → OpenCode 插件
  → POST /internal/plugin/send-image
  → bridge 校验 session、workspace、图片
  → NapCat → QQ
```

只允许发送 workspace 内文件，拒绝 symlink 逃逸；默认单张最大 20 MB。图片以 `base64://` 发送，因此 bridge 与 NapCat 分容器时不需要共享路径。

### 出站文件

```text
agent 调用 qq_send_file
  → OpenCode 插件
  → POST /internal/plugin/send-file
  → bridge 校验 session、workspace、文件类型
  → NapCat upload_private_file / upload_group_file
```

用于 Markdown 报告、生成文档、压缩包等。默认启用，限制为：

- 单文件最大 50 MB（`security.max_outbound_file_bytes`）
- 只允许 workspace 内文件，拒绝 symlink 逃逸
- 拒绝 `.env`、`.env.*`、`.git`、`.ssh`、私钥等敏感文件
- 文件以 `base64://` 上传，因此 bridge 和 NapCat 分容器时不需要共享目录
- 文件发送后可以再发一条 caption 文本

`qq-code` agent 的提示词会要求：用户要文件时写文件并调用 `qq_send_file`，不要在聊天里粘贴整个文件内容。

## 工作区

当前版本为每个项目使用一个 **shared workspace**：

- 工作区路径就是 `projects.<id>.path`
- 同一项目跨 QQ 会话串行执行
- SQLite 持久化锁和租约，运行中每 30 秒续租
- bridge 启动时自动释放上一进程遗留的锁
- `!diff` 优先显示 OpenCode session diff，没有 session 时回退到 `git status/diff`

相关配置：

```yaml
workspaces:
  lock_lease_ms: 120000
  renew_interval_ms: 30000
```

## 群聊

支持三种模式：

| 模式 | 行为 |
| --- | --- |
| `per_user` | 每个群成员独立 Conversation，默认 |
| `shared` | 整个群共用一个 Conversation；审批只允许 owner/admin |
| `readonly` | 只读问答；`edit/write/shell/external_directory` 强制 deny |

示例：

```yaml
groups:
  "20001":
    enabled: true
    mode: per_user
    require_mention: true
    allowed_users: ["10001", "10002"]
    projects: ["demo"]
```

群消息必须同时满足：

- 群在 `groups` 中且 `enabled: true`
- 发送者在 `allowed_users`
- 项目在群可用项目内
- 非命令消息满足 @bot 要求

未授权用户/群默认静默忽略，只写审计。

> 当前群 `per_user` 隔离的是 Conversation；workspace 仍按项目共享。需要独立目录时请使用独立的 `projects.<id>.path`。

## 权限与审批

YAML 策略会编译成 OpenCode V2 permission ruleset，在创建/复用 session 时下发。策略来源包括项目、群、用户，多个来源按“最严格”合并：

```text
deny > ask > allow
```

示例：

```yaml
policies:
  standard:
    read: allow
    glob: allow
    grep: allow
    edit: ask
    shell: ask
    webfetch: ask
    websearch: ask
    external_directory: deny
    shell_rules:
      - pattern: "git status *"
        effect: allow
      - pattern: "git diff *"
        effect: allow
      - pattern: "git push *"
        effect: deny
      - pattern: "rm -rf *"
        effect: deny
```

当 OpenCode 触发 `permission.asked`：

1. bridge 发送 QQ 审批消息
2. 用户回复 `1` / `2` / `3`，或引用审批消息回复
3. bridge 调用 `permission.reply`
4. 超时默认 120 秒自动拒绝
5. `!stop` 会拒绝当前会话所有待审批请求

审批人规则：

- 私聊：发起者本人，或项目内 owner/admin
- 群 `per_user` / `readonly`：发起者本人，或群内 owner/admin
- 群 `shared`：只允许 owner/admin
- 群外 admin 不能审批该群请求

## 预算、限流与 2FA

```yaml
security:
  rate_limit:
    prompts_per_minute: 6
    runs_per_hour: 30
  budgets:
    daily_cost_usd_per_user: 5
    daily_tokens_per_user: 2000000
    daily_cost_usd_per_project: 20
  admin_2fa:
    enabled: false
    totp_secret: ${QQ_ADMIN_TOTP_SECRET:-}
    window_seconds: 300
```

启用 2FA 后，owner 需要先私聊发送：

```text
!sudo 123456
```

然后在窗口期内执行 `!ws clean` 等危险 bridge 命令。

owner 告警默认开启：

```yaml
notifications:
  owner_alerts:
    enabled: true
    on_startup: false
    on_run_failure: true
    on_budget_exceeded: true
```

bridge 还会定期调用 `get_login_info`（`onebot.login_probe_ms`）。如果 WebSocket 还在但 QQ 登录失效，会私聊 owner 告警。

## 配置说明

完整配置见 [`config/config.example.yaml`](config/config.example.yaml)。常用环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `NAPCAT_ACCESS_TOKEN` | 是 | NapCat OneBot access token |
| `NAPCAT_WS_URL` | 否 | NapCat 正向 WS 地址 |
| `QQ_BRIDGE_INTERNAL_TOKEN` | 是 | 插件回调鉴权 |
| `QQ_ADMIN_TOTP_SECRET` | 否 | owner 2FA 的 Base32 TOTP secret |
| `OPENCODE_QQ_ADMIN_PASSWORD` | 否 | `/admin` 首次创建管理员时使用的密码 |
| `LOG_LEVEL` | 否 | 覆盖日志级别 |
| `OPENCODE_QQ_CONFIG` | 否 | 覆盖配置文件路径 |
| `OPENCODE_QQ_ENV_FILE` | 否 | 覆盖 `.env` 路径 |

默认路径：

```text
~/.config/opencode-qq/config.yaml     # npm 安装
~/.config/opencode-qq/.env
~/.local/share/opencode-qq/           # SQLite / inbox / workspaces
```

源码目录中存在 `config/config.yaml` 时优先使用它，方便 `pnpm dev`。`.env` 会从配置文件同目录和当前目录加载，已有 shell/systemd 环境变量优先。

约定：

- 未知字段会直接校验失败，避免拼写错误静默生效。
- `security.allowed_roots` 非空时，项目路径必须位于其中。
- 用户、群、项目都需要显式声明。
- 一个用户只有一个可用项目时自动选择；多个项目使用 `default_project` 或 `!use`。

热加载：

- 私聊 owner 发送 `!reload`，或给进程发送 `SIGHUP`。
- 立即生效：`users`、`groups`、`projects`、`policies`、`plugins`、`security`、`admin`（除 `enabled`）、`features`、`qq`、`workspaces`、`opencode` 的模型/超时字段。
- 需要重启：`onebot`、`server`、`storage`、`opencode.service`、`admin.enabled`、`logging.pretty`。
- 校验失败时保留旧配置，不会中断正在运行的任务。

长任务反馈：

```yaml
qq:
  progress_ack: false       # 默认关闭，只发送最终回答
  progress_delay_ms: 3000
  progress_interval_ms: 30000
```

默认不发送“正在处理”占位消息。开启后，超过延迟仍未完成时发送一条 `⏳ 正在处理…`，之后按间隔更新为 `⏳ 仍在处理…（已 N 秒）`，最终回答发出后尝试删除；`progress_interval_ms: 0` 可只保留首条提示。

### 为什么 QQ 回复比 OpenCode TUI 慢

bridge 只负责把 prompt 投递给 OpenCode，然后等最终结果；TUI 则能看到逐 token 流式输出。实际耗时通常来自 OpenCode/provider，而不是 QQ 传输。可以从以下位置排查：

```bash
opencode service status
opencode api get /api/info
tail -n 200 ~/.local/share/opencode/log/opencode.log
```

常见原因：

- provider 网络超时或 `provider.internal` 上游不可用；
- OpenCode 启动时拉取 provider config / models.dev 超时；
- 项目里配置了 context7、playwright 等 MCP，每次 session 初始化都要等待连接或超时；
- 大体量系统提示、工具定义或项目文件导致输入 token 很多。

bridge 的 JSON 日志现在会记录 `phases.lockMs`、`phases.sessionMs`、`phases.promptMs`、`phases.waitMs`、`phases.collectMs`，可以直接看时间花在哪一段。`!status` 也会显示最近一次 run 的总耗时。

校验配置：

```bash
opencode-qq config validate
opencode-qq config validate --json
pnpm config:validate
```

## CLI

```bash
opencode-qq setup                          # 首次安装向导（npm 安装）
opencode-qq start                          # 启动 bridge
opencode-qq doctor                         # 检查配置、SQLite、OpenCode、OneBot
opencode-qq config validate                # 校验配置和项目目录
opencode-qq admin reset-password           # 重置 WebUI 管理员密码并踢出旧会话

pnpm dev                                   # 源码开发模式，tsx watch
pnpm dev:webui                             # 前端 Vite dev server
pnpm build && pnpm start                   # 生产构建（含 WebUI）并启动
pnpm doctor                                # 源码环境检查
```

`start` 默认校验项目目录；调试时可加 `--allow-missing-paths`。

## 长期运行

`pnpm dev` 是开发模式，不适合长期挂机。推荐使用 systemd user units：

```bash
pnpm build
mkdir -p ~/.config/systemd/user
cp deploy/systemd/opencode.service deploy/systemd/opencode-qq.service \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode.service opencode-qq.service
loginctl enable-linger "$USER"
```

路径、日志和 NapCat 稳定性说明见 [`deploy/systemd/README.md`](deploy/systemd/README.md)。

### NapCat 掉线

NapCat 掉线通常是 **QQ 登录会话失效**，不是 bridge 崩溃。建议：

1. 使用专用 QQ 小号。
2. 不要长期在同一公网 IP 上挂多个机器人号；测试号按需启动。
3. 保留 `data/napcat/qq` 登录态目录。
4. 固定 NapCat 镜像版本，不要无脑跟 `latest`。
5. 宿主时间/NTP 正常，容器设置 `TZ=Asia/Shanghai`。
6. 不要在手机/PC 主客户端重复登录机器人号。
7. WebUI 里优先使用“快速登录”；会话被 QQ 吊销时只能重新扫码。
8. 如果仍频繁掉线，可尝试在 NapCat `config/napcat.json` 中设置 `"o3HookMode": 0`，或更换出口 IP。

本地测试号可以按需启动（单独的测试 compose，不会影响生产 NapCat）：

```bash
docker compose -f docker-compose.test.yml up -d
docker compose -f docker-compose.test.yml stop
docker compose -f docker-compose.test.yml down
```

也可以和生产 NapCat 一起启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d
```

## 安全建议

- 只绑定 loopback 或内网，不要把 NapCat WebUI、bridge、OpenCode service 暴露到公网。
- Access Token、internal token 通过环境变量或 `0600` 文件注入。
- 未授权用户默认静默忽略；群聊必须同时满足群和用户 allowlist。
- 权限边界落在 OpenCode permission ruleset，不依赖 prompt。
- `external_directory` 默认 deny，`.env` 系列文件默认 deny。
- 入站图片限制类型、数量、大小，并默认拒绝私有地址。
- `qq_send_image` 只允许 workspace 内文件，拒绝 symlink 逃逸。
- 限流/预算用于成本控制，不替代权限规则。
- 审计默认只记录动作和元数据，不记录完整 prompt 正文。

## 开发与测试

```bash
pnpm typecheck
pnpm typecheck:plugin
pnpm lint
pnpm test
pnpm test:contract
```

可选的集成测试：

```bash
OPENCODE_INTEGRATION=1 \
OPENCODE_TEST_MODEL=opencode-go/deepseek-v4.1-flash \
pnpm test:integration

OPENCODE_VISION_INTEGRATION=1 \
OPENCODE_TEST_MODEL=opencode-go/deepseek-v4.1-flash \
pnpm vitest run tests/integration/vision.test.ts

OPENCODE_PLUGIN_INTEGRATION=1 \
OPENCODE_PLUGIN_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_PLUGIN_PASSWORD=... \
OPENCODE_PLUGIN_BRIDGE_PORT=18787 \
QQ_BRIDGE_INTERNAL_TOKEN=test-internal-token \
pnpm vitest run tests/integration/plugin-media.test.ts
```

真实 QQ 测试（需要两个已登录的 NapCat 账号）：

```bash
QQ_BOT_ID=... QQ_PEER_ID=... \
QQ_BOT_TOKEN=... QQ_PEER_TOKEN=... \
QQ_E2E_STOP=1 QQ_E2E_APPROVAL=1 pnpm test:qq

QQ_BOT_ID=... QQ_PEER_ID=... \
QQ_BOT_TOKEN=... QQ_PEER_TOKEN=... \
QQ_E2E_CHART=var/e2e-chart.png pnpm test:qq:media
```

## 项目结构

```text
src/                    bridge 本体
  app.ts                组装与生命周期
  config/               YAML schema、加载、环境变量
  onebot/               NapCat / OneBot 11 适配
  router/               命令与 prompt 分发
  policy/               授权、permission ruleset、限流预算
  approval/             QQ 审批 Broker
  conversation/         队列、run、session 归属
  workspace/            shared workspace 锁与 diff
  media/                入站图片、插件出站图片
  security/             TOTP / sudo
  opencode/             OpenCode V2 client 适配
  qq/                   Markdown 降级、分段、发送
  store/                SQLite
  observability/        日志、health、审计、owner 告警
  admin/                /admin API、鉴权、配置/Prompt 编辑
  plugins/              QQ 插件 SDK、manifest、宿主、媒体/存储 API
  internal-http/        Hono HTTP
packages/plugin-sdk/    @opencode-qq/plugin-sdk
packages/roleplay/       @opencode-qq/roleplay（私聊角色扮演，实验）
packages/webui/         Vite + React + shadcn/ui 管理前端
examples/               示例 QQ 插件（hello / notes / media-demo）
plugin/                 OpenCode V2/V1 插件（仅 qq_send_image）
deploy/systemd/         systemd 常驻服务
tests/                  单元 / 契约 / 集成测试
```

## 文档

- 完整设计：[`DESIGN.md`](DESIGN.md)
- 插件安装：[`plugin/README.md`](plugin/README.md)
- systemd 部署：[`deploy/systemd/README.md`](deploy/systemd/README.md)

## License

MIT
