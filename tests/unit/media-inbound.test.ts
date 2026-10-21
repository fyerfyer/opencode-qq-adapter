import { mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboundMediaService } from "../../src/media/inbound.js";
import { buildLogger } from "../../src/observability/logger.js";
import { FakeOneBot, makeTestConfig } from "../helpers/fakes.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function serve(body: Buffer, contentType = "image/png"): Promise<string> {
  return serveWith((_request, response) => {
    response.setHeader("content-type", contentType);
    response.setHeader("content-length", String(body.length));
    response.end(body);
  });
}

async function serveWith(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  disposers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}/image.png`;
}

async function setup(options: { maxBytes?: number } = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-media-"));
  const config = makeTestConfig({ projectPath });
  config.security.max_image_bytes = options.maxBytes ?? 1024 * 1024;
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const media = new InboundMediaService({ config, onebot, logger });
  disposers.push(() => logger.flush?.());
  return { config, onebot, media };
}

describe("InboundMediaService", () => {
  it("downloads and validates a PNG attachment", async () => {
    const { config, media } = await setup();
    const url = await serve(PNG);
    const result = await media.prepare([{ url, summary: "qq image" }]);

    expect(result.warnings).toEqual([]);
    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image?.mime).toBe("image/png");
    expect(image?.localPath).toMatch(/\.png$/);
    expect(image?.localPath?.startsWith(config.storage.inbox_dir)).toBe(true);
    const info = await stat(image?.localPath ?? "");
    expect(info.size).toBe(PNG.length);
  });

  it("resolves an image through NapCat get_image when no URL is present", async () => {
    const { onebot, media } = await setup();
    const url = await serve(PNG);
    onebot.imageUrls.set("abc.image", url);
    const result = await media.prepare([{ file: "abc.image" }]);
    expect(result.warnings).toEqual([]);
    expect(result.images[0]?.mime).toBe("image/png");
  });

  it("follows safe image redirects", async () => {
    const { media } = await setup();
    const target = await serve(PNG);
    const redirect = await serveWith((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", target);
      response.end();
    });
    const result = await media.prepare([{ url: redirect }]);
    expect(result.warnings).toEqual([]);
    expect(result.images[0]?.mime).toBe("image/png");
  });

  it("rejects non-image content and oversized downloads", async () => {
    const { media } = await setup({ maxBytes: 32 });
    const html = await serve(Buffer.from("<html>not an image</html>"), "text/html");
    const tooLarge = await serve(PNG);
    const result = await media.prepare([{ url: html }, { url: tooLarge }]);
    expect(result.images).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("仅支持");
    expect(result.warnings.join("\n")).toContain("超过");
  });

  it("enforces the per-message image count limit", async () => {
    const { config, media } = await setup();
    config.security.max_images_per_message = 1;
    const url = await serve(PNG);
    const result = await media.prepare([{ url }, { url }]);
    expect(result.images).toHaveLength(0);
    expect(result.warnings[0]).toContain("最多 1 张");
  });

  it("rejects loopback/private image URLs by default", async () => {
    const { config, media } = await setup();
    config.security.allow_private_image_urls = false;
    const url = await serve(PNG);
    const result = await media.prepare([{ url }]);
    expect(result.images).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("内网");
  });

  it("prunes old inbox files", async () => {
    const { config, media } = await setup();
    const url = await serve(PNG);
    const result = await media.prepare([{ url }]);
    const path = result.images[0]?.localPath ?? "";
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(path, old, old);
    expect(await media.cleanupInbox()).toBe(1);
    expect(await readdir(config.storage.inbox_dir)).toEqual([]);
  });
});
