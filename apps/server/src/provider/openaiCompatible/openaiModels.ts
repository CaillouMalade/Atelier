/**
 * Shared `GET /v1/models` probe for every OpenAI-compatible backend.
 *
 * Returns the parsed model list (or `null` on failure) plus the auth-status
 * classification a caller can fold into its snapshot. The caller decides
 * whether an empty model list is fatal or just a warning.
 *
 * @module provider/openaiCompatible/openaiModels
 */
import type {
  ModelCapabilities,
  ProviderDriverKind,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { nonEmptyTrimmed } from "../providerSnapshot.ts";
import { buildOpenAiRequest } from "./openaiHttp.ts";

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      object: Schema.optional(Schema.String),
      owned_by: Schema.optional(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const decodeModelsResponse = Schema.decodeUnknownEffect(ModelsResponse);

export type OpenAiModelsOutcome =
  | { readonly status: "ok"; readonly models: ReadonlyArray<ServerProviderModel> }
  | { readonly status: "unauthorized"; readonly detail: string }
  | { readonly status: "unreachable"; readonly detail: string }
  | { readonly status: "malformed"; readonly detail: string };

export interface ProbeModelsInput {
  readonly provider: ProviderDriverKind;
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly timeoutMs?: number;
  readonly defaultCapabilities: ModelCapabilities;
}

/**
 * Probe `GET {baseUrl}/v1/models`. Returns a structured outcome so the
 * caller (snapshot, settings probe, …) can attach a precise status message.
 */
export const probeOpenAiModels = (
  input: ProbeModelsInput,
): Effect.Effect<OpenAiModelsOutcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = buildOpenAiRequest({
      method: "GET",
      baseUrl: input.baseUrl,
      path: "/v1/models",
      apiToken: input.apiToken,
    });
    const exit = yield* Effect.exit(
      httpClient.execute(request).pipe(Effect.timeout(input.timeoutMs ?? 5_000)),
    );
    if (exit._tag === "Failure") {
      const message = exit.cause.toString();
      return { status: "unreachable", detail: message };
    }
    const response = exit.value;
    if (response.status === 401 || response.status === 403) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return {
        status: "unauthorized",
        detail: `HTTP ${response.status} from /v1/models${body ? ` — ${body.slice(0, 200)}` : ""}`,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return {
        status: "unreachable",
        detail: `HTTP ${response.status} from /v1/models${body ? ` — ${body.slice(0, 200)}` : ""}`,
      };
    }
    const payloadExit = yield* Effect.exit(response.json);
    if (payloadExit._tag === "Failure") {
      return { status: "malformed", detail: "Non-JSON /v1/models response." };
    }
    const decodedExit = yield* Effect.exit(decodeModelsResponse(payloadExit.value));
    if (decodedExit._tag === "Failure") {
      return {
        status: "malformed",
        detail: "/v1/models did not match the OpenAI schema.",
      };
    }
    const models: ReadonlyArray<ServerProviderModel> = decodedExit.value.data.flatMap((entry) => {
      const slug = nonEmptyTrimmed(entry.id);
      if (!slug) return [];
      return [
        {
          slug,
          name: slug,
          isCustom: false,
          capabilities: input.defaultCapabilities,
        },
      ];
    });
    return { status: "ok", models };
  });
