import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { PluginConversationProfile } from "../sdk.js";

export interface NormalizePluginProfileInput {
  raw: Record<string, unknown>;
  projectId: string;
  pluginId: string;
  config: AppConfig;
  logger: Logger;
}

export async function normalizePluginProfile(
  input: NormalizePluginProfileInput,
): Promise<PluginConversationProfile | null> {
  const { raw, projectId, pluginId, config, logger } = input;
  const project = config.projects[projectId];
  if (project === undefined) return null;

  const ignoredFields = (["agent", "model", "workspace"] as const).filter(
    (field) => raw[field] !== undefined,
  );
  if (ignoredFields.length > 0) {
    logger.warn(
      { pluginId, projectId, fields: ignoredFields },
      "Plugin profile fields are ignored; core owns agent, model and workspace",
    );
  }

  const directory =
    typeof raw.directory === "string" && raw.directory.trim().length > 0
      ? raw.directory.trim()
      : undefined;
  if (directory !== undefined && project.workspace !== "none") {
    logger.warn(
      { pluginId, projectId },
      "Plugin profile requested a lock-free directory for a normal workspace project; ignoring",
    );
    return null;
  }

  let resolvedDirectory: string | undefined;
  if (directory !== undefined) {
    try {
      const root = await realpath(resolve(project.path));
      const target = await realpath(resolve(directory));
      const rel = relative(root, target);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        logger.warn(
          { pluginId, projectId, directory: target },
          "Plugin profile directory escapes the project root; ignoring",
        );
        return null;
      }
      resolvedDirectory = target;
    } catch (error) {
      logger.warn(
        { err: error, pluginId, projectId, directory },
        "Plugin profile directory is not accessible; ignoring",
      );
      return null;
    }
  }

  return resolvedDirectory !== undefined ? { directory: resolvedDirectory } : {};
}
