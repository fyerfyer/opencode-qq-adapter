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
- YAML 定义用户、项目、可访问/可修改权限和预算。
- 危险操作通过 QQ 审批：允许一次 / 本会话总是允许 / 拒绝。
- 入站图片：QQ 发图，agent 能看图。
- 出站图片/文件：agent 调用 `qq_send_image` / `qq_send_file` 把 workspace 内媒体发回 QQ。
- shared workspace 锁：同一项目跨 QQ 会话串行执行；bridge 重启后自动恢复遗留锁。
- 群聊零配置：任何已授权 QQ 在私聊或群里都按同一套权限使用；群内默认每人独立会话，@bot 可全局配置。
- owner TOTP 2FA、每日预算/限流、owner 告警。
- SQLite 持久化会话、运行、审批、工作区、用量和审计。
- 本机 WebUI：登录、状态、成员/项目、会话、Agents、插件、审计、用量、YAML 编辑，以及 Roleplay 的角色卡/世界书/表情包/记忆/绑定管理。
- 第三方插件 UI：插件自带静态页面，在 opaque-origin sandbox iframe 中运行，通过 `@opencode-qq/plugin-ui` 的 MessageChannel bridge 使用受控 API。
- QQ 侧插件 SDK：命令、prompt/run hooks、事件、独立数据目录、文本/图片/文件发送。
- 可选 Roleplay 插件：Character Card V2/V3、世界书 lite（递归/整词/调试）、情绪表情包（WebP 缩略图）、Markdown 记忆和分段延迟回复。
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
--admin-password <p>  管理员密码（新数据库设置 / 已有数据库重置；默认交互询问或生成）
--with-roleplay       启用 Roleplay 插件与项目
--roleplay-path <p>   @opencode-qq/roleplay 包目录
--roleplay-personas <p> 角色卡目录
--roleplay-project <id> Roleplay 项目 ID（默认 roleplay）
--reconfigure         合并已有配置（保留注释和自定义项目）
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
npm install -g ./opencode-qq-adapter-0.1.2.tgz
opencode-qq start

# 或在源码目录
pnpm build
pnpm start
```

如果只是临时用 npx 调试，可以关闭 audit/fund：

```bash
npm_config_audit=false npm_config_fund=false \
  npx -y -p ./opencode-qq-adapter-0.1.2.tgz opencode-qq start
```

### 停止与端口

在 `pnpm start` / `opencode-qq start` 的终端按一次 `Ctrl+C` 会先关闭 HTTP 监听端口，再清理 OneBot、插件和 OpenCode；如果清理超过 15 秒会强制退出。再按一次 `Ctrl+C` 也会立即强制退出。这样重启时不会因为旧的清理流程继续占用 `8787`。

NapCat 的 `3001`（WebSocket）和 `6099`（WebUI）由 Docker 容器独立持有，Ctrl+C 停止 bridge **不会**停止 NapCat。需要停止它时运行：

```bash
docker stop opencode-qq-napcat
```

如果端口仍被占用，先确认是不是旧的 node 进程：

```bash
ss -ltnp | grep 8787
ps -ef | grep 'dist/main.js start'
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

也可以用 `OPENCODE_QQ_ADMIN_PASSWORD` 在**首次**创建管理员时指定密码；账号已存在后该环境变量不再生效。已有数据库请用 `setup --admin-password` 重置，或运行 `opencode-qq admin reset-password`。

管理台提供：

