/**
 * Architecture guardrails.
 *
 * Core must stay independent from optional runtime packages, and optional
 * packages must never reach back into core implementation files.
 */
module.exports = {
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(dist|coverage|node_modules|tests/fixtures)/",
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
  forbidden: [
    {
      name: "core-no-optional-packages",
      comment: "src/ must not import the optional memory or roleplay packages.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^packages/(memory|roleplay)/" },
    },
    {
      name: "core-no-optional-node-modules",
      comment: "Workspace links must not hide core -> optional package imports.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "node_modules/@opencode-qq/(memory|roleplay)/" },
    },
    {
      name: "memory-no-core-or-roleplay",
      comment: "@opencode-qq/memory is a library and must stay independent.",
      severity: "error",
      from: { path: "^packages/memory/" },
      to: { path: "^(src|packages/roleplay)/" },
    },
    {
      name: "roleplay-no-core",
      comment: "Roleplay may depend on plugin-sdk and memory, never on core internals.",
      severity: "error",
      from: { path: "^packages/roleplay/" },
      to: { path: "^src/" },
    },
    {
      name: "sdk-no-core-impl",
      comment: "The SDK contract must not depend on core implementation files.",
      severity: "error",
      from: { path: "^packages/plugin-sdk/" },
      to: { path: "^src/(?!plugins/(sdk|storage|testing|ui-protocol)\\.ts$)" },
    },
    {
      name: "sdk-no-optional-packages",
      comment: "The SDK contract must not depend on optional runtime packages.",
      severity: "error",
      from: { path: "^packages/plugin-sdk/" },
      to: { path: "^packages/(memory|roleplay)/" },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies make module boundaries and tests fragile.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
};
