import { basename } from "node:path";

/** Reject files that commonly contain secrets or repository internals. */
export function isSensitiveFile(target: string): boolean {
  const normalized = target.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  const segments = normalized.split("/");
  if (segments.includes(".git") || segments.includes(".ssh")) return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  if (name === "id_rsa" || name === "id_ed25519") return true;
  return /\.(pem|key|p12|pfx)$/.test(name);
}