- 概览：OneBot / OpenCode / SQLite / 事件流状态、活跃 run、今日用量、待审批和审计。
- 成员：QQ、Bot 角色（所有者/管理员/使用者）、可访问项目、可修改项目、可收紧的个人限制。
- 项目：项目路径、agent/model、workspace 模式；插件内部项目默认隐藏。
- 会话：QQ chat ↔ OpenCode session 绑定、中断、解绑、切换和删除项目 session；可直接切换当前会话的 Agent/model，模型列表会标注 vision/tools capability。
- Agents：按 core / plugin / user 分组管理 OpenCode 全局 `agents/*.md`；核心 agent 可编辑并备份/恢复，`qq-rp`、`qq-rp-utility` 等插件管理的 agent 默认只读，需要显式开启高级覆盖。每个 Agent 可直接选择默认模型（写入 frontmatter `model:`），模型列表来自 OpenCode，支持搜索、固定顶部和滚动列表；保存后自动调用 OpenCode location reload 热重载。若当前有任务运行或排队，保存会被拒绝，避免热重载中断正在执行的任务；请等任务结束后再保存。角色卡和记忆仍在 Roleplay 页面。
- 配置：直接编辑 YAML；保存时执行 zod + 路径校验、备份、原子替换和热加载。
- 审计 / 用量：事件明细和按天 token / cost 汇总。
- 插件：查看加载状态、命令、能力、数据来源、admin routes 和失败原因；可通过 WebUI 上传 ZIP 或注册本地目录安装插件，支持启用/禁用、重新加载、更新、回滚和卸载，也可进入插件自己的管理页。
- 设置：配置 YAML、管理员密码、运行时信息，以及“连接”页管理 NapCat WebSocket URL/Access Token 和 Roleplay 的 Jev API Key、Base URL、Endpoint、模型；密钥只写入 `.env`，Jev 端点写入 Roleplay 配置，页面只显示“已配置/未配置”。Roleplay 页面的“设置 → 表情”里也可以直接填写 Jev Base URL、API Key，并用“测试连接”按钮做一次真实请求。
- 第三方插件页面：插件自带 `ui/` 静态资源，由核心在 `sandbox` iframe 中挂载；页面通过 `@opencode-qq/plugin-ui` 的 MessageChannel bridge 调用本插件 admin API，不接触管理员 cookie 和 CSRF。
- Roleplay：角色卡导入、备注编辑、世界书条目新增/编辑/删除/启停与关键词调试、表情包上传/去重/缩略图/重命名/删除、Markdown 记忆编辑/历史 diff/原文搜索/整理任务、QQ 会话绑定、结构化插件配置。Roleplay 页面本身也已迁移到 iframe。
- Roleplay 页面只在插件加载成功后出现在侧边栏；插件失败时在“插件”页显示错误和配置入口。

安全边界：

- 默认 `admin.allow_remote: false`，非 loopback 请求会被拒绝。
- 管理员密码用 scrypt 哈希存入 SQLite；浏览器只保留 HttpOnly session cookie。
- 所有写操作要求 CSRF token 和同源 Origin 校验。
- WebUI 只在“设置 → 连接”页或插件自己的管理页写入受控的 `.env` 键（NapCat URL/Token、Jev API Key）；插件密钥接口只允许写入该插件 options 已引用的环境变量名，不在前端回显密钥。
- 如果确实需要局域网访问，请显式开启 `admin.allow_remote`，并放在 TLS 反向代理后。

### 连接与密钥

`/admin` →「设置」→「连接」可以：

- 查看 NapCat WebSocket 连接状态、Bot QQ、最后连接/事件和错误。
- 修改 NapCat WebSocket URL 和 Access Token；保存到 `config/.env`，需要重启 bridge 后生效。URL 不要带 token/query，Token 单独填写。
- 配置 Roleplay 的 Jev API Key、Base URL、Endpoint 和模型；Key 写入 `.env`，其余写入 Roleplay 插件配置，保存后会自动重载 Roleplay 插件。
- 密钥字段始终是 write-only，留空表示保持现有值。

