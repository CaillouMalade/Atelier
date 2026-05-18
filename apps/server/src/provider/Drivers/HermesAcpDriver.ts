/**
 * HermesAcpDriver — `ProviderDriver` for `hermes acp` over stdio JSON-RPC.
 *
 * Spawns the Hermes CLI in ACP mode and pipes through the shared
 * `AcpSessionRuntime`. Unlike the HTTP Hermes driver, ACP gives us:
 *
 *   - documented approval prompts (allow once / always / deny)
 *   - editor-bound working directory
 *   - rich session updates (assistant chunks, tool activity, plans)
 *
 * For text generation we still use the Hermes HTTP gateway when one is
 * configured — but since this driver has no HTTP context, we fall back to
 * a not-supported error. Users wanting commit-message generation should
 * pair the Hermes ACP driver with a Hermes HTTP driver instance on the
 * same gateway.
 *
 * @module provider/Drivers/HermesAcpDriver
 */
import { HermesAcpSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Path from "effect/Path";

import { TextGenerationError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAcpAdapter } from "../Layers/HermesAcpAdapter.ts";
import {
  checkHermesAcpProviderStatus,
  makePendingHermesAcpProvider,
} from "../Layers/HermesAcpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const decodeHermesAcpSettings = Schema.decodeSync(HermesAcpSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes-acp");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type HermesAcpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Path.Path
  | ServerConfig;

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

const unsupportedTextGeneration: TextGenerationShape = {
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail:
          "Hermes ACP does not expose a text-generation endpoint. Pair this instance with a Hermes HTTP instance for commit / PR text generation.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail:
          "Hermes ACP does not expose a text-generation endpoint. Pair this instance with a Hermes HTTP instance.",
      }),
    ),
  generateBranchName: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail:
          "Hermes ACP does not expose a text-generation endpoint. Pair this instance with a Hermes HTTP instance.",
      }),
    ),
  generateThreadTitle: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail:
          "Hermes ACP does not expose a text-generation endpoint. Pair this instance with a Hermes HTTP instance.",
      }),
    ),
};

export const HermesAcpDriver: ProviderDriver<HermesAcpSettings, HermesAcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes (ACP)",
    supportsMultipleInstances: true,
  },
  configSchema: HermesAcpSettings,
  defaultConfig: (): HermesAcpSettings => decodeHermesAcpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      const effectiveConfig = { ...config, enabled } satisfies HermesAcpSettings;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const adapter = yield* makeHermesAcpAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
      });

      const checkProvider = checkHermesAcpProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<HermesAcpSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (s) => makePendingHermesAcpProvider(s).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Hermes ACP snapshot: ${cause.message ?? String(cause)}`,
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
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};
