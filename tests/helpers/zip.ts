import { Buffer } from "node:buffer";
import yazl from "yazl";

export interface ZipEntryInput {
  path: string;
  data?: string | Buffer;
  mode?: number;
  directory?: boolean;
}

export async function makeZip(entries: ZipEntryInput[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (entry.directory === true) {
      zip.addEmptyDirectory(entry.path, entry.mode === undefined ? {} : { mode: entry.mode });
      continue;
    }
    zip.addBuffer(
      Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ""),
      entry.path,
      entry.mode === undefined ? {} : { mode: entry.mode },
    );
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}