NapCat 的进程/容器保活由 Docker `restart: unless-stopped` 和 `deploy/systemd/opencode-qq.service` 的 `Restart=always` 负责；bridge 的 OneBot SDK 也会自动重连。QQ 登录态失效时 HTTP `get_login_info` 会失败，WebUI 会显示“QQ 登录态失效”，这需要你到 NapCat WebUI 重新扫码或快速登录，不能靠自动重启绕过。

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
pnpm run setup -- --force
pnpm dev
```

`pnpm run setup` / `pnpm start` 使用仓库内的 `config/config.yaml` 和 `config/.env`；不要同时用全局 `opencode-qq setup` 写出的 `~/.config/opencode-qq/config.yaml`，否则容易启动到另一份配置。

首次 setup 会询问管理员密码，留空则自动生成；已有数据库默认重置并显示新密码，也可以显式选择保留。existing NapCat 模式会先探测 WebSocket 和 Token，失败时可重试，避免启动后才发现 Token 不匹配。

管理前端是 `packages/webui` 下的 Vite + React + shadcn/ui SPA：

```bash
pnpm dev:webui       # fixture backend + Vite HMR，http://127.0.0.1:5173/admin/
pnpm webui dev       # 同上，别名
pnpm dev:webui --real # 真实 bridge(:8787) + Vite HMR
pnpm dev:ui          # 只启动 Vite，/admin/api 代理到 8787
pnpm dev:fixture     # 只启动隔离 fixture（构建后的 UI，给 Playwright/手动看）
pnpm build:webui     # 构建到 dist/admin，由 bridge 的 Hono 托管
pnpm build           # SDK、WebUI、插件 UI、与 server 全量构建
pnpm test:e2e        # 构建后用 Playwright 跑插件 iframe / Roleplay 世界书测试
```

`pnpm dev:webui` 默认使用隔离的临时数据、fake OneBot/OpenCode 和真实 Roleplay 插件，不会碰生产数据库；密码默认 `webui-test-password`，后端固定 `8790`，Vite `5173`。`pnpm dev` 只是真实 backend 的 watch 模式，不会启动前端 dev server。

`pnpm run setup` 使用仓库内的 `config/config.yaml`，方便开发时直接修改。也可以手动编辑：

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

QQ 插件由 YAML 的 `plugins` 段显式启用，YAML 仍是唯一配置源。插件是以 bridge 进程权限运行的可信代码，没有沙箱；QQ 消息永远不能安装或加载插件。管理员可以通过 WebUI 插件页上传 ZIP 或注册本地目录，WebUI 只负责校验、托管代码和写入 YAML。

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

### WebUI 安装插件

打开 `/admin` →「插件」→「安装插件」，可以：

- **上传 ZIP**：导入已构建、自包含的插件包。
- **注册本地目录**：用于开发调试，只写 YAML，不复制代码；修改代码后在插件卡片菜单点「重新加载代码」。
- **安装后启用**：预览时默认开启，也可以只安装、稍后手动启用。
- **更新 / 回滚**：相同插件 ID 上传新版本会保留上一版本，最多保留 3 个备份。
- **卸载**：删除 YAML 配置、WebUI 托管的代码和该插件的托管备份；插件数据默认保留，可勾选同时删除。

上传 ZIP 的推荐结构：

```text
my-plugin.zip
├── package.json          # 必须包含 opencodeQq manifest
├── dist/index.js         # 已构建的 ESM 入口
└── ui/index.html         # 可选，插件管理页
```

上传包要求：

- `package.json.opencodeQq` 必须存在，并包含合法的 `id`、`version`、`apiVersion`、`entry`。
- 入口必须是 `.js` / `.mjs` / `.cjs`；上传包应自行 bundle 运行时依赖，WebUI 不执行 `npm install`、构建或安装脚本。
- 本地目录模式可以使用 TypeScript，依赖由本地 `node_modules` 提供。
- ZIP 最大 20 MiB；解压后最大 64 MiB、2000 个文件（最多 4000 个归档条目）；拒绝路径穿越、反斜杠、绝对路径、符号链接和特殊文件。

WebUI 托管的代码位于 `storage.plugins_dir/.managed/<plugin-id>/`，插件数据仍在 `storage.plugins_dir/<plugin-id>/`。安装、更新、回滚、卸载和重新加载都会写入审计日志。

插件可以声明并使用这些能力：

| 能力 | 用途 |
| --- | --- |
| `commands` | 注册 `!command`，核心统一做用户/角色/群模式检查 |
| `hooks` | `beforePrompt`、`afterRun`、`onConfigReload` |
| `messages` | 发送文本、图片、文件（受数据目录和大小限制） |
| `sessions` | 只读查看当前会话绑定 |
| `events` | 订阅 `run.finished` / `config.reloaded` |
| `admin` | 插件管理 API、原生页面或 iframe 页面（`@opencode-qq/plugin-ui`） |

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

第三方 iframe 页面在 `package.json` 的 `opencodeQq.ui` 声明静态目录，并注册 `kind: "iframe"`：

```json
{
  "opencodeQq": {
    "ui": { "root": "ui", "entry": "index.html" }
  }
}
```

```ts
context.admin.page({ id: "overview", title: "My Plugin", kind: "iframe" });
```

页面侧使用 `@opencode-qq/plugin-ui`：

```ts
import { connectPluginUi } from "@opencode-qq/plugin-ui";

