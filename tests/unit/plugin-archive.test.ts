import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZip } from "../../src/plugins/install/archive.js";
import { makeZip } from "../helpers/zip.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.reverse()) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qq-plugin-zip-"));
  dirs.push(dir);
  return dir;
}

const packageJson = JSON.stringify({ name: "x", version: "0.1.0", type: "module" });

/** Rewrite an entry name in both the local header and central directory. */
function renameZipEntry(buffer: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error("replacement entry name must have the same byte length");
  }
  const result = Buffer.from(buffer);
  let offset = result.indexOf(from);
  while (offset !== -1) {
    result.write(to, offset, "utf8");
    offset = result.indexOf(from, offset + Buffer.byteLength(to));
  }
  return result;
}

describe("extractZip", () => {
  it("extracts a normal package and detects its root", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "index.js", data: "export default {};" },
      { path: "ui/", directory: true },
      { path: "ui/index.html", data: "<html></html>" },
    ]);
    const destination = join(dir, "out");
    const result = await extractZip(zip, destination);
    expect(result).toMatchObject({ files: 3, root: destination });
    expect(await readFile(join(result.root, "index.js"), "utf8")).toContain("export default");
    expect(await readFile(join(result.root, "ui", "index.html"), "utf8")).toBe("<html></html>");

    expect((await stat(join(result.root, "index.js"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(result.root, "ui"))).mode & 0o777).toBe(0o700);
  });

  it("strips a single wrapper directory", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "my-plugin/package.json", data: packageJson },
      { path: "my-plugin/index.js", data: "export default {};" },
    ]);
    const result = await extractZip(zip, join(dir, "out"));
    expect(result.root).toBe(join(dir, "out", "my-plugin"));
  });

  it("ignores metadata entries", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "package.json", data: packageJson },
      { path: ".DS_Store", data: "metadata" },
      { path: "__MACOSX/", directory: true },
      { path: "__MACOSX/._package.json", data: "metadata" },
    ]);
    const result = await extractZip(zip, join(dir, "out"));
    expect(result).toMatchObject({ files: 1, root: join(dir, "out") });
  });

  it("counts every normalized entry, including ignored metadata, against maxEntries", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "__MACOSX/", directory: true },
      { path: ".DS_Store", data: "metadata" },
    ]);
    await expect(extractZip(zip, join(dir, "out"), { maxEntries: 2 })).rejects.toMatchObject({
      status: 413,
      code: "archive_limit",
    });
    expect(await stat(join(dir, "out")).catch(() => null)).toBeNull();

    const manyDirs = await makeZip([
      { path: "package.json", data: packageJson },
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `empty-${index}/`,
        directory: true,
      })),
    ]);
    await expect(extractZip(manyDirs, join(dir, "out2"), { maxEntries: 4 })).rejects.toMatchObject({
      status: 413,
      code: "archive_limit",
    });
  });

  it("rejects traversal, backslashes, absolute paths, dot segments and duplicates", async () => {
    const dir = await tempDir();

    const traversalZip = renameZipEntry(
      await makeZip([{ path: "aa/escape.txt", data: "x" }]),
      "aa/escape.txt",
      "../escape.txt",
    );
    await expect(extractZip(traversalZip, join(dir, "traversal"))).rejects.toMatchObject({
      code: "archive_unsafe",
    });

    const backslashZip = renameZipEntry(
      await makeZip([{ path: "foo/bar.txt", data: "x" }]),
      "foo/bar.txt",
      "foo\\bar.txt",
    );
    await expect(extractZip(backslashZip, join(dir, "backslash"))).rejects.toMatchObject({
      code: "archive_unsafe",
    });

    const absoluteZip = renameZipEntry(
      await makeZip([{ path: "xetc/passwd", data: "x" }]),
      "xetc/passwd",
      "/etc/passwd",
    );
    await expect(extractZip(absoluteZip, join(dir, "absolute"))).rejects.toMatchObject({
      code: "archive_unsafe",
    });

    const dotSegment = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "a/./b.txt", data: "x" },
    ]);
    await expect(extractZip(dotSegment, join(dir, "dot"))).rejects.toMatchObject({
      code: "archive_unsafe",
    });

    const duplicate = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "A.txt", data: "1" },
      { path: "a.txt", data: "2" },
    ]);
    await expect(extractZip(duplicate, join(dir, "duplicate"))).rejects.toThrow(
      /duplicate archive path/i,
    );
  });

  it("rejects symlink entries", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "link", data: "/etc/passwd", mode: 0o120777 },
    ]);
    await expect(extractZip(zip, join(dir, "out"))).rejects.toMatchObject({
      code: "archive_unsafe",
      message: expect.stringMatching(/symlink/i),
    });
  });

  it("rejects oversized archives", async () => {
    const dir = await tempDir();
    const big = Buffer.alloc(1024);
    await expect(extractZip(big, join(dir, "out"), { maxArchiveBytes: 10 })).rejects.toMatchObject({
      status: 413,
      code: "archive_too_large",
    });

    await expect(extractZip(Buffer.from("not a zip"), join(dir, "out2"))).rejects.toMatchObject({
      status: 415,
      code: "invalid_archive",
    });
  });

  it("rejects extracted output over the total and per-file limits", async () => {
    const dir = await tempDir();
    const zip = await makeZip([
      { path: "package.json", data: packageJson },
      { path: "index.js", data: "export default {};" },
    ]);
    await expect(extractZip(zip, join(dir, "out"), { maxExtractedBytes: 5 })).rejects.toMatchObject(
      { status: 413, code: "archive_limit" },
    );
    expect(await stat(join(dir, "out")).catch(() => null)).toBeNull();

    await expect(extractZip(zip, join(dir, "out2"), { maxFileBytes: 5 })).rejects.toMatchObject({
      status: 413,
      code: "archive_limit",
    });
  });
});
