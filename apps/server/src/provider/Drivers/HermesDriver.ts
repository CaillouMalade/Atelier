/**
 * HermesDriver — `ProviderDriver` for the Hermes HTTP gateway.
 *
 * Mirrors the OpenCode / Cursor drivers in shape — a plain value whose
 * `create()` bundles `snapshot` / `adapter` / `textGeneration` closures over
 * the per-instance `HermesSettings`. Connect-only by design: each instance
 * points at a Hermes gateway running locally or on a remote machine
 * reachable via Tailscale/LAN. The driver itself never spawns a process and
 * never touches the filesystem.
 *
 * Two instances with different `baseUrl`s therefore talk to completely
 * independent Hermes gateways; settings changes recreate the instance via
 * the registry's hot-reload path.
 *
 * @module provider/Drivers/HermesDriver
 */
import { HermesSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { makeOpenAiCompatibleTextGeneration } from "../../textGeneration/OpenAiCompatibleTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  checkHermesProviderStatus,
  makePendingHermesProvider,
} from "../Layers/HermesProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type HermesDriverEnv = HttpClient.HttpClient | ServerConfig;

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

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
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
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const adapter = yield* makeHermesAdapter(effectiveConfig, { instanceId });
      // Hermes' /v1/chat/completions endpoint is OpenAI-compatible, so the
      // shared text-generation helper works for it verbatim. Hermes treats
      // the request `model` field as cosmetic; we fall through to the docs'
      // advertised default-profile name.
      const textGeneration = yield* makeOpenAiCompatibleTextGeneration({
        baseUrl: effectiveConfig.baseUrl,
        apiToken: effectiveConfig.apiToken,
        fallbackModel: "hermes-agent",
      });

      const checkProvider = checkHermesProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshot = yield* makeManagedServerProvider<HermesSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingHermesProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Hermes snapshot: ${cause.message ?? String(cause)}`,
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
