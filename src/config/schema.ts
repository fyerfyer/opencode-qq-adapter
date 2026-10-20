import { z } from "zod";

const effectSchema = z.enum(["allow", "ask", "deny"]);

const shellRuleSchema = z
  .object({
    pattern: z.string().min(1),
    effect: effectSchema,
  })
  .strict();

const policySchema = z
  .object({
    read: effectSchema.optional(),
    glob: effectSchema.optional(),
    grep: effectSchema.optional(),
    edit: effectSchema.optional(),
    write: effectSchema.optional(),
    shell: effectSchema.optional(),
    webfetch: effectSchema.optional(),
    websearch: effectSchema.optional(),
    external_directory: effectSchema.optional(),
    shell_rules: z.array(shellRuleSchema).default([]),
  })
  .strict();

const limitsSchema = z
  .object({
    prompts_per_minute: z.number().int().positive().optional(),
    runs_per_hour: z.number().int().positive().optional(),
    daily_cost_usd: z.number().nonnegative().optional(),
    daily_tokens: z.number().int().positive().optional(),
  })
  .strict()
  .prefault({});

const userSchema = z
  .object({
    role: z.enum(["owner", "admin", "member"]).default("member"),
    projects: z.array(z.string().min(1)).default(["*"]),
    policy: z.string().min(1).optional(),
    limits: limitsSchema,
    note: z.string().optional(),
  })
  .strict();

const groupSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["per_user", "shared", "readonly"]).default("per_user"),
    require_mention: z.boolean().optional(),
    allowed_users: z.array(z.string().min(1)).default([]),
    projects: z.array(z.string().min(1)).default(["*"]),
    default_project: z.string().min(1).optional(),
    policy: z.string().min(1).optional(),
  })
  .strict();

const projectSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().optional(),
    policy: z.string().min(1).default("standard"),
    workspace: z.enum(["shared", "per_user", "worktree"]).default("shared"),
    agent: z.string().min(1).nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    allowed_users: z.array(z.string().min(1)).optional(),
    allowed_groups: z.array(z.string().min(1)).optional(),
    setup: z.array(z.string().min(1)).default([]),
    base_branch: z.string().min(1).nullable().default(null),
  })
  .strict();

const rateLimitSchema = z
  .object({
    prompts_per_minute: z.number().int().positive().optional(),
    runs_per_hour: z.number().int().positive().optional(),
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

const securitySchema = z
  .object({
    default_effect: effectSchema.default("deny"),
    allowed_roots: z.array(z.string().min(1)).default([]),
    require_mention_in_group: z.boolean().default(true),
    max_prompt_chars: z.number().int().positive().default(8000),
    max_images_per_message: z.number().int().nonnegative().default(4),
    max_image_bytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    max_queued_prompts: z.number().int().nonnegative().default(3),
    rate_limit: rateLimitSchema,
    budgets: budgetsSchema,
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
    files: z.boolean().default(false),
    worktrees: z.boolean().default(false),
    forms: z.boolean().default(false),
    metrics: z.boolean().default(false),
  })
  .strict()
  .prefault({});

const qqSchema = z
  .object({
    max_message_chars: z.number().int().min(200).max(5000).default(1800),
    strip_markdown: z.boolean().default(true),
    reply_to_message: z.boolean().default(true),
    mention_sender_in_group: z.boolean().default(true),
  })
  .strict()
  .prefault({});

const storageSchema = z
  .object({
    database_path: z.string().min(1).default("var/opencode-qq.db"),
    inbox_dir: z.string().min(1).default("var/inbox"),
  })
  .strict()
  .prefault({});

const workspacesSchema = z
  .object({
    default_mode: z.enum(["shared", "per_user", "worktree"]).default("shared"),
    root: z.string().min(1).default("var/workspaces"),
    idle_ttl_hours: z.number().int().positive().default(72),
    max_per_project: z.number().int().positive().default(5),
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

export const configSchema = z
  .object({
    version: z.literal(1),
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
    default_project: z.string().min(1).nullable().default(null),
    users: z
      .record(z.string().regex(/^\d+$/, "user IDs must be numeric QQ numbers"), userSchema)
      .prefault({}),
    groups: z
      .record(z.string().regex(/^\d+$/, "group IDs must be numeric QQ numbers"), groupSchema)
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
    policies: z.record(z.string().min(1), policySchema).prefault({}),
    workspaces: workspacesSchema,
    logging: loggingSchema,
    features: featuresSchema,
    qq: qqSchema,
    storage: storageSchema,
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type GroupConfig = z.infer<typeof groupSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type PermissionEffect = z.infer<typeof effectSchema>;
