/**
 * Shared HTTP helpers for every OpenAI-compatible backend in Atelier.
 *
 * Handles:
 *   - base URL normalization (accept both `host:port` and `host:port/v1`)
 *   - bearer-token authorization
 *   - JSON request/response construction
 *   - per-status error mapping to `ProviderAdapterRequestError`
 *
 * This module is intentionally protocol-agnostic — it knows nothing about
 * Hermes' runs API or Ollama-specific quirks. Per-driver adapters compose
 * these helpers with their own request shapes and SSE event handlers.
 *
 * @module provider/openaiCompatible/openaiHttp
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ProviderAdapterRequestError } from "../Errors.ts";

/**
 * The HttpClient service value type — what you get from
 * `yield* HttpClient.HttpClient`. Re-exported so the shared helpers and
 * adapters can type parameters without re-deriving it everywhere.
 */
export type HttpClientService = Context.Service.Shape<typeof HttpClient.HttpClient>;

/**
 * Strip a trailing `/v1` (or `/v1/`) and any trailing slashes from a
 * user-provided base URL. Internal code always works with the canonical
 * root, so paths like `/v1/chat/completions` and `/health` are unambiguous.
 */
export function normalizeOpenAiBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/u, "");
  return trimmed.replace(/\/v1$/u, "");
}

/**
 * Loopback check used by the snapshot probes to decide whether the API
 * token is mandatory.
 */
export function isLoopbackUrl(rawBaseUrl: string): boolean {
  try {
    const url = new URL(rawBaseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export interface OpenAiRequestOptions {
  readonly method: "GET" | "POST";
  readonly baseUrl: string;
  readonly path: string;
  readonly apiToken?: string | undefined;
  readonly body?: unknown;
  readonly accept?: string | undefined;
}

/**
 * Build an authorized HTTP request against an OpenAI-compatible endpoint.
 * Caller decides Accept; default is JSON. POST with a `body` uses
 * `bodyJsonUnsafe` (sets content-type and serializes via JSON.stringify).
 */
export function buildOpenAiRequest(
  options: OpenAiRequestOptions,
): HttpClientRequest.HttpClientRequest {
  const url = `${options.baseUrl}${options.path}`;
  const builder =
    options.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
  const accept = options.accept ?? "application/json";
  let request = builder.pipe(HttpClientRequest.setHeader("accept", accept));
  if (options.apiToken && options.apiToken.length > 0) {
    request = request.pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${options.apiToken}`),
    );
  }
  if (options.body !== undefined) {
    request = request.pipe(HttpClientRequest.bodyJsonUnsafe(options.body));
  }
  return request;
}

/**
 * Execute an HTTP request and map transport failures to a typed adapter
 * error so callers can stay in `ProviderAdapterError` territory.
 *
 * Takes the HttpClient service value explicitly (yielded once by the caller
 * at adapter construction) so the helper's R channel stays empty — callers
 * can compose it inside SPI methods without leaking `HttpClient` into the
 * adapter's published return type.
 */
export const executeOpenAiRequest = (
  httpClient: HttpClientService,
  provider: ProviderDriverKind,
  method: string,
  request: HttpClientRequest.HttpClientRequest,
) =>
  httpClient.execute(request).pipe(
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

/**
 * Convert a non-2xx response into a `ProviderAdapterRequestError`. Pulls a
 * short body excerpt for diagnostics; explicitly recognises 401/403 as auth
 * failures so the user can be told to check their API token.
 */
export const failOnNonSuccess = <E>(
  provider: ProviderDriverKind,
  method: string,
  response: { readonly status: number; readonly text: Effect.Effect<string, E> },
): Effect.Effect<void, ProviderAdapterRequestError> =>
  Effect.gen(function* () {
    if (response.status >= 200 && response.status < 300) {
      return;
    }
    const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const isAuth = response.status === 401 || response.status === 403;
    const detail = isAuth
      ? `Authentication rejected (HTTP ${response.status}). Check the API token.${bodyText ? ` ${bodyText.slice(0, 500)}` : ""}`
      : `HTTP ${response.status}.${bodyText ? ` ${bodyText.slice(0, 500)}` : ""}`;
    return yield* new ProviderAdapterRequestError({ provider, method, detail });
  });

/**
 * Fire a POST request and ignore the result. Used for best-effort cancel /
 * cleanup calls where we don't want to fail the calling operation if the
 * remote rejects or is unreachable.
 */
export const fireAndForgetPost = (
  httpClient: HttpClientService,
  baseUrl: string,
  path: string,
  apiToken: string | undefined,
  body: unknown,
) => {
  const request = buildOpenAiRequest({
    method: "POST",
    baseUrl,
    path,
    ...(apiToken !== undefined ? { apiToken } : {}),
    body,
  });
  return httpClient.execute(request).pipe(Effect.ignore);
};
