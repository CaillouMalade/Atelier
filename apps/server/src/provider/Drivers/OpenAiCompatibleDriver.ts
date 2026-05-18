/**
 * OpenAiCompatibleDriver — `ProviderDriver` for any HTTP backend that
 * speaks OpenAI's `/v1/chat/completions` streaming protocol.
 *
 * Covers Ollama, LM Studio, OpenRouter, hosted OpenAI, LiteLLM proxies,
 * and Hermes-as-vanilla-chat-completions. Connect-only — the driver never
 * spawns a process. Multiple instances let the user point at different
 * backends side-by-side ("Ollama (local)", "OpenRouter", …).
 *
 * @module provider/Drivers/OpenAiCompatibleDriver
 */
import {
  OpenAiCompatibleSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { makeOpenAiCompatibleTextGeneration } from "../../textGeneration/OpenAiCompatibleTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenAiCompatibleAdapter } from "../Layers/OpenAiCompatibleAdapter.ts";
import {
  checkOpenAiCompatibleProviderStatus,
  makePendingOpenAiCompatibleProvider,
} from "../Layers/OpenAiCompatibleProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const decodeOpenAiCompatibleSettings = Schema.decodeSync(OpenAiCompatibleSettings);

const DRIVER_KIND = ProviderDriverKind.make("openai-compat");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type OpenAiCompatibleDriverEnv = HttpClient.HttpClient;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenAiCompatibleDriver: ProviderDriver<
  OpenAiCompatibleSettings,
  OpenAiCompatibleDriverEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible",
    supportsMultipleInstances: true,
  },
  configSchema: OpenAiCompatibleSettings,
  defaultConfig: (): OpenAiCompatibleSettings => decodeOpenAiCompatibleSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenAiCompatibleSettings;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const adapter = yield* makeOpenAiCompatibleAdapter(effectiveConfig, {
        instanceId,
        driverKind: DRIVER_KIND,
      });
      const textGeneration = yield* makeOpenAiCompatibleTextGeneration({
        baseUrl: effectiveConfig.baseUrl,
        apiToken: effectiveConfig.apiToken,
        fallbackModel: effectiveConfig.defaultModel || "gpt-4o-mini",
      });

      const checkProvider = checkOpenAiCompatibleProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshot = yield* makeManagedServerProvider<OpenAiCompatibleSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (s) =>
          makePendingOpenAiCompatibleProvider(s).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenAI-compatible snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
