import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { ulid } from "ulid";
import type { AppConfig } from "../config/schema.js";
import type { IncomingImage } from "../domain/message.js";
import type { OneBotPort } from "../ports/onebot.js";
import { detectImageType, formatBytes } from "./image.js";

export interface InboundMediaResult {
  images: IncomingImage[];
  warnings: string[];
}

export interface InboundMediaOptions {
  config: AppConfig;
  onebot: OneBotPort;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Downloads and validates QQ image segments before they enter a prompt. */
export class InboundMediaService {
  readonly #config: AppConfig;
  readonly #onebot: OneBotPort;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: InboundMediaOptions) {
    this.#config = options.config;
    this.#onebot = options.onebot;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get inboxDir(): string {
    return this.#config.storage.inbox_dir;
  }

  async prepare(images: IncomingImage[]): Promise<InboundMediaResult> {
    if (!this.#config.features.images) {
      return {
        images: images.map((image) => ({ ...image, localPath: undefined })),
        warnings: images.length > 0 ? ["当前配置未启用图片输入。"] : [],
      };
    }
    const maxCount = this.#config.security.max_images_per_message;
    if (images.length > maxCount) {
      return {
        images: [],
        warnings: [`每条消息最多 ${maxCount} 张图片，本条消息未处理任何图片。`],
      };
    }

    await mkdir(this.#config.storage.inbox_dir, { recursive: true });
    const prepared: IncomingImage[] = [];
    const warnings: string[] = [];
    for (const [index, image] of images.entries()) {
      try {
        const downloaded = await this.#download(image, index + 1);
        prepared.push(downloaded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.warn({ err: error, index }, "Failed to prepare inbound QQ image");
        warnings.push(`第 ${index + 1} 张图片已忽略：${message}`);
      }
    }
    return { images: prepared, warnings };
  }

  async cleanupInbox(
    olderThanMs = this.#config.storage.inbox_ttl_hours * 60 * 60 * 1000,
  ): Promise<number> {
    const cutoff = this.#now() - olderThanMs;
    let names: string[];
    try {
      names = await readdir(this.#config.storage.inbox_dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const path = join(this.#config.storage.inbox_dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
        removed += 1;
      } catch (error) {
        this.#logger.debug({ err: error, path }, "Failed to prune inbox file");
      }
    }
    return removed;
  }

  async #download(image: IncomingImage, index: number): Promise<IncomingImage> {
    const urls = await this.#candidateUrls(image);
    if (urls.length === 0) {
      throw new Error("图片没有可下载的 URL");
    }
    let buffer: Buffer | null = null;
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        buffer = await this.#fetchImage(url);
        break;
      } catch (error) {
        lastError = error;
        this.#logger.debug(
          { err: error, url: url.slice(0, 120) },
          "Image download failed; trying fallback",
        );
      }
    }
    if (buffer === null) {
      throw lastError instanceof Error ? lastError : new Error("图片下载失败");
    }
    if (buffer.length > this.#config.security.max_image_bytes) {
      throw new Error(`图片超过 ${formatBytes(this.#config.security.max_image_bytes)} 限制`);
    }
    const type = detectImageType(buffer);
    if (type === null) {
      throw new Error("仅支持 PNG / JPEG / GIF / WebP 图片");
    }
    const fileName = `${ulid(this.#now())}-${index}.${type.extension}`;
    const localPath = join(this.#config.storage.inbox_dir, fileName);
    await writeFile(localPath, buffer, { mode: 0o600 });
    return {
      ...image,
      localPath,
      mime: type.mime,
      summary: image.summary ?? `${type.mime} ${formatBytes(buffer.length)}`,
    };
  }

  async #candidateUrls(image: IncomingImage): Promise<string[]> {
    const urls: string[] = [];
    if (image.url !== undefined && image.url.length > 0) urls.push(image.url);
    if (image.file !== undefined && /^https?:\/\//i.test(image.file)) urls.push(image.file);
    if (image.file !== undefined && image.file.length > 0) {
      try {
        const info = await this.#onebot.getImage(image.file);
        if (info.url.length > 0) urls.push(info.url);
      } catch (error) {
        this.#logger.debug({ err: error, file: image.file }, "NapCat get_image failed");
      }
    }
    return [...new Set(urls)];
  }

  #assertSafeUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("图片 URL 无效");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("图片 URL 只允许 http/https");
    }
    if (this.#config.security.allow_private_image_urls) return;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host)) {
      throw new Error("图片 URL 指向本机/内网地址，已拒绝");
    }
  }

  async #fetchImage(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("image download timed out")),
      DOWNLOAD_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      let current = url;
      let response: Response | null = null;
      for (let redirects = 0; redirects < 4; redirects += 1) {
        this.#assertSafeUrl(current);
        const candidate = await this.#fetch(current, {
          signal: controller.signal,
          redirect: "manual",
        });
        if (candidate.status >= 300 && candidate.status < 400) {
          const location = candidate.headers.get("location");
          if (location === null) throw new Error("图片下载重定向缺少 Location");
          current = new URL(location, current).toString();
          continue;
        }
        response = candidate;
        break;
      }
      if (response === null) throw new Error("图片下载重定向次数过多");
      if (!response.ok) {
        throw new Error(`下载图片失败：HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.#config.security.max_image_bytes) {
        throw new Error(`图片超过 ${formatBytes(this.#config.security.max_image_bytes)} 限制`);
      }
      if (response.body === null) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > this.#config.security.max_image_bytes) {
          throw new Error(`图片超过 ${formatBytes(this.#config.security.max_image_bytes)} 限制`);
        }
        return buffer;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.#config.security.max_image_bytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`图片超过 ${formatBytes(this.#config.security.max_image_bytes)} 限制`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isPrivateAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  return false;
}

export function toPromptFiles(image: IncomingImage): Array<{
  uri: string;
  name?: string;
  description?: string;
}> {
  if (image.localPath === undefined) return [];
  return [
    {
      uri: pathToFileURL(image.localPath).toString(),
      name: basename(image.localPath),
      ...(image.summary ? { description: image.summary } : {}),
    },
  ];
}
