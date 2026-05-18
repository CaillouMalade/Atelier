/**
 * SSE parsing utilities shared by every OpenAI-compatible HTTP transport
 * (chat completions, responses, runs).
 *
 * The OpenAI streaming wire format is:
 *
 *   data: {"choices":[{"delta":{"content":"hello"}}]}\n\n
 *   data: {"choices":[{"delta":{"content":" world"}}]}\n\n
 *   data: [DONE]\n\n
 *
 * Strict SSE adds `event: <name>` lines (Hermes' `/v1/responses` and the
 * `hermes.tool.progress` convenience event). Multi-line `data:` payloads
 * are joined with newlines per the SSE spec.
 *
 * `parseSseBlock` is pure and unit-tested. `consumeSseStream` is the
 * Effect-aware driver that handles chunk reassembly across TCP packet
 * boundaries.
 *
 * @module provider/openaiCompatible/openaiSse
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ParsedSseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Parse a single SSE block (the text between two `\n\n` delimiters).
 *
 * Returns `null` for an empty block — both empty `data:` lines and no
 * `event:` / `data:` lines at all collapse to "no observable event".
 * Multi-line `data:` payloads are joined with newlines per the SSE spec.
 */
export function parseSseBlock(block: string): ParsedSseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && !eventName) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

/**
 * Best-effort JSON parsing — returns `undefined` instead of throwing so we
 * silently skip non-JSON payloads (keep-alive comments, malformed chunks).
 */
export function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Consume an SSE response body, invoking `onEvent` for each event block.
 * Buffers across chunk boundaries so events split across TCP packets are
 * still delivered intact. Failures in the underlying stream are mapped to
 * `ProviderAdapterRequestError` so callers don't have to widen their error
 * type with `HttpClientError`.
 */
export const consumeSseStream = (
  provider: ProviderDriverKind,
  method: string,
  stream: Stream.Stream<Uint8Array, unknown>,
  onEvent: (event: ParsedSseEvent) => Effect.Effect<void>,
): Effect.Effect<void, ProviderAdapterRequestError> => {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flush = (): Array<ParsedSseEvent> => {
    const events: Array<ParsedSseEvent> = [];
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const parsed = parseSseBlock(block);
      if (parsed) events.push(parsed);
      index = buffer.indexOf("\n\n");
    }
    return events;
  };
  return stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        buffer += decoder.decode(chunk, { stream: true });
        const events = flush();
        for (const evt of events) {
          yield* onEvent(evt);
        }
      }),
    ),
    Effect.flatMap(() =>
      Effect.gen(function* () {
        buffer += decoder.decode();
        const trailing = flush();
        for (const evt of trailing) {
          yield* onEvent(evt);
        }
        if (buffer.trim().length > 0) {
          const parsed = parseSseBlock(buffer);
          buffer = "";
          if (parsed) yield* onEvent(parsed);
        }
      }),
    ),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider,
          method,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );
};
