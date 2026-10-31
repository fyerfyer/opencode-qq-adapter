import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathContainmentOptions {
  allowRoot?: boolean;
}

/** Lexical containment check; callers resolve symlinks before calling. */
export function isPathInside(
  root: string,
  candidate: string,
  options: PathContainmentOptions = {},
): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return options.allowRoot !== false;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