const bridge = await connectPluginUi();
const summary = await bridge.api.get("/summary");
await bridge.ui.toast("已保存", "success");
```

静态资源由核心通过短时签名 URL 托管；iframe 没有 cookie、`localStorage` 和直接网络访问，所有 API 请求由父页面注入 CSRF 并限制在当前插件前缀内。完整示例见 [`examples/ui-plugin`](examples/ui-plugin)。

示例位于 [`examples/`](examples)，SDK 源码和文档位于 [`packages/plugin-sdk`](packages/plugin-sdk)，浏览器 bridge 位于 [`packages/plugin-ui`](packages/plugin-ui)。开发流程：

```bash
pnpm install
pnpm build:sdk
pnpm typecheck:examples
pnpm test
```

如果要通过 WebUI 分发插件，先构建并 bundle，再把 `package.json`、`dist/`、可选的 `ui/` 打进 ZIP。示例：

```bash
cd my-plugin
pnpm build
zip -r ../my-plugin-0.1.0.zip package.json dist ui
```

插件加载失败只会标记该插件为 `failed`，不会影响核心和其它插件；发送 `!plugins` 或打开 `/admin` 的「插件」页可以查看错误。

## Roleplay（实验）

`packages/roleplay` 提供角色扮演：导入 Character Card V2/V3、按角色目录运行 OpenCode、注入世界书与 Markdown 长期记忆、把回复拆成多条短消息并加打字延迟。

当前 0.4.1 能力：

- 私聊 + 群聊；核心群聊是零配置的每人独立会话，每个成员各自绑定角色、各自维护记忆；
- 长期记忆是一份可读、可手改的 `memory.md`，原文保存在 SQLite 供 FTS5 检索；
- 后台 consolidation：隐藏的 `qq-rp-utility` 临时 session，工具全 deny，按 section 级 JSON 操作更新 MD；
- `memory_events` 记录每次 consolidate/manual_add/manual_delete，`history/` 保留最近版本；
- 触发条件是每 N 轮或 idle debounce，不再使用硬编码的“记忆关键词”正则；
- `!remember` 写入手动记忆，`!memory diff|history|search|refresh`，`!forget section|confirm`；
- 中文原文检索使用 FTS5 trigram OR 查询 + 短查询 LIKE 回退；
- 群聊记忆详情私聊发送；
- 世界书 lite：常驻/关键词/次关键词、默认 1 轮额外递归、按 entry 的 ASCII 整词匹配、`!worldbook check <text>` 调试；
- 表情包：`dataDir/stickers/<persona>/<emotion>/`，每条回复最多 1 张；`sticker_judge: jev` 用 Jev 对当前对话做情绪分类；`hybrid`/`tag` 模式仍支持 `[emotion:xxx]` 标签，失败自动降级为纯文本；Jev Base URL / API Key / 模型可在 Roleplay 设置页配置，并提供“测试连接”健康检查；
- 角色扮演引擎不再设置 `steps: 1`，避免 OpenCode 在 final step 注入 max-steps 提示导致模型输出元叙述；回复还会经过一层 meta guard；
- 通用记忆基础设施抽到 `@opencode-qq/memory`（transcript/FTS、Markdown 文档、retrieval）；roleplay 只保留 persona/scope/section/prompt 策略。

仍不在本阶段：

- 主动消息、群聊旁听、多角色同场、TTS；
- 向量/embedding 检索和外部记忆服务；
- 时间段开场白、备选开场白轮换。

配置片段见 [`config/roleplay.example.yaml`](config/roleplay.example.yaml)，完整说明见 [`packages/roleplay/README.md`](packages/roleplay/README.md)。

从源码安装：

```bash
pnpm build:sdk
pnpm build:memory
pnpm build:roleplay
mkdir -p ~/.local/share/opencode-qq/plugins/roleplay/personas
```

使用 setup 向导启用（会创建 hidden 的 roleplay 项目、插件、personas 目录和 `security.allowed_roots`）：

```bash
opencode-qq setup --with-roleplay \
  --roleplay-path /path/to/opencode-qq-adapter/packages/roleplay \
  --roleplay-personas ~/.local/share/opencode-qq/plugins/roleplay/personas \
  --yes
```

已有配置可以合并而不丢注释和自定义项目：

```bash
opencode-qq setup --with-roleplay --reconfigure --yes
```

在 `config.yaml` 中增加 `projects.roleplay`（`hidden: true`）和 `plugins.roleplay` 后：

```text
!card import /path/to/card.png blue-fat-fish
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
| `!whoami` | 显示 QQ、角色、群号、chatKey、可用项目和可修改项目 |
| `!projects` | 列出可用项目，并标记「可修改 / 只读问答」 |
| `!use <项目>` / `!cd <项目>` | 切换项目并重置会话 |
| `!new` | 清除当前会话，保留模型/agent 偏好 |
| `!status` | OneBot / OpenCode / 项目 / 工作区锁 / 会话 / 运行状态 |
| `!sessions` | 列出当前项目最近 20 个 OpenCode 会话 |
| `!switch <ID前缀>` | 恢复指定会话 |
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
| `!reload` | 热加载配置（owner/admin，仅私聊） |
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

