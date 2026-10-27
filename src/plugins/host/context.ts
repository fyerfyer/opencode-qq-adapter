import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { MessageSender } from "../../qq/sender.js";
import { PluginMessageService } from "../messages.js";
import type {
  PluginAdminHandler,
  PluginAdminMethod,
  PluginAdminPage,
  PluginAgentCompletion,
  PluginAgentResult,
  PluginCommandDefinition,
  PluginContext,
  PluginConversation,
  PluginEventMap,
  PluginHooksDefinition,
  PluginLogger,
  PluginRole,
  PluginSessionMutationResult,
} from "../sdk.js";
import { PluginDataStorage } from "../storage.js";
import {
  compileAdminPath,
  normalizeAdminMethod,
  normalizeAdminPage,
  normalizeAdminPath,
} from "./admin-ui.js";
import { requireCapability, validateCommand } from "./convert.js";
import type {
  EventSubscription,
  PluginInstance,
  RegisteredAdminRoute,
  RegisteredCommand,
  RegisteredHook,
} from "./types.js";

export interface PluginContextServices {
  config: AppConfig;
  sender: MessageSender;
  logger: Logger;
  reservedCommands: Set<string>;
  sortedInstances: () => PluginInstance[];
  conversationSnapshot: (chatKey: string) => PluginConversation | null;
  setProject: (chatKey: string, projectId: string, actorQq: number) => PluginSessionMutationResult;
  resetSession: (chatKey: string, actorQq: number) => PluginSessionMutationResult;
  completeUtility: (
    instance: PluginInstance,
    input: PluginAgentCompletion,
  ) => Promise<PluginAgentResult>;
  pluginLogger: (instance: PluginInstance) => PluginLogger;
}

export function createPluginContext(
  instance: PluginInstance,
  options: unknown,
  services: PluginContextServices,
): PluginContext<unknown> {
  const definition = instance.definition;
  const manifest = instance.manifest;
  if (definition === null || manifest === null) {
    throw new Error("plugin context requested before manifest was loaded");
  }
  const logger = services.pluginLogger(instance);
  const messages = new PluginMessageService({
    config: services.config,
    sender: services.sender,
    logger,
    dataDir: instance.dataDir,
  }).createApi();
  const storage = new PluginDataStorage(instance.dataDir);

  const commands = {
    register: (command: PluginCommandDefinition): (() => void) => {
      requireCapability(instance, "commands");
      const names = validateCommand(command);
      if (names.some((name) => services.reservedCommands.has(name))) {
        throw new Error(
          `command '${names.find((name) => services.reservedCommands.has(name))}' is reserved by the core`,
        );
      }
      for (const registered of instance.commands.values()) {
        for (const name of names) {
          if (registered.names.includes(name)) {
            throw new Error(`duplicate command '${name}' in plugin ${instance.id}`);
          }
        }
      }
      for (const other of services.sortedInstances()) {
        if (other.id === instance.id || other.status !== "loaded") continue;
        for (const registered of other.commands.values()) {
          for (const name of names) {
            if (registered.names.includes(name)) {
              throw new Error(`command '${name}' is already registered by plugin ${other.id}`);
            }
          }
        }
      }
      const registered: RegisteredCommand = { definition: command, names };
      instance.commands.set(command.name, registered);
      return () => {
        if (instance.commands.get(command.name) === registered) {
          instance.commands.delete(command.name);
        }
      };
    },
    unregister: (name: string): void => {
      const normalized = name.toLowerCase();
      for (const [key, registered] of instance.commands) {
        if (registered.names.includes(normalized)) instance.commands.delete(key);
      }
    },
  };

  const hooks = {
    register: (definitionHooks: PluginHooksDefinition): (() => void) => {
      requireCapability(instance, "hooks");
      const registered: RegisteredHook = { definition: definitionHooks };
      instance.hooks.push(registered);
      return () => {
        const index = instance.hooks.indexOf(registered);
        if (index >= 0) instance.hooks.splice(index, 1);
      };
    },
  };

  const events = {
    on: <K extends keyof PluginEventMap>(
      type: K,
      handler: (event: PluginEventMap[K]) => void | Promise<void>,
    ): (() => void) => {
      requireCapability(instance, "events");
      if (typeof handler !== "function") throw new Error("event handler must be a function");
      const subscription: EventSubscription = {
        type,
        handler: handler as (event: unknown) => void | Promise<void>,
      };
      instance.events.push(subscription);
      return () => {
        const index = instance.events.indexOf(subscription);
        if (index >= 0) instance.events.splice(index, 1);
      };
    },
  };

  const sessions = {
    get: (chatKey: string) => services.conversationSnapshot(chatKey),
    setProject: (
      chatKey: string,
      projectId: string,
      actor: { qq: number; role: PluginRole },
    ): PluginSessionMutationResult => services.setProject(chatKey, projectId, actor.qq),
    reset: (
      chatKey: string,
      actor: { qq: number; role: PluginRole },
    ): PluginSessionMutationResult => services.resetSession(chatKey, actor.qq),
  };

  const admin = {
    route: (
      method: PluginAdminMethod,
      routePath: string,
      handler: PluginAdminHandler,
    ): (() => void) => {
      requireCapability(instance, "admin");
      const normalizedMethod = normalizeAdminMethod(method);
      const normalizedPath = normalizeAdminPath(routePath);
      if (normalizedPath === "/") {
        throw new Error("admin route path must not be the plugin root");
      }
      if (typeof handler !== "function") {
        throw new Error("admin route handler must be a function");
      }
      if (
        instance.adminRoutes.some(
          (route) => route.method === normalizedMethod && route.pattern === normalizedPath,
        )
      ) {
        throw new Error(`duplicate admin route ${normalizedMethod} ${normalizedPath}`);
      }
      const route: RegisteredAdminRoute = {
        method: normalizedMethod,
        pattern: normalizedPath,
        segments: compileAdminPath(normalizedPath),
        handler,
        order: instance.adminRoutes.length,
      };
      instance.adminRoutes.push(route);
      return () => {
        const index = instance.adminRoutes.indexOf(route);
        if (index >= 0) instance.adminRoutes.splice(index, 1);
      };
    },
    page: (page: PluginAdminPage): (() => void) => {
      requireCapability(instance, "admin");
      const normalized = normalizeAdminPage(page, instance.id, manifest);
      if (instance.adminPages.some((item) => item.id === normalized.id)) {
        throw new Error(`duplicate admin page '${normalized.id}'`);
      }
      instance.adminPages.push(normalized);
      return () => {
        const index = instance.adminPages.indexOf(normalized);
        if (index >= 0) instance.adminPages.splice(index, 1);
      };
    },
  };

  return {
    manifest,
    config: options,
    dataDir: instance.dataDir,
    logger,
    storage,
    commands,
    hooks,
    messages,
    sessions,
    events,
    agent: {
      complete: (input: PluginAgentCompletion) => services.completeUtility(instance, input),
    },
    admin,
  };
}
