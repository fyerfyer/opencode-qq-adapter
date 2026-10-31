import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathContainmentOptions {
  /** Treat `candidate === root` as contained. Defaults to true. */
  allowRoot?: boolean;
}

/**
 * Lexical containment check for already-resolved paths.
 *
 * Callers that follow symlinks should resolve both paths with `realpath`
 * first; this helper only compares the path strings.
 */
export function isPathInside(
  root: string,
  candidate: string,
  options: PathContainmentOptions = {},
): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return options.allowRoot !== false;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
