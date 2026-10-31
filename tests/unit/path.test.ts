import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside as isRoleplayPathInside } from "../../packages/roleplay/src/path.js";
import { isPathInside } from "../../src/util/path.js";

const roots = [
  ["core", isPathInside],
  ["roleplay", isRoleplayPathInside],
] as const;

describe.each(roots)("%s path containment", (_name, contains) => {
  it("allows the root by default", () => {
    expect(contains("/tmp/project", "/tmp/project")).toBe(true);
    expect(contains("/tmp/project", "/tmp/project/src/index.ts")).toBe(true);
  });

  it("can reject the root explicitly", () => {
    expect(contains("/tmp/project", "/tmp/project", { allowRoot: false })).toBe(false);
    expect(contains("/tmp/project", "/tmp/project/src", { allowRoot: false })).toBe(true);
  });

  it("rejects siblings and parent traversal", () => {
    expect(contains("/tmp/project", "/tmp/project-other/file")).toBe(false);
    expect(contains("/tmp/project", "/tmp")).toBe(false);
    expect(contains("/tmp/project", join("/tmp/project", "..", "secret"))).toBe(false);
  });
});
