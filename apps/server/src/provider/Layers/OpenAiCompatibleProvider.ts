/**
 * OpenAiCompatibleProvider — pending + checked snapshots for the generic
 * OpenAI-compatible HTTP driver (Ollama, LM Studio, OpenRouter, etc.).
 *
 * Probes `GET /v1/models` and lists the advertised models. Treats 401/403
 * as a clear "API token required" failure; transport errors fall under the
 * "unreachable" branch.
 *
 * @module provider/Layers/OpenAiCompatibleProvider
 */
import {
  type ModelCapabilities,
  type OpenAiCompatibleSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { isLoopbackUrl, normalizeOpenAiBaseUrl } from "../openaiCompatible/openaiHttp.ts";
import { probeOpenAiModels } from "../openaiCompatible/openaiModels.ts";

const PROVIDER = ProviderDriverKind.make("openai-compat");
const PRESENTATION = {
  displayName: "OpenAI-compatible",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const makePendingOpenAiCompatibleProvider = (
  settings: OpenAiCompatibleSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      settings.customModels,
      DEFAULT_MODEL_CAPABILITIES,
    );
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenAI-compatible instance is disabled.",
        },
      });
    }
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Provider status has not been checked in this session yet.",
      },
    });
  });

export const checkOpenAiCompatibleProviderStatus = Effect.fn("checkOpenAiCompatibleProviderStatus")(
  function* (
    settings: OpenAiCompatibleSettings,
  ): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          settings.customModels,
          DEFAULT_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenAI-compatible instance is disabled.",
        },
      });
    }

    const rawBaseUrl = settings.baseUrl.trim();
    if (rawBaseUrl.length === 0) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          settings.customModels,
          DEFAULT_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Base URL is not configured.",
        },
      });
    }
    const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);
    const apiToken = settings.apiToken.trim();

    if (apiToken.length === 0 && !isLoopbackUrl(baseUrl)) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          settings.customModels,
          DEFAULT_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unauthenticated" },
          message: `API token is required for non-loopback URLs (${baseUrl}).`,
        },
      });
    }

    const outcome = yield* probeOpenAiModels({
      provider: PROVIDER,
      baseUrl,
      apiToken,
      defaultCapabilities: DEFAULT_MODEL_CAPABILITIES,
    });

    switch (outcome.status) {
      case "unauthorized":
        return buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            settings.customModels,
            DEFAULT_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unauthenticated" },
            message: `Auth rejected at ${baseUrl}. ${outcome.detail}`,
          },
        });
      case "unreachable":
        return buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            settings.customModels,
            DEFAULT_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `Couldn't reach ${baseUrl}. ${outcome.detail}`,
          },
        });
      case "malformed":
        return buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            settings.customModels,
            DEFAULT_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "authenticated" },
            message: `Reachable at ${baseUrl} but /v1/models is malformed. ${outcome.detail}`,
          },
        });
      case "ok": {
        const models = providerModelsFromSettings(
          outcome.models,
          PROVIDER,
          settings.customModels,
          DEFAULT_MODEL_CAPABILITIES,
        );
        const hasSelectableModels = models.length > 0;
        return buildServerProvider({
          presentation: PRESENTATION,
          enabled: true,
          checkedAt,
          models,
          probe: {
            installed: true,
            version: null,
            status: hasSelectableModels ? "ready" : "warning",
            auth: { status: "authenticated" },
            message:
              outcome.models.length > 0
                ? `Connected to ${baseUrl}. ${outcome.models.length} model${outcome.models.length === 1 ? "" : "s"} advertised.`
                : hasSelectableModels
                  ? `Connected to ${baseUrl}; /v1/models is empty, using configured custom models.`
                  : `Connected to ${baseUrl}, but /v1/models is empty.`,
          },
        });
      }
    }
  },
);