群聊不需要任何配置。只要发送者在 `users` 中，私聊和群聊都按同一套权限执行；同一个人在任意群里的权限相同。

- 群内默认每个成员一个独立 Conversation（`group:<群号>:<QQ>`）。
- 非命令消息是否必须 @bot 由全局 `security.require_mention_in_group` 控制。
- 未在 `users` 中的 QQ 在群里发消息会被静默忽略，只写审计。
- workspace 仍按项目共享；需要独立目录时请使用独立的 `projects.<id>.path`。

## 权限与审批

权限完全由用户配置决定，不再有 project/group/user 三层策略合并：

```yaml
users:
  "10001":
    role: owner          # owner | admin | member
    projects: ["*"]      # 可访问项目，* 表示所有可见项目
    write_projects: ["*"] # 可修改项目；未列出的项目只能问答

  "10002":
    role: member
    projects: ["demo"]
    write_projects: []    # 只能问答，写入直接返回无权限
```

生成规则：

- 没有任何可用项目时，bridge 会自动进入内置的 `@chat` 问答模式；也可以发送 `!use @chat` 手动进入。该模式使用独立的空目录，只允许 `read/glob/grep`（以及按配置允许的 `webfetch/websearch`），拒绝 `edit/shell/execute/external_directory/question/subagent`，不会读写任何项目文件。
- 项目在 `projects` 中但不在 `write_projects`：`read/glob/grep/webfetch/websearch` 允许；`edit/shell/external_directory` 直接拒绝，不会发审批。
- 项目在 `write_projects` 中：`edit` 允许；`shell` 默认需要 QQ 审批；项目外目录仍然拒绝。
- `hidden: true` 的插件内部项目不会出现在 `!projects`、默认项目下拉和成员项目选择中，只能由插件内部切换。
- `security.shell_rules` 可以进一步允许安全的只读命令或拒绝危险命令；规则最后匹配，写在 `security` 下：

```yaml
security:
  shell_rules:
    - pattern: "git status *"
      effect: allow
    - pattern: "sudo *"
      effect: deny
```

当 OpenCode 触发 `permission.asked`（例如可修改项目里的 shell 命令）：

1. bridge 发送 QQ 审批消息
2. 用户回复 `1` / `2` / `3`，或引用审批消息回复
3. bridge 调用 `permission.reply`
4. 超时默认 120 秒自动拒绝
5. `!stop` 会拒绝当前会话所有待审批请求

审批人规则：

- 发起该 run 的本人，或 owner/admin。
- 不再区分私聊/群聊，也不再有群 allowlist。

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
- 一个用户只有一个可用项目时自动选择；多个项目使用 `default_project` 或 `!use`；没有任何项目权限时自动回退到 `@chat` 问答模式。

热加载：

- 私聊 owner 发送 `!reload`，或给进程发送 `SIGHUP`。
- 立即生效：`users`、`projects`、`plugins`、`security`、`chat`、`admin`（除 `enabled`）、`features`、`qq`、`workspaces`、`opencode` 的模型/超时字段。
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
opencode-qq setup --with-roleplay --reconfigure   # 在已有配置上启用/更新 Roleplay
opencode-qq start                          # 启动 bridge
opencode-qq doctor                         # 检查配置、SQLite、OpenCode、OneBot
opencode-qq config validate                # 校验配置和项目目录
opencode-qq admin reset-password           # 重置 WebUI 管理员密码并踢出旧会话

pnpm dev                                   # 真实 backend，tsx watch
pnpm dev:webui                             # fixture backend + Vite HMR（推荐）
pnpm dev:fixture                           # 隔离 fixture（无 HMR）
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
- 未授权用户默认静默忽略；群聊不需要 allowlist，已授权用户在任何群按同一权限使用。
- 权限边界落在 OpenCode permission ruleset，不依赖 prompt；只读项目的写入直接 deny，不进入审批。
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
  admin/                /admin API、鉴权、配置/Agents 编辑
  plugins/              QQ 插件 SDK、manifest、宿主、安装器、媒体/存储 API
  internal-http/        Hono HTTP
packages/plugin-sdk/    @opencode-qq/plugin-sdk
packages/plugin-ui/     @opencode-qq/plugin-ui（iframe bridge 客户端）
packages/memory/         @opencode-qq/memory（通用记忆基础设施）
packages/roleplay/       @opencode-qq/roleplay（角色扮演 + 独立 iframe UI，实验）
packages/webui/         Vite + React + shadcn/ui 管理前端
examples/               示例 QQ 插件（hello / notes / media-demo / ui-demo）
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
