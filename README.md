# OpenCode QQ Adapter

把本机运行的 [OpenCode](https://opencode.ai/) V2 接入 QQ 的桥接服务。通过 NapCat / OneBot 11 在 QQ 私聊或群聊里使用 coding agent，支持项目切换、会话管理、运行中断和健康检查。

> 当前版本完成 **M0 骨架**、**M1 Agent 闭环** 与 **M2 权限 / YAML / 审批 / 审计 / 限流**。图片输入/输出、工作区隔离等能力已在架构中预留，详见 [Roadmap](#roadmap)。

## 已实现（M0 / M1 / M2）

- YAML + zod 严格配置校验，支持 `${ENV_VAR}` 与 `${ENV_VAR:-default}`。
- `pino` JSON 日志、密钥脱敏、`/health` 健康检查、Prometheus 指标开关。
- 通过 `node-napcat-ts` 连接 NapCat 正向 WebSocket；SDK 负责连接、API 调用与重连。
- Access Token、消息去重、心跳/生命周期事件处理，以及文件上传 API。
- `!ping`、`!help`、`!whoami`、`!projects`、`!use/!cd`、`!new`、`!status`、`!stop`、`!model`、`!agent`。
- `!approvals`、`!approve`、`!reject`、`!audit`，以及审批消息下的 `1/2/3` 快捷回复。
- YAML 策略（`readonly` / `standard` / `trusted`、`shell_rules`）编译为 OpenCode V2 permission ruleset，并在创建/复用 session 时下发。
- 用户/群/项目/策略合并，多来源取最严格 effect；`readonly` 群强制禁止写入和 shell。
- QQ 审批 Broker：`permission.asked` → QQ 审批消息 → `permission.reply`；支持超时自动拒绝、`!stop` 批量拒绝、重启后清理遗留审批。
- 子 session（subagent）的权限请求会沿 parent session 归属到原 QQ 会话；其他 OpenCode 客户端（如 TUI）的 session 不会被误处理。
- SQLite 审计日志（访问拒绝、prompt、run、项目切换、审批、限流拒绝）与 owner/admin `!audit`。
- 每用户每分钟 prompt、每小时运行次数、每日 token/cost、项目每日 cost 限流与预算。
- OpenCode V2 service discover / ensure / 固定 `base_url` 三种模式。
- Session 创建/恢复、prompt、事件订阅、`session.wait` 完成等待、最终回答提取。
- 每会话串行队列、队列上限、`!stop` 中断并清空队列。
- SQLite 持久化会话、运行记录、审批、用量、消息去重。
- CLI：`start`、`doctor`、`config validate`。
- 单元测试、Fake OneBot 契约测试、真实 OpenCode / permission 集成测试（gated）。

## 架构

```text
QQ 客户端
   │ 腾讯 QQ 协议
   ▼
NapCat (Docker / systemd)
   │ OneBot 11 WebSocket
   ▼
┌─────────────────────────────────────────────┐
│ opencode-qq-adapter                         │
│                                             │
│ OneBot adapter ──► Router ──► PolicyEngine  │
│                        │                    │
│              ┌─────────┼─────────┐          │
│              ▼         ▼         ▼          │
│       Conversation  Approval   Quota/Audit  │
│        Manager       Broker                 │
│              │         │                    │
│              ▼         ▼                    │
│           SQLite    AgentPort               │
│                        │                    │
│               OpenCodeAgent                 │
└───────────────────────────┼─────────────────┘
                            │ HTTP / SSE
                            ▼
                 OpenCode V2 service
                 (opencode serve --service)
                            │
                            ▼
                    项目目录 / shell / git
```

分层：

- `src/onebot/`：OneBotPort、`node-napcat-ts` 适配器、消息段解析。
- `src/router/`：命令解析与消息分发。
- `src/policy/`：用户、群、项目授权、默认项目、permission ruleset 编译、限流预算。
- `src/approval/`：`permission.asked` → QQ 审批 → `permission.reply` 的审批 Broker。
- `src/conversation/`：队列、run 生命周期、OpenCode 会话绑定。
- `src/opencode/`：`@opencode/client@2.0.32` 适配器。
- `src/ports/`：`AgentPort`、`OneBotPort`、`StorePort`，便于替换实现与测试。
- `src/store/`：SQLite 迁移与 Repository（会话、运行、审批、审计、用量）。
- `src/observability/`：日志、health、审计写入。
- `src/qq/`：Markdown 降级、长消息分段、消息发送。
- `src/internal-http/`：health、metrics、插件回调预留。

## 快速开始

### 1. 前置条件

- Node.js >= 22.11
- pnpm >= 10
- OpenCode V2（当前验证版本 `2.0.32`）
- 一个可登录的 QQ 小号与 NapCat

```bash
pnpm install
cp .env.example .env          # 填入 NAPCAT_ACCESS_TOKEN
cp config/config.example.yaml config/config.yaml
```

也可以直接执行 `pnpm dev`，`predev` 会在缺少配置时自动复制示例配置。

### 2. 启动 OpenCode

```bash
opencode serve --service
# 或者让 bridge 自动拉起：opencode.service.mode: ensure
```

检查：

```bash
pnpm run doctor
pnpm config:validate
```

`doctor` 会检查配置、项目目录、SQLite、OpenCode、OneBot 端口/连接。

### 3. 启动 bridge

```bash
pnpm dev
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health | jq
```

正常时 OneBot 未连接会显示 `degraded`，HTTP 仍返回 200；数据库异常返回 503。OneBot 与 OpenCode 都正常时为 `ok`。

### 4. 配置 NapCat

#### 正向 WebSocket

在 NapCat 网络配置中启用 **WebSocket Server**（默认 `127.0.0.1:3001`），bridge 主动连接：

```yaml
onebot:
  url: ws://127.0.0.1:3001
  access_token: ${NAPCAT_ACCESS_TOKEN}
```

NapCat 在 Docker 中时，使用 `docker-compose.yml` 映射到宿主机的 `ws://127.0.0.1:3001`。Access Token 与 `.env` 中的 `NAPCAT_ACCESS_TOKEN` 保持一致。

### 5. 在 QQ 中验证

私聊机器人：

```text
!ping
!whoami
!projects
!use demo
请只回复：hello
!status
!stop

# 审批演示：让 agent 执行 shell，然后在 QQ 回复 1/2/3
请使用 shell 工具执行 `echo hello`，然后回复命令输出。
```

## Docker Compose（NapCat）

```bash
cp .env.example .env
docker compose up -d
```

默认端口：

| 端口 | 用途 |
| --- | --- |
| `6099` | NapCat WebUI |
| `3001` | NapCat 正向 WS（bridge 连接） |
| `8787` | bridge health / internal HTTP |

bridge 的 `onebot.url` 配置为 `ws://127.0.0.1:3001`。

数据目录：

```text
data/napcat/config
data/napcat/qq
data/napcat/plugins
```

## 配置

完整示例见 [`config/config.example.yaml`](config/config.example.yaml)。

> 当前版本使用 `node-napcat-ts` 正向 WS，`onebot` 配置只需要 `url`、`access_token` 和重连参数；旧版的 `mode/host/port/path` 已移除。

关键配置：

```yaml
opencode:
  service:
    mode: external      # external | ensure | off
    base_url: null      # null = 自动发现本地 service
    version: ">=2.0.0 <3.0.0"
  default_model: opencode-go/deepseek-v4.1-flash

onebot:
  url: ${NAPCAT_WS_URL:-ws://127.0.0.1:3001}
  access_token: ${NAPCAT_ACCESS_TOKEN}
  action_timeout_ms: 15000
  upload_timeout_ms: 600000
  reconnect:
    enabled: true
    attempts: 1000000
    delay_ms: 3000

default_project: demo

users:
  "10001":
    role: owner
    projects: ["*"]

projects:
  demo:
    path: ..
    policy: standard
    workspace: shared
    model: null          # null = 使用 opencode.default_model
```

约定：

- YAML 中只放策略，不提交密钥；密钥通过环境变量注入。
- 未知字段会直接校验失败，避免拼写错误静默生效。
- 相对路径按配置文件所在目录解析。
- `security.allowed_roots` 非空时，项目路径必须位于其中。
- 用户、群、项目均需显式声明；未授权用户默认静默忽略。
- 一个用户只有一个可用项目时自动选择；多个项目时使用 `default_project` 或 `!use`。

## CLI

```bash
pnpm dev                                  # tsx watch，读取 config/config.yaml
pnpm run build && pnpm start              # 生产构建
pnpm config:validate                      # 校验配置（含项目目录）
pnpm run doctor                           # 全链路检查
pnpm tsx src/main.ts config validate -c path/to/config.yaml --json
```

`start` 默认校验项目目录存在；调试配置时可加 `--allow-missing-paths`。

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `!ping` | 返回 `pong` |
| `!help` | 命令帮助 |
| `!whoami` | QQ、角色、可用项目 |
| `!projects` | 项目列表 |
| `!use <项目>` / `!cd <项目>` | 切换项目（会重置会话） |
| `!new` | 为当前项目创建新会话 |
| `!status` | OneBot/OpenCode/项目/会话/运行/队列状态 |
| `!stop` | 中断当前 run，清空排队任务 |
| `!model` | 当前模型 |
| `!agent` | 当前 agent |
| `!approvals` | 查看当前会话待审批请求 |
| `!approve <id> once\|always\|reject` | 处理审批 |
| `!reject <id>` | 拒绝审批 |
| `!audit N` | 查看最近 N 条审计记录（owner/admin） |

普通文本会作为 prompt 发送给 OpenCode。最终回答会做 Markdown 降级与长消息分段；群里默认 @ 发起人并引用原消息。

危险操作会触发审批消息，可直接回复 `1`（允许一次）、`2`（本会话总是允许）、`3`（拒绝），或引用审批消息回复。审批只允许发起者本人；`owner`/`admin` 可以 override，群 `shared` 模式只允许 `owner`/`admin` 审批。

## 测试

```bash
pnpm typecheck
pnpm lint
pnpm test                 # 单元 + Fake OneBot 契约测试
pnpm test:contract

# 真实 OpenCode（需要本地 service 与可用模型）
OPENCODE_INTEGRATION=1 \
OPENCODE_TEST_MODEL=opencode-go/deepseek-v4.1-flash \
pnpm test:integration

# 真实 QQ 冒烟测试（bridge 已启动，另有一个 QQ 小号作为发送方）
QQ_BOT_ID=... QQ_PEER_ID=... \
QQ_BOT_TOKEN=... QQ_PEER_TOKEN=... \
QQ_E2E_STOP=1 QQ_E2E_APPROVAL=1 pnpm test:qq
```

`test:qq` 通过 OneBot HTTP API 让 peer 账号给机器人发消息，再读取机器人的好友消息历史，依次验证 `!ping`、prompt 最终回答和 `!stop`；`QQ_E2E_APPROVAL=1` 时还会验证 shell 审批与批准后的执行。NapCat 地址可通过 `QQ_BOT_HTTP` / `QQ_PEER_HTTP` 覆盖。

本轮开发已验证：

- `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（M2：74 passed，3 integration skipped）。
- 真实 OpenCode `2.0.32`：session → prompt → 最终文本通过。
- 真实 OpenCode permission：`session.update({ permissions })` 后 `shell ask` 产生 `permission.asked`，`permission.reply("reject")` 可解除 pending。
- 真实 OpenCode + 真 ApprovalBroker（Fake OneBot）：prompt → `permission.asked` → QQ 审批消息 → 回复 `1` → shell 执行 → 最终回答，全链路通过。
- 真实 NapCat + 两个 QQ 账号（3384461856 / 2101197401）：`!ping`、prompt 最终回答、`!stop`、审批请求、`1` 批准、批准后 shell 执行、`!audit` 均通过（`pnpm test:qq`，`QQ_E2E_STOP=1 QQ_E2E_APPROVAL=1`）。

测试覆盖：

- 配置加载、环境变量、未知字段、路径校验、默认项目。
- CQ 码/消息段解析、@bot、图片/引用提取、群 ChatKey。
- Markdown 降级、长消息分段、代码围栏闭合、CJK。
- 用户/群/项目授权与默认项目。
- Permission ruleset：基线、`.env` deny、`readonly`、多来源最严格合并、shell rule 顺序。
- ConversationManager：prompt、最终回答、队列上限、中断、失败上报、permission 下发。
- ApprovalBroker：QQ 审批消息、发起人校验、shared 群 owner/admin、数字/引用回复、超时、`!stop` 拒绝。
- 限流与预算：每分钟 prompt、每小时 run、每日用户/项目 cost、每日 token。
- SQLite：审批持久化、审计、用量、按 session 查找会话。
- `NapCatOneBotAdapter`：事件转发、段映射、发送、文件上传、断线错误。
- 应用 + Fake OneBot：`!ping`、prompt 闭环、`!stop`、审批、限流、项目切换、去重、未知用户静默。
- 真实 OpenCode：session 创建、prompt、事件、最终文本、permission.asked/reply。

## 目录结构

```text
src/
  app.ts                  # 组装与生命周期
  cli.ts / main.ts        # CLI 入口
  config/                 # schema、loader、环境变量
  domain/                 # Chat/Message/Conversation/Run
  ports/                  # Agent/OneBot/Store 接口
  onebot/                 # OneBotPort、node-napcat-ts 适配、段解析
  router/                 # 命令与 prompt 分发
  policy/                 # 授权、ruleset 编译、限流预算
  approval/               # QQ 审批 Broker 与消息格式
  conversation/           # 队列与 run 生命周期
  opencode/               # OpenCode V2 适配器
  qq/                     # 文本格式化、分段、发送
  store/                  # SQLite
  observability/          # 日志、health、审计
  internal-http/          # Hono HTTP
tests/
  unit/ contract/ integration/ helpers/
```

## 安全与限制

- 只绑定 loopback 或内网；不要把 NapCat WebUI、bridge、OpenCode service 暴露到公网。
- Access Token、internal token 通过环境变量注入，日志默认脱敏。
- 未授权用户静默忽略；群聊必须同时满足群与用户 allowlist。
- 权限边界落在 OpenCode permission ruleset：bridge 在创建/复用 session 时下发 YAML 编译出的规则；`ask` 由 QQ ApprovalBroker 处理。
- 审批超时默认 `opencode.permission_timeout_ms`（120 秒），超时自动 `reject`；`!stop` 会拒绝当前会话所有 pending 审批。
- bridge 只处理自己数据库里记录的 session；TUI 或其他 OpenCode 客户端的 permission 请求会被忽略并审计，不会被误拒。
- 审计默认只记录动作和元数据，不记录 prompt 正文；`!audit` 仅 owner/admin 可用。
- 限流/预算用于成本控制，不替代权限规则；所有限制都只能收紧全局配置。
- **图片输入/输出尚未实现（M4）**：`features.images` 与 internal HTTP 路由已预留，但收到图片时只会提示暂不支持。
- 群聊 `shared` / `readonly` 的会话隔离与审批权限已实现，per-user workspace、worktree 隔离尚未实现（M3/M5/M6）。
- OpenCode service 的 `ensure` 模式只负责拉起，不是进程守护；生产建议用 systemd 管理 service。

## 文件 / 图片能力

- 图片发送：使用 OneBot `image` 消息段，SDK 的 `Structs.image()` 支持 URL、本地路径和 Buffer。
- 文件发送：`OneBotPort` 已提供 `uploadPrivateFile` / `uploadGroupFile`，由 `node-napcat-ts` 的 `upload_private_file` / `upload_group_file` 实现。
- 当前尚未把文件上传暴露成 QQ 命令或 agent 工具；计划在 M4 接入 `qq_send_file` 插件。
- `file` 参数是 **NapCat 所在机器/容器视角的路径**。bridge 与 NapCat 分容器时，需要共享 volume，或传 HTTP URL / `base64://`。
- 超大文件应使用 NapCat Stream API；当前 SDK 适配层尚未封装流式上传。

## Roadmap

- **M3**：shared workspace 锁、`!use`/`!status`/`!diff`、租约恢复。
- **M4**：入站图片下载/校验、`qq_send_image` 插件、长代码转文件。
- **M5**：群 `per_user`/`shared`/`readonly`、2FA、预算。
- **M6**：per-user workspace。
- **M7**：per-task worktree。
- **M8**：metrics、备份、systemd 部署文档。

## 设计文档

完整设计见 [`DESIGN.md`](DESIGN.md)。

## License

MIT
