/**
 * Internal composition barrel for admin route modules.
 *
 * The implementations live in focused modules:
 * - http.ts: request/response helpers and AdminHttpError
 * - validation.ts: ids and Jev input validation
 * - persona-access.ts: persona lookup and sticker ownership
 * - assets.ts: summaries, persona/sticker assets
 * - memory-docs.ts: memory scopes, documents and history
 */
export * from "./assets.js";
export * from "./http.js";
export * from "./memory-docs.js";
export * from "./persona-access.js";
export * from "./types.js";
export * from "./validation.js";
