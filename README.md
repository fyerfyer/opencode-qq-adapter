# OpenCode QQ Adapter

把本机运行的 [OpenCode](https://opencode.ai/) V2 接入 QQ 的桥接服务。通过 NapCat / OneBot 11 在 QQ 私聊或群聊里使用 coding agent，支持项目切换、会话管理、运行中断和健康检查。

> 当前版本完成 **M0 骨架** 与 **M1 Agent 闭环**。图片输入/输出、权限审批、工作区隔离等能力已在架构中预留，但尚未实现，详见 [Roadmap](#roadmap)。

## 已实现（M0 / M1）

- YAML + zod 严格配置校验，支持 `${ENV_VAR}` 与 `${ENV_VAR:-default}`。
- `pino` JSON 日志、密钥脱敏、`/health` 健康检查、Prometheus 指标开关。
- 通过 `node-napcat-ts` 连接 NapCat 正向 WebSocket；SDK 负责连接、API 调用与重连。
- Access Token、消息去重、心跳/生命周期事件处理，以及文件上传 API。
- `!ping`、`!help`、`!whoami`、`!projects`、`!use/!cd`、`!new`、`!status`、`!stop`、`!model`、`!agent`。
- OpenCode V2 service discover / ensure / 固定 `base_url` 三种模式。
- Session 创建/恢复、prompt、事件订阅、`session.wait` 完成等待、最终回答提取。
- 每会话串行队列、队列上限、`!stop` 中断并清空队列。
- SQLite 持久化会话、运行记录、消息去重。
- CLI：`start`、`doctor`、`config validate`。
- 单元测试、Fake OneBot 契约测试、真实 OpenCode 集成测试（gated）。

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
│                        ▼                    │
│               ConversationManager           │
│                  │        │                 │
│                  ▼        ▼                 │
│              SQLite    AgentPort            │
│                           │                 │
│                  OpenCodeAgent              │
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
- `src/policy/`：用户、群、项目授权与默认项目解析。
- `src/conversation/`：队列、run 生命周期、OpenCode 会话绑定。
- `src/opencode/`：`@opencode/client@2.0.32` 适配器。
- `src/ports/`：`AgentPort`、`OneBotPort`、`StorePort`，便于替换实现与测试。
- `src/store/`：SQLite 迁移与 Repository。
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

普通文本会作为 prompt 发送给 OpenCode。最终回答会做 Markdown 降级与长消息分段；群里默认 @ 发起人并引用原消息。

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
QQ_E2E_STOP=1 pnpm test:qq
```

`test:qq` 通过 OneBot HTTP API 让 peer 账号给机器人发消息，再读取机器人的好友消息历史，依次验证 `!ping`、prompt 最终回答和 `!stop`。NapCat 地址可通过 `QQ_BOT_HTTP` / `QQ_PEER_HTTP` 覆盖。

本轮开发已验证：

- `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过（43 passed）。
- 真实 OpenCode `2.0.32`：session → prompt → 最终文本通过。
- 真实 NapCat + QQ 小号（native 适配器阶段）：`!ping` → `pong`、prompt → 最终回答、`!stop` → 中断均通过。
- 改用 `node-napcat-ts` 后：SDK 直连现有 NapCat 的 `get_login_info` 已通过；适配器 + Fake NapCat WS 的 `!ping`、prompt、Token 鉴权契约测试通过。
- 完整真实 QQ 回归：NapCat 账号掉线后需要重新扫码登录，再运行 `pnpm test:qq`。

测试覆盖：

- 配置加载、环境变量、未知字段、路径校验、默认项目。
- CQ 码/消息段解析、@bot、图片/引用提取、群 ChatKey。
- Markdown 降级、长消息分段、代码围栏闭合、CJK。
- 用户/群/项目授权与默认项目。
- ConversationManager：prompt、最终回答、队列上限、中断、失败上报。
- `NapCatOneBotAdapter`：事件转发、段映射、发送、文件上传、断线错误。
- 应用 + Fake OneBot：`!ping`、prompt 闭环、`!stop`、项目切换、去重、未知用户静默。
- 真实 OpenCode：session 创建、prompt、事件、最终文本。

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
  policy/                 # 授权
  conversation/           # 队列与 run 生命周期
  opencode/               # OpenCode V2 适配器
  qq/                     # 文本格式化、分段、发送
  store/                  # SQLite
  observability/          # 日志、health
  internal-http/          # Hono HTTP
tests/
  unit/ contract/ integration/ helpers/
```

## 安全与限制

- 只绑定 loopback 或内网；不要把 NapCat WebUI、bridge、OpenCode service 暴露到公网。
- Access Token、internal token 通过环境变量注入，日志默认脱敏。
- 未授权用户静默忽略；群聊必须同时满足群与用户 allowlist。
- 最终权限边界应落在 OpenCode permission ruleset（M2）。当前 M1 使用 OpenCode 自身的权限配置，bridge 尚未下发 YAML 规则。
- **图片输入/输出尚未实现（M4）**：`features.images` 与 internal HTTP 路由已预留，但收到图片时只会提示暂不支持。
- 群聊 `shared` / `readonly`、per-user workspace、worktree 隔离尚未实现（M3/M5/M6）。
- OpenCode service 的 `ensure` 模式只负责拉起，不是进程守护；生产建议用 systemd 管理 service。

## 文件 / 图片能力

- 图片发送：使用 OneBot `image` 消息段，SDK 的 `Structs.image()` 支持 URL、本地路径和 Buffer。
- 文件发送：`OneBotPort` 已提供 `uploadPrivateFile` / `uploadGroupFile`，由 `node-napcat-ts` 的 `upload_private_file` / `upload_group_file` 实现。
- 当前 M1 尚未把文件上传暴露成 QQ 命令或 agent 工具；计划在 M4 接入 `qq_send_file` 插件。
- `file` 参数是 **NapCat 所在机器/容器视角的路径**。bridge 与 NapCat 分容器时，需要共享 volume，或传 HTTP URL / `base64://`。
- 超大文件应使用 NapCat Stream API；当前 SDK 适配层尚未封装流式上传。

## Roadmap

- **M2**：YAML → OpenCode permission ruleset、审批 broker、审计、限流。
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
