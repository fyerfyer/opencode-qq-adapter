import { z } from "zod";

const effectSchema = z.enum(["allow", "ask", "deny"]);

const shellRuleSchema = z
  .object({
    pattern: z.string().min(1),
    effect: effectSchema,
  })
  .strict();

export const limitsSchema = z
  .object({
    /** @deprecated Frequency limiting is hourly only. Accepted for v2 configs. */
    prompts_per_minute: z.number().int().positive().optional(),
    /** Hourly request cap. `null` disables the cap; omitted inherits the global default. */
    runs_per_hour: z.number().int().positive().nullable().optional(),
    daily_cost_usd: z.number().nonnegative().optional(),
    daily_tokens: z.number().int().positive().optional(),
  })
  .strict()
  .prefault({});

export const userSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]).default("member"),
    /** Projects this user may talk to. `*` grants every visible project. */
    projects: z.array(z.string().min(1)).default([]),
    /** Subset of `projects` this user may modify; unlisted projects stay read-only. */
    write_projects: z.array(z.string().min(1)).default([]),
    limits: limitsSchema,
    note: z.string().optional(),
  })
  .strict();

export const projectSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().optional(),
    workspace: z.enum(["shared", "per_user", "worktree", "none"]).default("shared"),
    agent: z.string().min(1).nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    setup: z.array(z.string().min(1)).default([]),
    base_branch: z.string().min(1).nullable().default(null),
    /** Internal projects (for example a plugin workspace) stay out of user UI. */
    hidden: z.boolean().default(false),
    /** Audit/UI label for projects created by a plugin, e.g. `roleplay`. */
    managed_by: z.string().min(1).optional(),
  })
  .strict();

const rateLimitSchema = z
  .object({
    /** @deprecated Frequency limiting is hourly only. Accepted for v2 configs. */
    prompts_per_minute: z.number().int().positive().optional(),
    /** Default hourly request cap for users without their own limit. */
    runs_per_hour: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .prefault({});

const budgetsSchema = z
  .object({
    daily_cost_usd_per_user: z.number().nonnegative().optional(),
    daily_tokens_per_user: z.number().int().positive().optional(),
    daily_cost_usd_per_project: z.number().nonnegative().optional(),
  })
  .strict()
  .prefault({});

const admin2faSchema = z
  .object({
    enabled: z.boolean().default(false),
    totp_secret: z.string().default(""),
    window_seconds: z.number().int().min(30).default(300),
    period_seconds: z.number().int().min(10).max(300).default(30),
    digits: z.number().int().min(6).max(8).default(6),
  })
  .strict()
  .prefault({});

const securitySchema = z
  .object({
    allowed_roots: z.array(z.string().min(1)).default([]),
    require_mention_in_group: z.boolean().default(true),
    /** Extra allow/ask/deny rules for shell commands in writable projects. */
    shell_rules: z.array(shellRuleSchema).default([]),
    max_prompt_chars: z.number().int().positive().default(8000),
    max_images_per_message: z.number().int().nonnegative().default(4),
    max_image_bytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    max_outbound_image_bytes: z
      .number()
      .int()
      .positive()
      .default(20 * 1024 * 1024),
    max_outbound_file_bytes: z
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    max_queued_prompts: z.number().int().nonnegative().default(3),
    /** Allow inbound image URLs that resolve to loopback/private addresses. */
    allow_private_image_urls: z.boolean().default(false),
    rate_limit: rateLimitSchema,
    budgets: budgetsSchema,
    admin_2fa: admin2faSchema,
  })
  .strict()
  .prefault({});

const onebotReconnectSchema = z
  .object({
    enabled: z.boolean().default(true),
    attempts: z.number().int().positive().default(1_000_000),
    delay_ms: z.number().int().min(100).default(3000),
  })
  .strict()
  .prefault({});

const onebotSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (value) => value.startsWith("ws://") || value.startsWith("wss://"),
        "onebot.url must start with ws:// or wss://",
      ),
    access_token: z.string().default(""),
    self_id: z.number().int().positive().optional(),
    action_timeout_ms: z.number().int().min(1000).default(15000),
    upload_timeout_ms: z
      .number()
      .int()
      .min(1000)
      .default(10 * 60 * 1000),
    /** Probe get_login_info at this interval; 0 disables. */
    login_probe_ms: z.number().int().min(0).default(60_000),
    dedupe_ttl_ms: z
      .number()
      .int()
      .min(1000)
      .default(10 * 60 * 1000),
    reconnect: onebotReconnectSchema,
  })
  .strict();

const opencodeServiceSchema = z
  .object({
    mode: z.enum(["external", "ensure", "off"]).default("external"),
    base_url: z.string().url().nullable().default(null),
    username: z.string().default(""),
    password: z.string().default(""),
    version: z.string().min(1).nullable().default(">=2.0.0 <3.0.0"),
    command: z.array(z.string().min(1)).default(["opencode", "serve", "--service"]),
    manage_lifecycle: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "off" && !value.base_url) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "opencode.service.base_url is required when mode is off",
      });
    }
  })
  .prefault({});

const opencodeSchema = z
  .object({
    service: opencodeServiceSchema,
    default_agent: z.string().min(1).nullable().default(null),
    default_model: z.string().min(1).nullable().default(null),
    prompt_timeout_ms: z
      .number()
      .int()
      .min(1000)
      .default(30 * 60 * 1000),
    permission_timeout_ms: z
      .number()
      .int()
      .min(1000)
      .default(120 * 1000),
    event_reconnect_ms: z.number().int().min(100).default(2000),
    event_reconnect_max_ms: z.number().int().min(100).default(30000),
    health_cache_ms: z.number().int().min(0).default(5000),
  })
  .strict()
  .prefault({});

