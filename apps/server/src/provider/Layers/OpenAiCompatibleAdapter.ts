/**
 * OpenAiCompatibleAdapter — generic `ProviderAdapterShape` for any HTTP
 * backend that speaks OpenAI's `/v1/chat/completions` streaming protocol.
 *
 * This is the workhorse for Ollama, LM Studio, OpenRouter, hosted OpenAI,
 * Hermes-as-vanilla-chat, etc. Atelier owns the conversation history;
 * `interruptTurn` cancels the active turn's scope (which aborts the HTTP
 * stream); approvals / user-input are not supported on this protocol.
 *
 * The Hermes specialised driver layers richer transport selection on top
 * of this — but for everyone else, this is sufficient.
 *
 * @module provider/Layers/OpenAiCompatibleAdapter
 */
import {
  EventId,
  type OpenAiCompatibleSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { isLoopbackUrl, normalizeOpenAiBaseUrl } from "../openaiCompatible/openaiHttp.ts";
import {
  type OpenAiChatMessage,
  runOpenAiChatCompletionsTurn,
} from "../openaiCompatible/openaiChatCompletions.ts";

interface OpenAiCompatibleSessionContext {
  session: ProviderSession;
  readonly directory: string | undefined;
  readonly history: Array<OpenAiChatMessage>;
  activeTurnScope: Scope.Closeable | undefined;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface OpenAiCompatibleAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  /**
   * Override the driver kind reported on emitted runtime events. The
   * generic driver uses `"openai-compat"`; the Hermes specialised driver
   * uses `"hermes"`. Lets both reuse this adapter without leaking each
   * other's driver kind.
   */
  readonly driverKind?: ProviderDriverKind;
  /**
   * Optional fallback model id when neither the per-turn selection nor the
   * settings' `defaultModel` are set. Useful for backends like Ollama
   * where the user typically has a single advertised model.
   */
  readonly fallbackModel?: string;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function makeOpenAiCompatibleAdapter(
  settings: OpenAiCompatibleSettings,
  options?: OpenAiCompatibleAdapterOptions,
) {
  return Effect.gen(function* () {
    const driverKind = options?.driverKind ?? ProviderDriverKind.make("openai-compat");
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("openai-compat");
    const httpClient = yield* HttpClient.HttpClient;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenAiCompatibleSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const buildEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const uuid = yield* Random.nextUUIDv4;
        const createdAt = yield* nowIso;
        return {
          eventId: EventId.make(uuid),
          provider: driverKind,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
        };
      });

    const resolvedBaseUrl = () => {
      const raw = settings.baseUrl.trim();
      if (raw.length === 0) return undefined;
      return normalizeOpenAiBaseUrl(raw);
    };

    const apiToken = () => settings.apiToken.trim();

    const requireBaseUrl = (
      operation: string,
    ): Effect.Effect<string, ProviderAdapterValidationError> => {
      const url = resolvedBaseUrl();
      if (!url) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation,
            issue: "Base URL is not configured.",
          }),
        );
      }
      const token = apiToken();
      if (token.length === 0 && !isLoopbackUrl(url)) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: driverKind,
            operation,
            issue: `API token is required for non-loopback URLs (${url}).`,
          }),
        );
      }
      return Effect.succeed(url);
    };

    function ensureSessionContext(threadId: ThreadId): OpenAiCompatibleSessionContext {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({ provider: driverKind, threadId });
      }
      if (Ref.getUnsafe(context.stopped)) {
        throw new ProviderAdapterSessionClosedError({ provider: driverKind, threadId });
      }
      return context;
    }

    const stopContext = Effect.fn("stopContext")(function* (
      context: OpenAiCompatibleSessionContext,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return false;
      }
      if (context.activeTurnScope) {
        yield* Scope.close(context.activeTurnScope, Exit.void).pipe(Effect.ignore);
        context.activeTurnScope = undefined;
      }
      yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
      return true;
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (ctx) => Effect.ignoreCause(stopContext(ctx)), {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const updateProviderSession = (
      context: OpenAiCompatibleSessionContext,
      patch: Partial<ProviderSession>,
      flags?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
    ) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const next = { ...context.session, ...patch, updatedAt };
        const mutable = next as unknown as Record<string, unknown>;
        if (flags?.clearActiveTurnId) delete mutable.activeTurnId;
        if (flags?.clearLastError) delete mutable.lastError;
        context.session = next as ProviderSession;
        return context.session;
      });

    const resolveModelForTurn = (
      explicitModel: string | undefined,
      contextModel: string | undefined,
    ): string => {
      if (explicitModel && explicitModel.length > 0) return explicitModel;
      if (contextModel && contextModel.length > 0) return contextModel;
      const fromSettings = settings.defaultModel.trim();
      if (fromSettings.length > 0) return fromSettings;
      return options?.fallbackModel ?? "gpt-4o-mini";
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
      "startSession",
    )(function* (input) {
      yield* requireBaseUrl("startSession");
      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* stopContext(existing);
        sessions.delete(input.threadId);
      }
      const sessionScope = yield* Scope.make();
      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: driverKind,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
      const context: OpenAiCompatibleSessionContext = {
        session,
        directory: input.cwd,
        history: [],
        activeTurnScope: undefined,
        activeTurnId: undefined,
        stopped: yield* Ref.make(false),
        sessionScope,
      };
      sessions.set(input.threadId, context);

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "OpenAI-compatible session started" },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: { providerThreadId: input.threadId },
      });
      return session;
    });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("sendTurn")(
      function* (input) {
        const baseUrl = yield* requireBaseUrl("sendTurn");
        const context = ensureSessionContext(input.threadId);
        const turnId = TurnId.make(`openai-compat-turn-${yield* Random.nextUUIDv4}`);
        const userMessage = input.input?.trim();
        if (!userMessage || userMessage.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: driverKind,
            operation: "sendTurn",
            issue: "Turns require non-empty text input.",
          });
        }
        const model = resolveModelForTurn(input.modelSelection?.model, context.session.model);

        context.activeTurnId = turnId;
        const turnScope = yield* Scope.make();
        context.activeTurnScope = turnScope;
        context.history.push({ role: "user", content: userMessage });
        yield* updateProviderSession(
          context,
          { status: "running", activeTurnId: turnId, model },
          { clearLastError: true },
        );

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: { model },
        });

        const assistantItemId = `openai-compat-assistant-${yield* Random.nextUUIDv4}`;
        const token = apiToken();
        const runner = runOpenAiChatCompletionsTurn({
          httpClient,
          provider: driverKind,
          baseUrl,
          ...(token.length > 0 ? { apiToken: token } : {}),
          model,
          messages: context.history,
          onDelta: (delta) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.threadId,
                  turnId,
                  itemId: assistantItemId,
                })),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta },
              });
            }),
          onToolProgress: (payload) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                type: "runtime.warning",
                payload: { message: "Tool progress", detail: payload },
              });
            }),
        });

        const exit = yield* Effect.exit(
          runner.pipe(Effect.provideService(Scope.Scope, turnScope)),
        );

        yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);
        if (context.activeTurnScope === turnScope) context.activeTurnScope = undefined;
        if (context.activeTurnId === turnId) context.activeTurnId = undefined;

        if (Exit.isFailure(exit)) {
          const failure = Cause.squash(exit.cause);
          const detail =
            failure instanceof Error ? failure.message : "Chat-completions turn failed.";
          yield* updateProviderSession(
            context,
            { status: "ready", model, lastError: detail },
            { clearActiveTurnId: true },
          );
          if (Cause.hasInterruptsOnly(exit.cause)) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.aborted",
              payload: { reason: "Interrupted by user." },
            });
            return { threadId: input.threadId, turnId };
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: detail },
          });
          const tag =
            typeof failure === "object" && failure !== null && "_tag" in failure
              ? (failure as { _tag: string })._tag
              : undefined;
          if (
            tag === "ProviderAdapterRequestError" ||
            tag === "ProviderAdapterValidationError" ||
            tag === "ProviderAdapterProcessError" ||
            tag === "ProviderAdapterSessionClosedError" ||
            tag === "ProviderAdapterSessionNotFoundError"
          ) {
            return yield* (failure as ProviderAdapterError);
          }
          return yield* new ProviderAdapterProcessError({
            provider: driverKind,
            threadId: input.threadId,
            detail,
            cause: failure,
          });
        }

        const assistantText = exit.value;
        if (assistantText.length > 0) {
          context.history.push({ role: "assistant", content: assistantText });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: input.threadId,
              turnId,
              itemId: assistantItemId,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: assistantText,
            },
          });
        }
        yield* updateProviderSession(
          context,
          { status: "ready", model },
          { clearActiveTurnId: true },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        return { threadId: input.threadId, turnId };
      },
    );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
      "interruptTurn",
    )(function* (threadId, _turnId) {
      const context = ensureSessionContext(threadId);
      const turnScope = context.activeTurnScope;
      if (turnScope) {
        yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);
      }
    });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] =
      Effect.fn("respondToRequest")(function* (_threadId, _requestId, _decision) {
        return yield* new ProviderAdapterValidationError({
          provider: driverKind,
          operation: "respondToRequest",
          issue: "OpenAI-compatible chat-completions does not support approval round-trips.",
        });
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
      Effect.fn("respondToUserInput")(function* (_threadId, _requestId, _answers) {
        return yield* new ProviderAdapterValidationError({
          provider: driverKind,
          operation: "respondToUserInput",
          issue:
            "OpenAI-compatible chat-completions does not support structured user-input requests.",
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
      "stopSession",
    )(function* (threadId) {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({ provider: driverKind, threadId });
      }
      const stopped = yield* stopContext(context);
      sessions.delete(threadId);
      if (!stopped) return;
      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
      });
    });

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = Effect.fn(
      "readThread",
    )(function* (threadId) {
      ensureSessionContext(threadId);
      return { threadId, turns: [] };
    });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
      "rollbackThread",
    )(function* (threadId, _numTurns) {
      ensureSessionContext(threadId);
      return yield* new ProviderAdapterValidationError({
        provider: driverKind,
        operation: "rollbackThread",
        issue: "OpenAI-compatible chat-completions does not support thread rollback.",
      });
    });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (ctx) => Effect.ignoreCause(stopContext(ctx)), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    return {
      provider: driverKind,
      capabilities: { sessionModelSwitch: "in-session" as const },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
