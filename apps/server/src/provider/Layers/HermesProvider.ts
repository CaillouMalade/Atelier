/**
 * HermesProvider — pending + checked snapshots for a Hermes provider
 * instance. Uses the shared OpenAI-compat probe for `/v1/models` then
 * additionally hits `/health` and `/v1/capabilities` to confirm the public
 * Hermes API surface is enabled (`API_SERVER_ENABLED=true`).
 *
 * @module provider/Layers/HermesProvider
 */
import {
  type HermesSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  buildOpenAiRequest,
  isLoopbackUrl,
  normalizeOpenAiBaseUrl,
} from "../openaiCompatible/openaiHttp.ts";
import { probeOpenAiModels } from "../openaiCompatible/openaiModels.ts";

const PROVIDER = ProviderDriverKind.make("hermes");

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  showInteractionModeToggle: false,
} as const;

const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_HERMES_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

class HermesProbeError extends Data.TaggedError("HermesProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
  readonly authFailure?: boolean;
}> {}

function describeFailure(cause: unknown): string {
  if (cause instanceof HermesProbeError) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return "Hermes probe failed.";
}

function classifyNetworkFailure(baseUrl: string, detail: string): string {
  const lower = detail.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("socket hang up")
  ) {
    return `Couldn't reach the Hermes gateway at ${baseUrl}. Check the URL and that 'hermes' is running.`;
  }
  return detail;
}

function authMessage(baseUrl: string): string {
  return `Hermes gateway at ${baseUrl} rejected authentication. Set the API token to the value of API_SERVER_KEY on the gateway.`;
}

interface HermesProbeOutcome {
  readonly state: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const probeHermesGateway = Effect.fn("probeHermesGateway")(function* (input: {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly hermesSettings: HermesSettings;
}): Effect.fn.Return<HermesProbeOutcome, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;

  const get = (path: string) =>
    httpClient
      .execute(
        buildOpenAiRequest({
          method: "GET",
          baseUrl: input.baseUrl,
          path,
          ...(input.apiToken.length > 0 ? { apiToken: input.apiToken } : {}),
        }),
      )
      .pipe(
        Effect.timeout(PROBE_TIMEOUT_MS),
        Effect.mapError((cause) => new HermesProbeError({ cause, detail: describeFailure(cause) })),
      );

  const requireSuccess = (path: string) =>
    Effect.flatMap(get(path), (response) => {
      if (response.status >= 200 && response.status < 300) {
        return Effect.succeed(response);
      }
      const isAuth = response.status === 401 || response.status === 403;
      return response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((body) =>
          Effect.fail(
            new HermesProbeError({
              cause: undefined,
              detail: `Hermes ${path} returned HTTP ${response.status}.${body ? ` ${body.slice(0, 200)}` : ""}`,
              authFailure: isAuth,
            }),
          ),
        ),
      );
    });

  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    input.hermesSettings.customModels,
    DEFAULT_HERMES_MODEL_CAPABILITIES,
  );

  // /health — fall back to /v1/health if /health 404s (some setups).
  const healthExit = yield* Effect.exit(
    requireSuccess("/health").pipe(
      Effect.catchTag("HermesProbeError", () => requireSuccess("/v1/health")),
    ),
  );
  if (healthExit._tag === "Failure") {
    const cause = Cause.squash(healthExit.cause);
    const probeError = cause instanceof HermesProbeError ? cause : undefined;
    const isAuth = probeError?.authFailure === true;
    return {
      state: "error",
      auth: { status: isAuth ? "unauthenticated" : "unknown" },
      message: isAuth
        ? authMessage(input.baseUrl)
        : classifyNetworkFailure(input.baseUrl, probeError?.detail ?? describeFailure(cause)),
      models: fallbackModels,
    };
  }

  // /v1/capabilities — confirms the public API surface is enabled.
  const capabilitiesExit = yield* Effect.exit(requireSuccess("/v1/capabilities"));
  if (capabilitiesExit._tag === "Failure") {
    const cause = Cause.squash(capabilitiesExit.cause);
    const probeError = cause instanceof HermesProbeError ? cause : undefined;
    const isAuth = probeError?.authFailure === true;
    return {
      state: "warning",
      auth: { status: isAuth ? "unauthenticated" : "unknown" },
      message: isAuth
        ? authMessage(input.baseUrl)
        : `Hermes is reachable but /v1/capabilities is unavailable. Set API_SERVER_ENABLED=true in the gateway config.`,
      models: fallbackModels,
    };
  }

  // /v1/models — non-fatal: report ready/warning depending on result.
  const modelsOutcome = yield* probeOpenAiModels({
    provider: PROVIDER,
    baseUrl: input.baseUrl,
    apiToken: input.apiToken,
    defaultCapabilities: DEFAULT_HERMES_MODEL_CAPABILITIES,
  });
  const builtInModels =
    modelsOutcome.status === "ok"
      ? modelsOutcome.models
      : ([] as ReadonlyArray<ServerProviderModel>);
  const models = providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    input.hermesSettings.customModels,
    DEFAULT_HERMES_MODEL_CAPABILITIES,
  );
  const hasSelectableModels = models.length > 0;
  if (modelsOutcome.status !== "ok") {
    return {
      state: "warning",
      auth: { status: "authenticated", type: "hermes" },
      message: `Hermes is reachable but /v1/models could not be parsed: ${modelsOutcome.detail}`,
      models,
    };
  }
  return {
    state: hasSelectableModels ? "ready" : "warning",
    auth: { status: "authenticated", type: "hermes" },
    message:
      builtInModels.length > 0
        ? `Connected to Hermes at ${input.baseUrl}. Advertised model: ${builtInModels[0]?.slug ?? "unknown"}.`
        : hasSelectableModels
          ? `Connected to Hermes at ${input.baseUrl}; /v1/models is empty, using configured custom models.`
          : `Connected to Hermes at ${input.baseUrl}, but /v1/models returned an empty list.`,
    models,
  };
});

export const makePendingHermesProvider = (
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      hermesSettings.customModels,
      DEFAULT_HERMES_MODEL_CAPABILITIES,
    );

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes provider status has not been checked in this session yet.",
      },
    });
  });

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        hermesSettings.customModels,
        DEFAULT_HERMES_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const rawBaseUrl = hermesSettings.baseUrl.trim();
  if (rawBaseUrl.length === 0) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        hermesSettings.customModels,
        DEFAULT_HERMES_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes base URL is not configured.",
      },
    });
  }

  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);
  const apiToken = hermesSettings.apiToken.trim();

  if (apiToken.length === 0 && !isLoopbackUrl(baseUrl)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        hermesSettings.customModels,
        DEFAULT_HERMES_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: `Hermes API token is required for non-loopback base URLs (${baseUrl}). Set the token to the gateway's API_SERVER_KEY value.`,
      },
    });
  }

  const outcome = yield* probeHermesGateway({ baseUrl, apiToken, hermesSettings });
  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: true,
    checkedAt,
    models: outcome.models,
    probe: {
      installed: outcome.state !== "error",
      version: null,
      status: outcome.state,
      auth: outcome.auth,
      ...(outcome.message ? { message: outcome.message } : {}),
    },
  });
});
