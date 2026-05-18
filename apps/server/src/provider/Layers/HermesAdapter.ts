/**
 * HermesAdapter — `ProviderAdapterShape` for the Hermes HTTP gateway.
 *
 * Hermes' API server is OpenAI-compatible for `/v1/chat/completions` but
 * also exposes two richer surfaces:
 *
 *   - `/v1/runs` (POST + `{id}/events` SSE + `{id}/stop`): the documented
 *     long-running-run API with cancel — the best fit for Atelier's
 *     `interruptTurn` SPI.
 *   - `/v1/responses` (POST, SSE): OpenAI Responses-style with structured
 *     `function_call` / `function_call_output` items and `previous_response_id`
 *     chaining. No documented cancel.
 *
 * On the first `startSession` we probe `GET /v1/capabilities` (real shape:
 * `{ features: { run_submission, run_events_sse, run_stop, responses_api,
 * chat_completions } }`) and pick a transport: prefer `/v1/runs`, fall back
 * to `/v1/responses`, last to `/v1/chat/completions` (shared with the
 * generic OpenAI-compatible driver).
 *
 * Approvals are supported on `/v1/runs` through
 * `POST /v1/runs/{id}/approval`. Structured user-input prompts are only
 * available through ACP, handled by the separate Hermes ACP driver.
 *
 * @module provider/Layers/HermesAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type HermesSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
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
import {
  buildOpenAiRequest,
  executeOpenAiRequest,
  failOnNonSuccess,
  fireAndForgetPost,
  isLoopbackUrl,
  normalizeOpenAiBaseUrl,
} from "../openaiCompatible/openaiHttp.ts";
import {
  runOpenAiChatCompletionsTurn,
  type OpenAiChatMessage,
} from "../openaiCompatible/openaiChatCompletions.ts";
import { consumeSseStream, type ParsedSseEvent, safeJsonParse } from "../openaiCompatible/openaiSse.ts";

const PROVIDER = ProviderDriverKind.make("hermes");

// ─────────────────────────────────────────────────────────────────────────────
// Capability probe
// ─────────────────────────────────────────────────────────────────────────────

type HermesTransport = "runs" | "responses" | "chat_completions";

interface HermesCapabilitiesProbe {
  readonly transport: HermesTransport;
  readonly raw: Record<string, unknown>;
}

/**
 * Pick the preferred transport from a `GET /v1/capabilities` response.
 *
 * Real Hermes shape: `{ features: { chat_completions, responses_api,
 * run_submission, run_status, run_events_sse, run_stop, ... } }` — flags
 * nested under `.features`.
 *
 * Prefer `/v1/runs` (has documented cancel), fall back to `/v1/responses`
 * (rich tool events but no cancel), and last to `/v1/chat/completions`.
 * Exported for unit tests.
 */
export function pickTransport(capabilities: Record<string, unknown>): HermesTransport {
  const features =
    typeof capabilities.features === "object" && capabilities.features !== null
      ? (capabilities.features as Record<string, unknown>)
      : {};
  const isTrue = (key: string) => features[key] === true;
  if (isTrue("run_submission") && isTrue("run_events_sse") && isTrue("run_stop")) {
    return "runs";
  }
  if (isTrue("responses_api")) {
    return "responses";
  }
  return "chat_completions";
}

function classifyToolName(toolName: string): ToolLifecycleItemType {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("command"))
    return "command_execution";
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("patch") ||
    lower.includes("apply")
  )
    return "file_change";
  if (lower.includes("web") || lower.includes("search")) return "web_search";
  if (lower.includes("mcp")) return "mcp_tool_call";
  if (lower.includes("image") || lower.includes("vision")) return "image_view";
  return "dynamic_tool_call";
}

