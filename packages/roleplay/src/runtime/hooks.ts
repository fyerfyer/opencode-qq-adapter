import type { PluginContext, PluginRunContext } from "@opencode-qq/plugin-sdk";
import { planReplyWithSticker } from "../delivery.js";
import { guardRoleplayReply } from "../guard.js";
import type { RoleplayOptions } from "../options.js";
import { ROLEPLAY_MODE_INSTRUCTIONS, buildContextBlock } from "../prompt.js";
import { promptQueryText, transcriptUserText } from "../prompt-query.js";
import { deliveryOptions, type RoleplayRuntime } from "../runtime.js";
import {
  captionHint,
  chooseSticker,
  extractEmotionTag,
  listEmotions,
} from "../stickers.js";
import { selectWorldbook } from "../worldbook.js";

export function registerRoleplayHooks(
  context: PluginContext<RoleplayOptions>,
  runtime: RoleplayRuntime,
): void {
  const { options } = runtime;
  context.hooks.register({
    async resolveConversationProfile(profile) {
      if (profile.projectId !== options.projectId) return undefined;
      const active = await runtime.activePersona(profile.message.chat.chatKey);
      if (active === null) return undefined;
      return { directory: active.persona.dir };
    },

    async beforePrompt(prompt) {
      if (prompt.projectId !== options.projectId) return undefined;
      const chatKey = prompt.message.chat.chatKey;
      const scope = chatKey;
      const active = await runtime.activePersona(chatKey);
      if (active === null) return undefined;
      const recent = runtime.transcript.recent(
        chatKey,
        Math.max(options.worldbookScanDepth, options.memoryExcludeRecent),
        active.persona.id,
      );
      const worldbook = await runtime.worldbookFor(active.persona);
      const turnCount = runtime.transcript.count(scope, active.persona.id, "user") + 1;
      const queryText = promptQueryText(prompt.message);
      const effectKey = `${active.persona.id}:${scope}`;
      let effectState = runtime.worldbookEffects.get(effectKey);
      if (effectState === undefined) {
        effectState = new Map();
        runtime.worldbookEffects.set(effectKey, effectState);
      }
      const selected = selectWorldbook(
        worldbook,
        {
          currentText: queryText,
          // Scan user messages only: the persona's own replies are dense
          // with prop keywords (尾巴/呆毛/饭盆…), and letting them trigger
          // entries feeds those props back into every turn.
          recentTexts: recent.filter((row) => row.role === "user").map((row) => row.text),
        },
        {
          scanDepth: options.worldbookScanDepth,
          maxEntries: options.worldbookMaxEntries,
          maxChars: options.worldbookMaxChars,
          recursionSteps: options.worldbookRecursionSteps,
          matchWholeWords: options.worldbookMatchWholeWords,
          messageCount: turnCount,
          effectState,
        },
      );
      const excludeCount = Math.max(0, options.memoryExcludeRecent);
      const excluded =
        excludeCount === 0 ? [] : recent.slice(-excludeCount).map((row) => row.id);
      const memoryDocs = await runtime.memory.loadForPrompt({
        personaId: active.persona.id,
        scope,
        actorQq: prompt.message.userId,
      });
      const emotions = options.stickerEnabled
        ? listEmotions(await runtime.stickerCatalogFor(active.persona))
        : [];
      const memories = runtime.transcript.search({
        namespace: active.persona.id,
        scope,
        query: queryText,
        limit: options.memoryRawTopK,
        excludeIds: excluded,
      });
      const hasUser = recent.some((row) => row.role === "user");
      const scene =
        prompt.message.chat.type === "group"
          ? `群聊 ${prompt.message.chat.groupId ?? ""}`.trim()
          : undefined;
      const participants =
        scene === undefined
          ? []
          : [
              ...new Set(
                recent
                  .filter((row) => row.role === "user")
                  .map((row) => row.speaker)
                  .filter((name) => name.trim().length > 0),
              ),
            ].slice(-8);
      const block = buildContextBlock({
        personaName: active.persona.name,
        userName: prompt.message.senderName,
        now: Date.now(),
        turnCount,
        ...(scene !== undefined ? { scene } : {}),
        ...(participants.length > 0 ? { participants } : {}),
        ...(emotions.length > 0 ? { emotions } : {}),
        worldbook: selected,
        memories,
        userDoc: memoryDocs.userDoc,
        sceneDoc: memoryDocs.sceneDoc,
        ...(!hasUser && active.persona.firstMes.length > 0
          ? { firstMes: active.persona.firstMes }
          : {}),
        maxChars: Math.max(400, options.memoryMaxChars + options.worldbookMaxChars + 400),
        sectionMaxChars: {
          user: options.memoryUserMaxChars,
          scene: options.memorySceneMaxChars,
          raw: options.memoryRawMaxChars,
        },
      });
      return {
        prepend:
          block.length > 0
            ? `${ROLEPLAY_MODE_INSTRUCTIONS}\n\n${block}`
            : ROLEPLAY_MODE_INSTRUCTIONS,
      };
    },

    async formatReply(reply) {
      if (reply.projectId !== options.projectId) return undefined;
      const active = await runtime.activePersona(reply.message.chat.chatKey);
      if (active === null) return undefined;
      const guarded = guardRoleplayReply(reply.text);
      if (guarded.removed) {
        context.logger.warn(
          {
            personaId: active.persona.id,
            chatKey: reply.message.chat.chatKey,
            metaOnly: guarded.metaOnly,
            originalChars: reply.text.length,
          },
          "Removed model meta-commentary from a roleplay reply",
        );
      }
      const tag = extractEmotionTag(guarded.text);
      let sticker: { path: string; delayMs: number } | null = null;
      const stickerKey = `${reply.message.chat.chatKey}:${active.persona.id}`;
      const now = Date.now();
      const cooldownActive =
        options.stickerCooldownMs > 0 &&
        now - (runtime.lastStickerAt.get(stickerKey) ?? 0) < options.stickerCooldownMs;
      if (options.stickerEnabled && options.stickerJudge !== "off" && !cooldownActive) {
        try {
          const catalog = await runtime.stickerCatalogFor(active.persona);
          const emotions = listEmotions(catalog);
          if (emotions.length > 0) {
            const tagEmotion =
              tag.emotion !== null && emotions.includes(tag.emotion) ? tag.emotion : null;
            let emotion: string | null =
              options.stickerJudge === "tag" || options.stickerJudge === "hybrid"
                ? tagEmotion
                : null;
            if (
              emotion === null &&
              runtime.jev !== null &&
              (options.stickerJudge === "jev" || options.stickerJudge === "hybrid")
            ) {
              const emotionHints: Record<string, string> = {};
              for (const name of emotions) {
                const hint = captionHint(catalog, name);
                if (hint !== null) emotionHints[name] = hint;
              }
              const decision = await runtime.jev.judge({
                userText: reply.message.text,
                replyText: tag.text,
                emotions,
                personaName: active.persona.name,
                hintEmotion: tagEmotion,
                emotionHints,
              });
              context.logger.debug(
                {
                  personaId: active.persona.id,
                  choice: decision.emotion,
                  confidence: decision.confidence,
                  stickerOk: decision.stickerOk,
                  probabilities: decision.probabilities,
                  costUsd: decision.usage?.cost ?? null,
                },
                "Jev sticker decision",
              );
              if (
                decision.emotion !== null &&
                decision.confidence >= options.jevMinConfidence &&
                decision.stickerOk >= options.jevMinStickerOk
              ) {
                emotion = decision.emotion;
              }
            }
            if (emotion === null && options.stickerJudge === "jev" && runtime.jev === null) {
              emotion = tagEmotion;
            }
            if (emotion !== null) {
              const path = chooseSticker(catalog, emotion, stickerKey, runtime.lastStickers);
              if (path !== null) {
                sticker = { path, delayMs: options.stickerDelayMs };
                runtime.lastStickerAt.set(stickerKey, now);
              }
            }
          }
        } catch (error) {
          context.logger.warn(
            { err: error, personaId: active.persona.id, chatKey: reply.message.chat.chatKey },
            "Sticker judgement failed; sending text only",
          );
        }
      }
      const segments = planReplyWithSticker(tag.text, deliveryOptions(options), sticker);
      const replyText = tag.text.length > 0 ? tag.text : null;
      return segments.length > 0
        ? { segments, replyText }
        : { segments: [], suppress: true, replyText };
    },

    async afterRun(run: PluginRunContext) {
      if (run.projectId !== options.projectId) return;
      const active = await runtime.activePersona(run.chat.chatKey);
      if (active === null) return;
      runtime.memory.recordRun({
        personaId: active.persona.id,
        personaName: active.persona.name,
        chatKey: run.chat.chatKey,
        scope: run.chat.chatKey,
        actorQq: run.userId,
        senderName: run.senderName,
        userText: transcriptUserText(run.userText, run.quote),
        replyText: run.replyText,
        sessionId: run.sessionId,
      });
    },
  });
}
