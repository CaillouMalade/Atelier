/**
 * Streaming `POST /v1/chat/completions` runner shared by every OpenAI-
 * compatible HTTP backend (Ollama, LM Studio, Hermes, OpenRouter, …).
 *
 * Each backend's adapter passes:
 *   - a base URL (already normalized)
 *   - an optional API token
 *   - the OpenAI-shaped `messages` array (Atelier owns history)
 *   - a `model` string (cosmetic for Hermes, meaningful elsewhere)
 *
 * The runner does the HTTP round-trip, parses the SSE stream, and invokes
 * the caller's `onDelta` callback for each non-empty `choices[].delta.content`
 * chunk. Tool-call deltas are surfaced via `onToolCall` when present.
 *
 * Hermes' custom `event: hermes.tool.progress` is also recognised and
 * forwarded to `onToolProgress` so callers can render a "<tool> running"
 * indicator without polluting the assistant text.
 *
 * @module provider/openaiCompatible/openaiChatCompletions
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  buildOpenAiRequest,
  executeOpenAiRequest,
  failOnNonSuccess,
  type HttpClientService,
} from "./openaiHttp.ts";
import { consumeSseStream, safeJsonParse } from "./openaiSse.ts";

export interface OpenAiChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface OpenAiToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
}

export interface RunChatCompletionsInput {
  readonly httpClient: HttpClientService;
  readonly provider: ProviderDriverKind;
  readonly baseUrl: string;
  readonly apiToken?: string | undefined;
  readonly model: string;
  readonly messages: ReadonlyArray<OpenAiChatMessage>;
  readonly extraRequestFields?: Record<string, unknown> | undefined;
  readonly onDelta: (delta: string) => Effect.Effect<void>;
  readonly onToolCall?: (delta: OpenAiToolCallDelta) => Effect.Effect<void>;
  readonly onToolProgress?: (payload: unknown) => Effect.Effect<void>;
}

/**
 * Run one streaming chat-completions turn end-to-end. Returns the full
 * assistant text accumulated across all deltas so the caller can append it
 * to their conversation history.
 *
 * The caller passes its already-yielded `HttpClient` service value so the
 * runner's R channel stays empty.
 */
export const runOpenAiChatCompletionsTurn = (
  input: RunChatCompletionsInput,
): Effect.Effect<string, ProviderAdapterRequestError> =>
  Effect.gen(function* () {
    const requestBody = {
      ...(input.extraRequestFields ?? {}),
      model: input.model,
      stream: true,
      messages: input.messages.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
    };

    const request = buildOpenAiRequest({
      method: "POST",
      baseUrl: input.baseUrl,
      path: "/v1/chat/completions",
      ...(input.apiToken !== undefined ? { apiToken: input.apiToken } : {}),
      body: requestBody,
      accept: "text/event-stream",
    });
    const response = yield* executeOpenAiRequest(
      input.httpClient,
      input.provider,
      "/v1/chat/completions",
      request,
    );
    yield* failOnNonSuccess(input.provider, "/v1/chat/completions", response);

    let assistantText = "";

    yield* consumeSseStream(
      input.provider,
      "/v1/chat/completions",
      response.stream,
      (sseEvent) =>
        Effect.gen(function* () {
          if (sseEvent.data.length === 0) return;
          if (sseEvent.data === "[DONE]") return;

          // Hermes-specific tool-progress event — surfaced if the caller
          // hooked it. Falls through silently for other backends.
          if (sseEvent.event === "hermes.tool.progress") {
            if (input.onToolProgress) {
              const payload = safeJsonParse(sseEvent.data) ?? sseEvent.data;
              yield* input.onToolProgress(payload);
            }
            return;
          }

          const payload = safeJsonParse(sseEvent.data);
          if (!payload || typeof payload !== "object") return;
          const choices = (payload as { choices?: unknown }).choices;
          if (!Array.isArray(choices) || choices.length === 0) return;
          const first = choices[0] as
            | { delta?: { content?: unknown; tool_calls?: unknown } }
            | undefined;
          const contentDelta = first?.delta?.content;
          if (typeof contentDelta === "string" && contentDelta.length > 0) {
            assistantText += contentDelta;
            yield* input.onDelta(contentDelta);
          }
          const toolCalls = first?.delta?.tool_calls;
          if (Array.isArray(toolCalls) && input.onToolCall) {
            for (const rawCall of toolCalls) {
              if (!rawCall || typeof rawCall !== "object") continue;
              const obj = rawCall as {
                index?: unknown;
                id?: unknown;
                function?: { name?: unknown; arguments?: unknown };
              };
              const idx = typeof obj.index === "number" ? obj.index : 0;
              yield* input.onToolCall({
                index: idx,
                ...(typeof obj.id === "string" ? { id: obj.id } : {}),
                ...(typeof obj.function?.name === "string" ? { name: obj.function.name } : {}),
                ...(typeof obj.function?.arguments === "string"
                  ? { argumentsDelta: obj.function.arguments }
                  : {}),
              });
            }
          }
        }),
    );

    return assistantText;
  });
