/**
 * HermesAcpAdapter — `ProviderAdapterShape` for the Hermes ACP server.
 *
 * Mirrors the Cursor ACP adapter in structure but is substantially smaller:
 *
 *   - No Cursor-specific extension messages (ask_question, create_plan,
 *     update_todos). Hermes ACP speaks vanilla ACP.
 *   - No model-picker config; Hermes' model lives in `~/.hermes/config.yaml`.
 *   - No `interactionMode` / mode-aliasing; Hermes ACP doesn't expose
 *     plan vs implement vs ask as distinct modes.
 *
 * The shared infrastructure under `provider/acp/` does the heavy lifting:
 *   - `AcpSessionRuntime` owns the child process + JSON-RPC client.
 *   - `AcpCoreRuntimeEvents` builds the runtime events from ACP session
 *     update payloads.
 *   - `AcpAdapterSupport` maps ACP errors to adapter errors.
 *
 * @module provider/Layers/HermesAcpAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type HermesAcpSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  acpPermissionOutcome,
  mapAcpToAdapterError,
} from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("hermes-acp");

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface HermesAcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

export interface HermesAcpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function settlePendingApprovals(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingApprovals.values()],
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputs(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingUserInputs.values()],
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export function makeHermesAcpAdapter(
  hermesAcpSettings: HermesAcpSettings,
  options?: HermesAcpAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes-acp");
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const sessions = new Map<ThreadId, HermesAcpSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesAcpSessionContext, ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError> => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      if (ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: HermesAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return false;
        ctx.stopped = true;
        yield* settlePendingApprovals(ctx.pendingApprovals);
        yield* settlePendingUserInputs(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber).pipe(Effect.ignore);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        return true;
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (ctx) => Effect.ignoreCause(stopSessionInternal(ctx)),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ensuring(PubSub.shutdown(runtimeEventPubSub))),
    );

    const startSessionImpl = Effect.fn("startSession")(function* (
      input: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0],
    ) {
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required and must be non-empty.",
        });
      }
      const cwd = path.resolve(input.cwd.trim());
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        yield* stopSessionInternal(existing);
      }

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const sessionScope = yield* Scope.make("sequential");
      let scopeTransferred = false;
      yield* Effect.addFinalizer(() =>
        scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
      );

      let ctx!: HermesAcpSessionContext;

      const acp = yield* makeHermesAcpRuntime({
        hermesSettings: {
          binaryPath: hermesAcpSettings.binaryPath,
          profile: hermesAcpSettings.profile,
        },
        ...(options?.environment ? { environment: options.environment } : {}),
        childProcessSpawner,
        cwd,
        clientInfo: { name: "t3-code", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );

      // Wire up the permission handler before starting — the ACP server
      // can issue permission requests during the initial setup if it has
      // pending state.
      yield* acp.handleRequestPermission((params) =>
        Effect.gen(function* () {
          const permissionRequest = parsePermissionRequest(params);
          const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
          yield* offerRuntimeEvent(
            makeAcpRequestOpenedEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: runtimeRequestId,
              permissionRequest,
              detail: permissionRequest.detail ?? "[no detail]",
              args: params,
              source: "acp.jsonrpc",
              method: "session/request_permission",
              rawPayload: params,
            }),
          );
          const resolved = yield* Deferred.await(decision);
          pendingApprovals.delete(requestId);
          yield* offerRuntimeEvent(
            makeAcpRequestResolvedEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: runtimeRequestId,
              permissionRequest,
              decision: resolved,
            }),
          );
          return {
            outcome:
              resolved === "cancel"
                ? ({ outcome: "cancelled" } as const)
                : ({ outcome: "selected" as const, optionId: acpPermissionOutcome(resolved) }),
          };
        }),
      );

      const started = yield* acp.start().pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
        ),
      );

      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };

      ctx = {
        threadId: input.threadId,
        session,
        scope: sessionScope,
        acp,
        notificationFiber: undefined,
        pendingApprovals,
        pendingUserInputs,
        activeTurnId: undefined,
        stopped: false,
      };

      // Fork the session-update consumer.
      const notificationFiber = yield* Stream.runDrain(
        Stream.mapEffect(acp.getEvents(), (event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "ModeChanged":
                return;
              case "AssistantItemStarted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                // Hermes ACP doesn't have a Cursor-style plan UX yet; we
                // still forward the raw payload as a turn.plan.updated
                // event so the UI can render whatever Hermes sends.
                return;
              case "ToolCallUpdated":
                yield* offerRuntimeEvent(
                  makeAcpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ContentDelta":
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
            }
          }),
        ),
      ).pipe(Effect.forkChild);

      ctx.notificationFiber = notificationFiber;
      sessions.set(input.threadId, ctx);
      scopeTransferred = true;

      yield* offerRuntimeEvent({
        type: "session.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { resume: started.initializeResult },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { providerThreadId: started.sessionId },
      });

      return session;
    });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      startSessionImpl(input).pipe(Effect.scoped);

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn("sendTurn")(
      function* (input) {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* Random.nextUUIDv4);
        const userMessage = input.input?.trim();
        if (!userMessage || userMessage.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Hermes ACP turns require non-empty text input.",
          });
        }

        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [
          { type: "text", text: userMessage },
        ];

        const promptResult = yield* ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
        );

        ctx.activeTurnId = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        const stop = promptResult.stopReason ?? "completed";
        if (stop === "cancelled") {
          yield* offerRuntimeEvent({
            type: "turn.aborted",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { reason: "Interrupted by user." },
          });
        } else {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { state: "completed" },
          });
        }

        return { threadId: input.threadId, turnId };
      },
    );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
      "interruptTurn",
    )(function* (threadId, _turnId) {
      const ctx = yield* requireSession(threadId);
      yield* ctx.acp.cancel.pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
        ),
      );
    });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] =
      Effect.fn("respondToRequest")(function* (threadId, requestId, decision) {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision).pipe(Effect.ignore);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
      Effect.fn("respondToUserInput")(function* (threadId, requestId, answers) {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers).pipe(Effect.ignore);
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
      "stopSession",
    )(function* (threadId) {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      const stopped = yield* stopSessionInternal(ctx);
      if (!stopped) return;
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId,
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
      yield* requireSession(threadId);
      return { threadId, turns: [] };
    });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
      "rollbackThread",
    )(function* (threadId, _numTurns) {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "Hermes ACP does not support thread rollback.",
      });
    });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (ctx) => Effect.ignoreCause(stopSessionInternal(ctx)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" as const },
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
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
