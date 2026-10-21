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
- 出站图片：agent 调用 `qq_send_image` 把 workspace 内图片发回 QQ。
- shared workspace 锁：同一项目跨 QQ 会话串行执行；bridge 重启后自动恢复遗留锁。
- 群聊 `per_user` / `shared` / `readonly` 模式、@bot、群 allowlist。
- owner TOTP 2FA、每日预算/限流、owner 告警。
- SQLite 持久化会话、运行、审批、工作区、用量和审计。
- `/health` 健康检查、JSON 日志和密钥脱敏。

## 前置条件

- Node.js >= 22.11
- pnpm >= 10
- 一个可登录的 QQ 小号
- NapCat（推荐 Docker Compose）
- 本机 OpenCode V2 service
- 一个支持工具调用（需要发图时还需要 vision）的模型

## 快速开始

### 1. 安装依赖和配置

```bash
git clone <repo-url> opencode-qq-adapter
cd opencode-qq-adapter
pnpm install

cp .env.example .env
cp config/config.example.yaml config/config.yaml
```

编辑 `.env`：

```dotenv
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=change-me
QQ_BRIDGE_INTERNAL_TOKEN=change-me-too
```

编辑 `config/config.yaml`，至少确认：

```yaml
server:
  internal_token: ${QQ_BRIDGE_INTERNAL_TOKEN}

onebot:
  url: ${NAPCAT_WS_URL:-ws://127.0.0.1:3001}
  access_token: ${NAPCAT_ACCESS_TOKEN}

users:
  "你的QQ号":
    role: owner
    projects: ["*"]

projects:
  demo:
    path: /绝对路径/到/你的项目
    policy: standard
    workspace: shared
```

`config.yaml` 里的相对路径按配置文件所在目录解析；密钥只放 `.env`，不要写进 YAML。

### 2. 启动 OpenCode

```bash
opencode serve --service
```

也可以让 bridge 自动拉起：把 `opencode.service.mode` 设为 `ensure`。生产环境更推荐用 systemd 管理 service。

检查 OpenCode 是否可用：

```bash
opencode models
pnpm doctor
```

### 3. 启动 NapCat 并登录

```bash
docker compose up -d
```

查看日志里的 WebUI 地址和 token：

```bash
docker logs -f opencode-qq-napcat
```

打开 WebUI 扫码登录。默认端口：

| 端口 | 用途 |
| --- | --- |
| `6099` | NapCat WebUI |
| `3001` | NapCat 正向 WebSocket（bridge 连接） |
| `8787` | bridge health / internal HTTP |

如果你不用本项目的 Compose，需要在 NapCat 网络配置里启用 **WebSocket Server**，并让 `onebot.url` 和 `access_token` 与 NapCat 一致。

登录态保存在：

```text
data/napcat/qq
```

不要删除这个目录，否则必须重新扫码。

### 4. 安装 `qq_send_image` 插件（可选）

只有需要 **agent 主动发图片回 QQ** 时才需要安装。入站图片、文字、命令、审批都不依赖它。

```bash
mkdir -p ~/.config/opencode/plugins
ln -sf "$(pwd)/plugin/opencode-qq-plugin.ts" \
  ~/.config/opencode/plugins/opencode-qq-plugin.ts
```

配置 bridge 回调地址和 token。可以放在 OpenCode service 环境中：

```bash
export QQ_BRIDGE_INTERNAL_URL=http://127.0.0.1:8787
export QQ_BRIDGE_INTERNAL_TOKEN=<与 server.internal_token 相同>
```

如果 OpenCode 由 TUI 自动拉起，可能不会继承 shell 环境，可以改用 `0600` 配置文件：

```bash
cat > ~/.config/opencode/qq-bridge.json <<'JSON'
{
  "url": "http://127.0.0.1:8787",
  "token": "与 server.internal_token 相同"
}
JSON
chmod 600 ~/.config/opencode/qq-bridge.json
```

确认插件已加载：

```bash
opencode plugin list
```

OpenCode 1.x 请使用 `plugin/v1-opencode-qq-plugin.ts`，详见 [`plugin/README.md`](plugin/README.md)。

### 5. 启动 bridge

开发模式：

```bash
pnpm dev
```

生产模式：

```bash
pnpm build
pnpm start
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health | jq
```

状态含义：

- `ok`：OneBot 和 OpenCode 都正常
- `degraded`：OneBot 未连接或 OpenCode 不可用，HTTP 仍返回 200
- `error`：数据库异常，返回 503

### 6. 在 QQ 中验证

私聊机器人：

```text
!ping
!whoami
!projects
!use demo
请只回复：hello
!status
!ws
!diff
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

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| `!ping` | 返回 `pong` |
| `!help` | 命令帮助 |
| `!whoami` | 显示 QQ、角色、可用项目 |
| `!projects` | 列出可用项目 |
| `!use <项目>` / `!cd <项目>` | 切换项目并重置会话 |
| `!new` | 为当前项目创建新会话 |
| `!status` | OneBot / OpenCode / 项目 / 工作区锁 / 会话 / 运行状态 |
| `!diff` | 当前会话 diff + 工作区 git 改动摘要 |
| `!ws` | 当前工作区、锁持有者和租约 |
| `!ws list` | 列出可用工作区及状态 |
| `!ws clean` | 释放过期租约（owner；启用 2FA 时需先 `!sudo`） |
| `!stop` | 中断当前 run，清空排队任务 |
| `!model` | 查看当前模型 |
| `!agent` | 查看当前 agent |
| `!sudo <TOTP>` | 为 owner 危险操作开启短窗口（仅私聊） |
| `!approvals` | 查看当前会话待审批请求 |
| `!approve <id> once\|always\|reject` | 处理审批 |
| `!reject <id>` | 拒绝审批 |
| `!audit N` | 查看最近 N 条审计记录（owner/admin） |

普通文本会作为 prompt 发送给 OpenCode。最终回答会做 Markdown 降级和长消息分段；群里默认 @ 发起人并引用原消息。

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

### 文件

目前没有暴露 `qq_send_file` agent 工具。底层 `OneBotPort` 已支持 `upload_private_file` / `upload_group_file`，可以作为后续扩展点。

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
| `LOG_LEVEL` | 否 | 覆盖日志级别 |

约定：

- 未知字段会直接校验失败，避免拼写错误静默生效。
- `security.allowed_roots` 非空时，项目路径必须位于其中。
- 用户、群、项目都需要显式声明。
- 一个用户只有一个可用项目时自动选择；多个项目使用 `default_project` 或 `!use`。

校验配置：

```bash
pnpm config:validate
pnpm config:validate -- --json
```

## CLI

```bash
pnpm dev                                  # 开发模式，tsx watch
pnpm build && pnpm start                  # 生产构建并启动
pnpm config:validate                      # 校验配置和项目目录
pnpm doctor                               # 检查配置、SQLite、OpenCode、OneBot
```

`pnpm start` 默认校验项目目录；调试时可加 `--allow-missing-paths`。

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

本地测试号可以按需启动：

```bash
docker compose --profile e2e up -d napcat-peer
docker compose --profile e2e stop napcat-peer
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
  internal-http/        Hono HTTP
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