const loggingSchema = z
  .object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
    audit_retention_days: z.number().int().positive().default(90),
    store_prompt_content: z.boolean().default(false),
    redact: z.array(z.string()).default([]),
    pretty: z.boolean().optional(),
  })
  .strict()
  .prefault({});

const featuresSchema = z
  .object({
    images: z.boolean().default(true),
    files: z.boolean().default(true),
    worktrees: z.boolean().default(false),
    forms: z.boolean().default(false),
    metrics: z.boolean().default(false),
  })
  .strict()
  .prefault({});

const chatSchema = z
  .object({
    /** Enable the built-in project-less Q&A mode. */
    enabled: z.boolean().default(true),
    /** Dedicated empty workspace; defaults to <database dir>/chat. */
    path: z.string().min(1).nullable().default(null),
    agent: z.string().min(1).nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    /** Allow web search/fetch in chat mode. File and shell tools stay denied. */
    allow_web: z.boolean().default(true),
  })
  .strict()
  .prefault({});

const qqSchema = z
  .object({
    max_message_chars: z.number().int().min(200).max(5000).default(1800),
    max_reply_images: z.number().int().min(0).max(4).default(2),
    strip_markdown: z.boolean().default(true),
    reply_to_message: z.boolean().default(true),
    mention_sender_in_group: z.boolean().default(true),
    /** Send a short "working" message for runs that exceed progress_delay_ms. */
    progress_ack: z.boolean().default(false),
    progress_delay_ms: z.number().int().min(0).max(600000).default(3000),
    /** Refresh the transient progress message at this interval; 0 disables. */
    progress_interval_ms: z.number().int().min(0).max(600000).default(30000),
  })
  .strict()
  .prefault({});

const storageSchema = z
  .object({
    database_path: z.string().min(1).default("var/opencode-qq.db"),
    inbox_dir: z.string().min(1).default("var/inbox"),
    /** Per-plugin persistent data directories live under this root. */
    plugins_dir: z.string().min(1).default("var/plugins"),
    /** Delete downloaded inbound images that were not used after this many hours. */
    inbox_ttl_hours: z.number().int().positive().default(24),
  })
  .strict()
  .prefault({});

export const pluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** npm package name; mutually exclusive with `path`. */
    package: z.string().min(1).optional(),
    /** Local package/directory/file; resolved relative to the config file. */
    path: z.string().min(1).optional(),
    /** Plugin-owned options, validated by the plugin's options schema. */
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.package === undefined) === (value.path === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["package"],
        message: "exactly one of package or path is required",
      });
    }
  });

export const pluginsSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/, "plugin IDs must be lowercase letters, digits or dashes"),
    pluginConfigSchema,
  )
  .prefault({});

const workspacesSchema = z
  .object({
    default_mode: z.enum(["shared", "per_user", "worktree"]).default("shared"),
    root: z.string().min(1).default("var/workspaces"),
    idle_ttl_hours: z.number().int().positive().default(72),
    max_per_project: z.number().int().positive().default(5),
    /** How long a workspace lock survives without a renewal. */
    lock_lease_ms: z.number().int().min(5000).default(120_000),
    /** How often long-running runs renew their workspace lease. */
    renew_interval_ms: z.number().int().min(1000).default(30_000),
    cleanup: z
      .object({
        require_clean: z.boolean().default(true),
        keep_dirty_days: z.number().int().positive().default(7),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

const notificationsSchema = z
  .object({
    owner_alerts: z
      .object({
        enabled: z.boolean().default(true),
        on_startup: z.boolean().default(false),
        on_run_failure: z.boolean().default(true),
        on_budget_exceeded: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export const adminSchema = z
  .object({
    /** Serve the local management UI at /admin on the internal HTTP server. */
    enabled: z.boolean().default(true),
    /** Refuse non-loopback clients unless explicitly enabled. */
    allow_remote: z.boolean().default(false),
    /** Trust X-Forwarded-For / X-Forwarded-Proto when behind a local reverse proxy. */
    trust_proxy: z.boolean().default(false),
    session_hours: z.number().int().min(1).max(720).default(12),
    /** Failed login attempts allowed per client IP in a five-minute window. */
    login_attempts: z.number().int().min(1).max(100).default(5),
  })
  .strict()
  .prefault({});

const configObjectSchema = z
  .object({
    version: z.literal(2),
    server: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(8787),
        health_path: z.string().startsWith("/").default("/health"),
        internal_token: z.string().default(""),
      })
      .strict()
      .prefault({}),
    onebot: onebotSchema,
    opencode: opencodeSchema,
    security: securitySchema,
    chat: chatSchema,
    default_project: z.string().min(1).nullable().default(null),
    users: z
      .record(z.string().regex(/^\d+$/, "user IDs must be numeric QQ numbers"), userSchema)
      .prefault({}),
    projects: z
      .record(
        z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z0-9._-]+$/,
            "project IDs may only contain letters, numbers, dot, dash and underscore",
          ),
        projectSchema,
      )
      .prefault({}),
    plugins: pluginsSchema,
    workspaces: workspacesSchema,
    notifications: notificationsSchema,
    admin: adminSchema,
    logging: loggingSchema,
    features: featuresSchema,
    qq: qqSchema,
    storage: storageSchema,
  })
  .strict();

/**
 * Base V2 configuration. The built-in @chat project is materialized after
 * storage paths are resolved; keeping it in the project map lets the existing
 * session/workspace/audit/quota code paths work unchanged.
 */
export const configSchema = configObjectSchema;

export type AppConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PermissionEffect = z.infer<typeof effectSchema>;
export type ShellRuleConfig = z.infer<typeof shellRuleSchema>;
