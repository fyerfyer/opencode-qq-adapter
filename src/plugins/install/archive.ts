import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { isPathInside } from "../../util/path.js";
import { type ExtractResult, PLUGIN_ARCHIVE_LIMITS, PluginInstallError } from "./types.js";

interface ExtractLimits {
  maxArchiveBytes?: number;
  maxExtractedBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxEntries?: number;
  maxPathChars?: number;
  maxDepth?: number;
}

interface NormalizedEntry {
  name: string;
  directory: boolean;
}

interface ExtractCounts {
  files: number;
  bytes: number;
  entries: number;
}

export async function extractZip(
  buffer: Buffer,
  destination: string,
  overrides: ExtractLimits = {},
): Promise<ExtractResult> {
  const limits = { ...PLUGIN_ARCHIVE_LIMITS, ...overrides };
  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw new PluginInstallError(
      413,
      "archive_too_large",
      `ZIP is larger than ${limits.maxArchiveBytes} bytes`,
    );
  }
  if (!isZipMagic(buffer)) {
    throw new PluginInstallError(415, "invalid_archive", "Uploaded file is not a ZIP archive");
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const seen = new Set<string>();
  const counts: ExtractCounts = { files: 0, bytes: 0, entries: 0 };

  try {
    const zip = await openZip(buffer);
    for await (const entry of zip.eachEntry()) {
      await extractEntry(zip, entry, destination, limits, seen, counts);
    }
    return {
      files: counts.files,
      bytes: counts.bytes,
      root: await locateRoot(destination),
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw toPluginInstallError(error);
  }
}

function isZipMagic(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  return signature === 0x04034b50 || signature === 0x06054b50;
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(
      buffer,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => (error === null ? resolveZip(zip) : reject(error)),
    );
  });
}

async function extractEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string,
  limits: Required<ExtractLimits>,
  seen: Set<string>,
  counts: ExtractCounts,
): Promise<void> {
  const normalized = normalizeEntryName(entry.fileName, limits);
  counts.entries += 1;
  if (counts.entries > limits.maxEntries) {
    throw new PluginInstallError(
      413,
      "archive_limit",
      `archive has more than ${limits.maxEntries} entries`,
    );
  }
  if (isIgnored(normalized.name)) return;

  const key = normalized.name.toLowerCase();
  if (seen.has(key)) {
    throw new PluginInstallError(
      400,
      "archive_unsafe",
      `duplicate archive path: ${normalized.name}`,
    );
  }
  seen.add(key);
  assertEntryType(entry);

  const target = resolve(destination, normalized.name);
  assertContained(destination, target, normalized.name);

  if (normalized.directory) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }

  counts.files += 1;
  if (counts.files > limits.maxFiles) {
    throw new PluginInstallError(
      413,
      "archive_limit",
      `archive has more than ${limits.maxFiles} files`,
    );
  }
  if (entry.uncompressedSize > limits.maxFileBytes) {
    throw new PluginInstallError(
      413,
      "archive_limit",
      `file exceeds size limit: ${normalized.name}`,
    );
  }

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const read = await zip.openReadStreamPromise(entry);
  let fileBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
      fileBytes += size;
      counts.bytes += size;
      if (fileBytes > limits.maxFileBytes) {
        callback(
          new PluginInstallError(
            413,
            "archive_limit",
            `file exceeds size limit: ${normalized.name}`,
          ),
        );
        return;
      }
      if (counts.bytes > limits.maxExtractedBytes) {
        callback(
          new PluginInstallError(
            413,
            "archive_limit",
            `extracted archive exceeds size limit of ${limits.maxExtractedBytes} bytes`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(read, counter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
}

function normalizeEntryName(raw: string, limits: Required<ExtractLimits>): NormalizedEntry {
  if (raw.length === 0) {
    throw new PluginInstallError(400, "archive_unsafe", "archive contains an empty path");
  }
  if (raw.length > limits.maxPathChars) {
    throw new PluginInstallError(400, "archive_unsafe", `archive path is too long: ${raw}`);
  }
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new PluginInstallError(400, "archive_unsafe", `unsafe archive path: ${raw}`);
  }

  const directory = raw.endsWith("/");
  const trimmed = directory ? raw.slice(0, -1) : raw;
  const segments = trimmed.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new PluginInstallError(400, "archive_unsafe", `path traversal in archive: ${raw}`);
  }
  if (segments.length > limits.maxDepth) {
    throw new PluginInstallError(400, "archive_unsafe", `archive path is too deep: ${raw}`);
  }
  return { name: segments.join("/"), directory };
}

function assertEntryType(entry: yauzl.Entry): void {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new PluginInstallError(400, "archive_unsafe", "encrypted ZIP entries are not supported");
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type === 0o120000) {
    throw new PluginInstallError(400, "archive_unsafe", "symlinks are not allowed");
  }
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw new PluginInstallError(400, "archive_unsafe", "special files are not allowed");
  }
}

function assertContained(destination: string, target: string, name: string): void {
  if (!isPathInside(destination, target, { allowRoot: false })) {
    throw new PluginInstallError(400, "archive_unsafe", `path escapes archive root: ${name}`);
  }
}

function isIgnored(name: string): boolean {
  return (
    name === "__MACOSX" ||
    name.startsWith("__MACOSX/") ||
    name === ".DS_Store" ||
    name.endsWith("/.DS_Store")
  );
}

async function locateRoot(destination: string): Promise<string> {
  const entries = (await readdir(destination, { withFileTypes: true })).filter(
    (entry) => entry.name !== ".DS_Store" && entry.name !== "__MACOSX",
  );
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    return destination;
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  const onlyDir = dirs.length === 1 ? dirs[0] : undefined;
  if (onlyDir !== undefined) {
    const candidate = join(destination, onlyDir.name);
    const info = await stat(join(candidate, "package.json")).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  throw new PluginInstallError(
    400,
    "package_invalid",
    "ZIP must contain package.json at its root or inside one top-level folder",
  );
}

function toPluginInstallError(error: unknown): PluginInstallError {
  if (error instanceof PluginInstallError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid characters in fileName|absolute path:|invalid relative path:/i.test(message)) {
    return new PluginInstallError(400, "archive_unsafe", message);
  }
  return new PluginInstallError(400, "invalid_archive", message);
}
