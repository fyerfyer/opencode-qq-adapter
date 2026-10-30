import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPackage } from "../../src/plugins/install/package.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.reverse()) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qq-plugin-package-"));
  dirs.push(dir);
  return dir;
}

interface PackageOptions {
  files?: Record<string, string>;
  packageJson?: Record<string, unknown>;
  withIndex?: boolean;
}

async function packageDir(
  manifest: Record<string, unknown> | null,
  options: PackageOptions = {},
): Promise<string> {
  const root = await tempDir();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "0.1.0",
      type: "module",
      ...(manifest === null ? {} : { opencodeQq: manifest }),
      ...options.packageJson,
    }),
    "utf8",
  );
  if (options.withIndex !== false) {
    await writeFile(join(root, "index.js"), "export default { setup() {} };", "utf8");
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  return root;
}

const baseManifest = {
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  apiVersion: 2,
  capabilities: ["commands"],
  entry: "./index.js",
};

const context = { coreVersion: "0.2.0", source: "upload" as const };

describe("inspectPackage", () => {
  it("returns a normalized manifest and entry", async () => {
    const root = await packageDir(baseManifest);
    const result = await inspectPackage(root, context);
    expect(result.manifest).toMatchObject({ id: "demo", version: "0.1.0", entry: "./index.js" });
    expect(result.entry).toBe("index.js");
    expect(result.packageName).toBe("demo");
    expect(result.ui).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.files).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);

    const supplied = await inspectPackage(root, { ...context, files: 9, bytes: 99 });
    expect(supplied).toMatchObject({ files: 9, bytes: 99 });
  });

  it("rejects a missing manifest", async () => {
    const root = await packageDir(null);
    await expect(inspectPackage(root, context)).rejects.toMatchObject({
      status: 400,
      code: "package_invalid",
      message: expect.stringMatching(/manifest/i),
    });

    const empty = await tempDir();
    await expect(inspectPackage(empty, context)).rejects.toThrow(/package\.json/i);
  });

  it("rejects a missing entry and an entry outside the package root", async () => {
    const missing = await packageDir(
      { ...baseManifest, entry: "./missing.js" },
      { withIndex: false },
    );
    await expect(inspectPackage(missing, context)).rejects.toMatchObject({
      status: 400,
      code: "package_invalid",
      message: expect.stringMatching(/entry/i),
    });

    const parent = await tempDir();
    const root = join(parent, "plugin");
    await mkdir(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        version: "0.1.0",
        type: "module",
        opencodeQq: { ...baseManifest, entry: "../outside.js" },
      }),
      "utf8",
    );
    await writeFile(join(root, "index.js"), "export default { setup() {} };", "utf8");
    await writeFile(join(parent, "outside.js"), "export default { setup() {} };", "utf8");
    await expect(inspectPackage(root, context)).rejects.toMatchObject({
      status: 400,
      code: "package_invalid",
      message: expect.stringMatching(/escapes package root/i),
    });
  });

  it("rejects an incompatible engine range", async () => {
    const root = await packageDir({
      ...baseManifest,
      engines: { opencodeQq: ">=9.0.0" },
    });
    await expect(inspectPackage(root, context)).rejects.toMatchObject({
      status: 400,
      code: "package_invalid",
      message: expect.stringMatching(/requires opencode-qq/i),
    });
  });

  it("validates the optional UI root and entry", async () => {
    const root = await packageDir(
      { ...baseManifest, ui: { root: "ui", entry: "index.html" } },
      { files: { "ui/index.html": "<html></html>" } },
    );
    const result = await inspectPackage(root, context);
    expect(result.ui).toEqual({ root: "ui", entry: "index.html" });

    const noEntry = await packageDir(
      { ...baseManifest, ui: { root: "ui" } },
      { files: { "ui/index.html": "<html></html>" } },
    );
    expect((await inspectPackage(noEntry, context)).ui).toEqual({ root: "ui", entry: null });

    const missingRoot = await packageDir({ ...baseManifest, ui: { root: "ui" } });
    await expect(inspectPackage(missingRoot, context)).rejects.toThrow(/ui\.root/i);

    const missingEntry = await packageDir(
      { ...baseManifest, ui: { root: "ui", entry: "index.html" } },
      { files: { "ui/other.html": "<html></html>" } },
    );
    await expect(inspectPackage(missingEntry, context)).rejects.toThrow(/ui\.entry/i);
  });

  it("warns about runtime dependencies and non-module packages", async () => {
    const root = await packageDir(baseManifest, {
      packageJson: {
        type: "commonjs",
        dependencies: { "better-sqlite3": "^12.0.0" },
      },
    });
    const result = await inspectPackage(root, context);
    const warnings = result.warnings.join("\n");
    expect(warnings).toMatch(/runtime dependencies/i);
    expect(warnings).toMatch(/not an ESM \.mjs/i);
  });

  it("rejects a TypeScript entry for uploads but allows it for local packages", async () => {
    const root = await packageDir(
      { ...baseManifest, entry: "./index.ts" },
      { files: { "index.ts": "export default { setup() {} };" } },
    );
    await expect(inspectPackage(root, context)).rejects.toMatchObject({
      status: 400,
      code: "package_invalid",
      message: expect.stringMatching(/JavaScript/i),
    });

    const local = await inspectPackage(root, { ...context, source: "local" });
    expect(local.entry).toBe("index.ts");
  });
});