function toJsonStringSafe(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function approvalChoice(decision: ProviderApprovalDecision): "once" | "session" | "deny" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "session";
    case "decline":
    case "cancel":
      return "deny";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

interface HermesSessionContext {
  session: ProviderSession;
  readonly directory: string | undefined;
  readonly history: Array<OpenAiChatMessage>;
  readonly pendingApprovals: Map<
    ApprovalRequestId,
    {
      readonly runId: string;
      readonly turnId: TurnId;
      readonly requestType: "dynamic_tool_call";
    }
  >;
  /**
   * Server-side conversation chaining for `/v1/responses`. We hand Hermes
   * `previous_response_id` to keep the agent's state across turns instead
   * of resending the full history.
   */
  lastResponseId: string | undefined;
  /**
   * Active `/v1/runs` run id, set right after a `POST /v1/runs` response
   * is parsed. Cleared on turn completion or abort. `interruptTurn` uses
   * it to call `POST /v1/runs/{id}/stop`.
   */
  activeRunId: string | undefined;
  /**
   * Owns the active turn's HTTP scope. Closing it cancels the in-flight
   * SSE stream (best-effort cancel for `/v1/responses` and `/v1/chat/completions`).
   */
  activeTurnScope: Scope.Closeable | undefined;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────────────────────────────────────

export interface HermesAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function makeHermesAdapter(
  hermesSettings: HermesSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const httpClient = yield* HttpClient.HttpClient;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, HermesSessionContext>();
    const capabilitiesRef = yield* Ref.make<HermesCapabilitiesProbe | undefined>(undefined);

    // ─── helpers ─────────────────────────────────────────────────────────────

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
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
        };
      });

    const resolvedBaseUrl = () => {
      const raw = hermesSettings.baseUrl.trim();
      if (raw.length === 0) return undefined;
      return normalizeOpenAiBaseUrl(raw);
    };
    const apiTokenValue = () => hermesSettings.apiToken.trim();

    const requireBaseUrl = (
      operation: string,
    ): Effect.Effect<string, ProviderAdapterValidationError> => {
      const url = resolvedBaseUrl();
      if (!url) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: "Hermes base URL is not configured.",
          }),
        );
      }
      const token = apiTokenValue();
      if (token.length === 0 && !isLoopbackUrl(url)) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: `Hermes API token is required for non-loopback base URLs (${url}).`,
          }),
        );
      }
      return Effect.succeed(url);
    };

    const ensureCapabilities = (baseUrl: string) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(capabilitiesRef);
        if (cached) return cached;
        const token = apiTokenValue();
        const request = buildOpenAiRequest({
          method: "GET",
          baseUrl,
          path: "/v1/capabilities",
          ...(token.length > 0 ? { apiToken: token } : {}),
        });
        const exit = yield* Effect.exit(
          httpClient.execute(request).pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? response.json
                : Effect.succeed({} as unknown),
            ),
          ),
        );
        const raw: Record<string, unknown> =
          exit._tag === "Success" && typeof exit.value === "object" && exit.value !== null
            ? (exit.value as Record<string, unknown>)
            : {};
        const probe: HermesCapabilitiesProbe = {
          raw,
          transport: pickTransport(raw),
        };
        yield* Ref.set(capabilitiesRef, probe);
        return probe;
      });

    // ─── lifecycle helpers ───────────────────────────────────────────────────

    function ensureSessionContext(threadId: ThreadId): HermesSessionContext {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (Ref.getUnsafe(context.stopped)) {
        throw new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    }

    const stopHermesContext = Effect.fn("stopHermesContext")(function* (
      context: HermesSessionContext,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return false;
      }
      const baseUrl = resolvedBaseUrl();
      const token = apiTokenValue();
      if (baseUrl && context.activeRunId) {
        yield* fireAndForgetPost(
          httpClient,
          baseUrl,
          `/v1/runs/${context.activeRunId}/stop`,
          token.length > 0 ? token : undefined,
          {},
        );
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
        yield* Effect.forEach(
          contexts,
          (ctx) => Effect.ignoreCause(stopHermesContext(ctx)),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const updateProviderSession = (
      context: HermesSessionContext,
      patch: Partial<ProviderSession>,
      flags?: {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      },
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

    // ─── per-transport turn runners ──────────────────────────────────────────

    /**
     * Structured SSE handler for `/v1/responses`, which uses OpenAI
     * Responses event names.
     */
    const handleStructuredSseEvent = (
      input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly assistantItemId: string;
      },
      sseEvent: ParsedSseEvent,
      state: { assistantText: string; lastResponseId: string | undefined },
    ) =>
      Effect.gen(function* () {
        if (sseEvent.data.length === 0) return;
        if (sseEvent.data === "[DONE]") return;
        const payload = safeJsonParse(sseEvent.data);
        if (!payload || typeof payload !== "object") return;
        const eventType = sseEvent.event ?? (payload as { type?: string }).type;

        switch (eventType) {
          case "response.created": {
            const id = (payload as { response?: { id?: unknown } }).response?.id;
            if (typeof id === "string") state.lastResponseId = id;
            return;
          }
          case "response.output_text.delta": {
            const delta = (payload as { delta?: unknown }).delta;
            if (typeof delta !== "string" || delta.length === 0) return;
            state.assistantText += delta;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId: input.turnId,
                itemId: input.assistantItemId,
              })),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            });
            return;
          }
          case "response.output_item.added": {
            const item = (payload as {
              item?: { type?: unknown; name?: unknown; call_id?: unknown };
            }).item;
            if (!item || typeof item !== "object") return;
            if (item.type === "function_call") {
              const toolName = typeof item.name === "string" ? item.name : "tool";
              const callId = typeof item.call_id === "string" ? item.call_id : null;
              if (!callId) return;
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: callId,
                })),
                type: "item.started",
                payload: {
                  itemType: classifyToolName(toolName),
                  status: "inProgress",
                  title: toolName,
                  data: { tool: toolName, item },
                },
              });
            }
            return;
          }
          case "response.output_item.done": {
            const item = (payload as {
              item?: { type?: unknown; name?: unknown; call_id?: unknown; output?: unknown };
            }).item;
            if (!item || typeof item !== "object") return;
            if (item.type === "function_call_output" || item.type === "function_call") {
              const callId = typeof item.call_id === "string" ? item.call_id : null;
              if (!callId) return;
              const toolName = typeof item.name === "string" ? item.name : "tool";
              const detail =
                typeof item.output === "string"
                  ? item.output
                  : item.output !== undefined
                    ? toJsonStringSafe(item.output)
                    : undefined;
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: callId,
                })),
                type: "item.completed",
                payload: {
                  itemType: classifyToolName(toolName),
                  status: "completed",
                  title: toolName,
                  ...(detail ? { detail } : {}),
                  data: { tool: toolName, item },
                },
              });
            }
            return;
          }
          case "response.completed": {
            if (state.assistantText.length > 0) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.threadId,
                  turnId: input.turnId,
                  itemId: input.assistantItemId,
                })),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  detail: state.assistantText,
                },
              });
            }
            return;
          }
          case "hermes.tool.progress": {
            const message =
              (payload as { message?: unknown }).message ??
              (payload as { name?: unknown }).name;
            if (typeof message !== "string" || message.length === 0) return;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId: input.turnId,
              })),
              type: "runtime.warning",
              payload: { message, detail: payload },
            });
            return;
          }
          default:
            return;
        }
      });

    const handleRunSseEvent = (
      input: {
        readonly context: HermesSessionContext;
        readonly turnId: TurnId;
        readonly assistantItemId: string;
      },
      sseEvent: ParsedSseEvent,
      state: { assistantText: string; runError: string | undefined },
    ) =>
      Effect.gen(function* () {
        if (sseEvent.data.length === 0) return;
        if (sseEvent.data === "[DONE]") return;
        const payload = safeJsonParse(sseEvent.data);
        if (!payload || typeof payload !== "object") return;

        const eventType = readString((payload as { event?: unknown }).event) ?? sseEvent.event;

        switch (eventType) {
          case "message.delta": {
            const delta = readString((payload as { delta?: unknown }).delta);
            if (!delta) return;
            state.assistantText += delta;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId: input.assistantItemId,
              })),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            });
            return;
          }
          case "reasoning.available": {
            const text = readString((payload as { text?: unknown }).text);
            if (!text) return;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId: `hermes-reasoning-${input.turnId}`,
              })),
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: text },
            });
            return;
          }
          case "tool.started": {
            const toolName = readString((payload as { tool?: unknown }).tool) ?? "tool";
            const itemId =
              readString((payload as { tool_call_id?: unknown }).tool_call_id) ??
              readString((payload as { id?: unknown }).id) ??
              `hermes-tool-${toolName}`;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId,
              })),
              type: "item.started",
              payload: {
                itemType: classifyToolName(toolName),
                status: "inProgress",
                title: toolName,
                data: payload,
              },
            });
            return;
          }
          case "tool.completed": {
            const toolName = readString((payload as { tool?: unknown }).tool) ?? "tool";
            const itemId =
              readString((payload as { tool_call_id?: unknown }).tool_call_id) ??
              readString((payload as { id?: unknown }).id) ??
              `hermes-tool-${toolName}`;
            const preview = readString((payload as { preview?: unknown }).preview);
            const isError = (payload as { error?: unknown }).error === true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId,
              })),
              type: "item.completed",
              payload: {
                itemType: classifyToolName(toolName),
                status: isError ? "failed" : "completed",
                title: toolName,
                ...(preview ? { detail: preview } : {}),
                data: payload,
              },
            });
            return;
          }
          case "approval.request": {
            const runId = readString((payload as { run_id?: unknown }).run_id);
            if (!runId) return;
            const rawRequestId =
              readString((payload as { request_id?: unknown }).request_id) ??
              readString((payload as { approval_id?: unknown }).approval_id) ??
              `hermes-approval-${runId}`;
            const requestId = ApprovalRequestId.make(rawRequestId);
            input.context.pendingApprovals.set(requestId, {
              runId,
              turnId: input.turnId,
              requestType: "dynamic_tool_call",
            });
            const detail =
              readString((payload as { message?: unknown }).message) ??
              readString((payload as { prompt?: unknown }).prompt) ??
              "Hermes is requesting approval to continue.";
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                requestId,
              })),
              type: "request.opened",
              providerRefs: { providerRequestId: runId },
              payload: {
                requestType: "dynamic_tool_call",
                detail,
                args: payload,
              },
            });
            return;
          }
          case "run.failed": {
            state.runError =
              readString((payload as { error?: unknown }).error) ?? "Hermes run failed.";
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
              })),
              type: "runtime.error",
              payload: { message: state.runError },
            });
            return;
          }
          case "run.cancelled": {
            state.runError = "Hermes run was cancelled.";
            return;
          }
          case "run.completed": {
            const output = readString((payload as { output?: unknown }).output);
            if (output && state.assistantText.length === 0) {
              state.assistantText = output;
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  itemId: input.assistantItemId,
                })),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: output },
              });
            }
            return;
          }
          default:
            return;
        }
      });

    const runChatCompletions = (input: {
      readonly context: HermesSessionContext;
      readonly baseUrl: string;
      readonly turnId: TurnId;
      readonly userMessage: string;
      readonly model: string;
    }) =>
      Effect.gen(function* () {
        input.context.history.push({ role: "user", content: input.userMessage });
        const assistantItemId = `hermes-assistant-${yield* Random.nextUUIDv4}`;
        const token = apiTokenValue();
        const assistantText = yield* runOpenAiChatCompletionsTurn({
          httpClient,
          provider: PROVIDER,
          baseUrl: input.baseUrl,
          ...(token.length > 0 ? { apiToken: token } : {}),
          model: input.model,
          messages: input.context.history,
          onDelta: (delta) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  itemId: assistantItemId,
                })),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta },
              });
            }),
          onToolProgress: (payload) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                })),
                type: "runtime.warning",
                payload: { message: "Hermes tool progress", detail: payload },
              });
            }),
        });
        if (assistantText.length > 0) {
          input.context.history.push({ role: "assistant", content: assistantText });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
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
      });

    const runResponsesTurn = (input: {
      readonly context: HermesSessionContext;
      readonly baseUrl: string;
      readonly turnId: TurnId;
      readonly userMessage: string;
      readonly model: string;
    }) =>
      Effect.gen(function* () {
        const previousResponseId = input.context.lastResponseId;
        input.context.history.push({ role: "user", content: input.userMessage });

        const token = apiTokenValue();
        const requestBody: Record<string, unknown> = {
          model: input.model,
          stream: true,
          // Required for `previous_response_id` chaining to work; Hermes
          // LRU-stores up to ~100 responses per gateway.
          store: true,
          input: input.userMessage,
          conversation: input.context.session.threadId,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        };

        const request = buildOpenAiRequest({
          method: "POST",
          baseUrl: input.baseUrl,
          path: "/v1/responses",
          ...(token.length > 0 ? { apiToken: token } : {}),
          body: requestBody,
          accept: "text/event-stream",
        });
        const response = yield* executeOpenAiRequest(httpClient, PROVIDER, "/v1/responses", request);
        yield* failOnNonSuccess(PROVIDER, "/v1/responses", response);

        const state = {
          assistantText: "",
          lastResponseId: input.context.lastResponseId,
        };
        const assistantItemId = `hermes-assistant-${yield* Random.nextUUIDv4}`;

        yield* consumeSseStream(PROVIDER, "/v1/responses", response.stream, (sseEvent) =>
          handleStructuredSseEvent(
            {
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              assistantItemId,
            },
            sseEvent,
            state,
          ),
        );

        if (state.lastResponseId !== undefined) {
          input.context.lastResponseId = state.lastResponseId;
        }
        if (state.assistantText.length > 0) {
          input.context.history.push({ role: "assistant", content: state.assistantText });
        }
      });

    const runRunsTurn = (input: {
      readonly context: HermesSessionContext;
      readonly baseUrl: string;
      readonly turnId: TurnId;
      readonly userMessage: string;
      readonly model: string;
    }) =>
      Effect.gen(function* () {
        input.context.history.push({ role: "user", content: input.userMessage });
        const token = apiTokenValue();

        const startRequest = buildOpenAiRequest({
          method: "POST",
          baseUrl: input.baseUrl,
          path: "/v1/runs",
          ...(token.length > 0 ? { apiToken: token } : {}),
          body: {
            model: input.model,
            session_id: input.context.session.threadId,
            input: input.userMessage,
          },
        });
        const startResponse = yield* executeOpenAiRequest(httpClient, PROVIDER, "/v1/runs", startRequest);
        yield* failOnNonSuccess(PROVIDER, "/v1/runs", startResponse);
        const startPayload = yield* startResponse.json.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "/v1/runs",
                detail: "Hermes /v1/runs returned a non-JSON response.",
                cause,
              }),
          ),
        );
        const runId =
          typeof startPayload === "object" && startPayload !== null
            ? ((startPayload as { id?: unknown }).id ??
                (startPayload as { run_id?: unknown }).run_id)
            : undefined;
        if (typeof runId !== "string" || runId.length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "/v1/runs",
            detail: "Hermes /v1/runs response did not include a run id.",
          });
        }
        input.context.activeRunId = runId;

        const eventsRequest = buildOpenAiRequest({
          method: "GET",
          baseUrl: input.baseUrl,
          path: `/v1/runs/${runId}/events`,
          ...(token.length > 0 ? { apiToken: token } : {}),
          accept: "text/event-stream",
        });
        const eventsResponse = yield* executeOpenAiRequest(
          httpClient,
          PROVIDER,
          "/v1/runs/{id}/events",
          eventsRequest,
        );
        yield* failOnNonSuccess(PROVIDER, "/v1/runs/{id}/events", eventsResponse);

        const state = {
          assistantText: "",
          runError: undefined as string | undefined,
        };
        const assistantItemId = `hermes-assistant-${yield* Random.nextUUIDv4}`;

        yield* consumeSseStream(
          PROVIDER,
          "/v1/runs/{id}/events",
          eventsResponse.stream,
          (sseEvent) =>
            handleRunSseEvent(
              {
                context: input.context,
                turnId: input.turnId,
                assistantItemId,
              },
              sseEvent,
              state,
            ),
        );

        if (state.runError) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "/v1/runs/{id}/events",
            detail: state.runError,
          });
        }
        if (state.assistantText.length > 0) {
          input.context.history.push({ role: "assistant", content: state.assistantText });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              itemId: assistantItemId,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: state.assistantText,
            },
          });
        }
        input.context.activeRunId = undefined;
      });

    // ─── SPI ─────────────────────────────────────────────────────────────────

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
      "startSession",
    )(function* (input) {
      const baseUrl = yield* requireBaseUrl("startSession");
      yield* ensureCapabilities(baseUrl);

      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* stopHermesContext(existing);
        sessions.delete(input.threadId);
      }

      const sessionScope = yield* Scope.make();
      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
      const context: HermesSessionContext = {
        session,
        directory: input.cwd,
        history: [],
        pendingApprovals: new Map(),
        lastResponseId: undefined,
        activeRunId: undefined,
        activeTurnScope: undefined,
        activeTurnId: undefined,
        stopped: yield* Ref.make(false),
        sessionScope,
      };
      sessions.set(input.threadId, context);

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "Hermes session started" },
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
        const turnId = TurnId.make(`hermes-turn-${yield* Random.nextUUIDv4}`);
        const userMessage = input.input?.trim();
        if (!userMessage || userMessage.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Hermes turns require non-empty text input.",
          });
        }
        // Hermes treats the model field as cosmetic — actual LLM is in
        // server-side config. We default to the docs' advertised name.
        const model = input.modelSelection?.model ?? context.session.model ?? "hermes-agent";

        const capabilities = yield* ensureCapabilities(baseUrl);

        context.activeTurnId = turnId;
        const turnScope = yield* Scope.make();
        context.activeTurnScope = turnScope;
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

        const runner =
          capabilities.transport === "runs"
            ? runRunsTurn({ context, baseUrl, turnId, userMessage, model })
            : capabilities.transport === "responses"
              ? runResponsesTurn({ context, baseUrl, turnId, userMessage, model })
              : runChatCompletions({ context, baseUrl, turnId, userMessage, model });

        const exit = yield* Effect.exit(
          runner.pipe(Effect.provideService(Scope.Scope, turnScope)),
        );

        yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);
        if (context.activeTurnScope === turnScope) context.activeTurnScope = undefined;
        if (context.activeTurnId === turnId) context.activeTurnId = undefined;
        const activeRunId = context.activeRunId;
        context.activeRunId = undefined;

        if (Exit.isFailure(exit)) {
          const failure = Cause.squash(exit.cause);
          const detail =
            failure instanceof Error ? failure.message : "Hermes turn failed unexpectedly.";
          yield* updateProviderSession(
            context,
            { status: "ready", model, lastError: detail },
            { clearActiveTurnId: true },
          );
          if (Cause.hasInterruptsOnly(exit.cause)) {
            const token = apiTokenValue();
            if (activeRunId) {
              yield* fireAndForgetPost(
                httpClient,
                baseUrl,
                `/v1/runs/${activeRunId}/stop`,
                token.length > 0 ? token : undefined,
                {},
              );
            }
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
            provider: PROVIDER,
            threadId: input.threadId,
            detail,
            cause: failure,
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
      const activeRunId = context.activeRunId;
      const baseUrl = resolvedBaseUrl();
      const token = apiTokenValue();
      if (turnScope) {
        yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);
      }
      if (baseUrl && activeRunId) {
        yield* fireAndForgetPost(
          httpClient,
          baseUrl,
          `/v1/runs/${activeRunId}/stop`,
          token.length > 0 ? token : undefined,
          {},
        );
      }
    });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] =
      Effect.fn("respondToRequest")(function* (threadId, requestId, decision) {
        const context = ensureSessionContext(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        const baseUrl = yield* requireBaseUrl("respondToRequest");
        const token = apiTokenValue();
        const request = buildOpenAiRequest({
          method: "POST",
          baseUrl,
          path: `/v1/runs/${pending.runId}/approval`,
          ...(token.length > 0 ? { apiToken: token } : {}),
          body: { choice: approvalChoice(decision) },
        });
        const response = yield* executeOpenAiRequest(
          httpClient,
          PROVIDER,
          "/v1/runs/{id}/approval",
          request,
        );
        yield* failOnNonSuccess(PROVIDER, "/v1/runs/{id}/approval", response);
        context.pendingApprovals.delete(requestId);
        yield* updateProviderSession(context, { status: "running" });
        yield* emit({
          ...(yield* buildEventBase({
            threadId,
            turnId: pending.turnId,
            requestId,
          })),
          type: "request.resolved",
          providerRefs: { providerRequestId: pending.runId },
          payload: {
            requestType: pending.requestType,
            decision,
          },
        });
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
      Effect.fn("respondToUserInput")(function* (_threadId, _requestId, _answers) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "Hermes HTTP transports do not support structured user-input requests.",
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
      "stopSession",
    )(function* (threadId) {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      const stopped = yield* stopHermesContext(context);
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
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "Hermes HTTP transports do not support thread rollback.",
      });
    });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (ctx) => Effect.ignoreCause(stopHermesContext(ctx)),
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
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
