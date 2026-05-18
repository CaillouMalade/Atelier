/**
 * HermesAcpProvider — snapshot for the Hermes ACP driver.
 *
 * Hermes ACP isn't an HTTP service we can probe — it's a spawned process.
 * The lightweight probe confirms the binary is on PATH, reads its top-level
 * version, then verifies the `acp` subcommand exists. Anything more involved
 * (auth status, model list) is deferred to runtime when a session is actually
 * started.
 *
 * @module provider/Layers/HermesAcpProvider
 */
import {
  type HermesAcpSettings,
  type ModelCapabilities,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";

import { buildHermesAcpArgs } from "../acp/HermesAcpSupport.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("hermes-acp");
const PRESENTATION = {
  displayName: "Hermes (ACP)",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const HERMES_ACP_MODELS = [
  {
    slug: "hermes-agent",
    name: "Hermes Agent",
    isCustom: false,
    capabilities: DEFAULT_MODEL_CAPABILITIES,
  },
] as const;

export const makePendingHermesAcpProvider = (
  settings: HermesAcpSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      HERMES_ACP_MODELS,
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
          message: "Hermes ACP is disabled.",
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
        message: "Hermes ACP status has not been checked in this session yet.",
      },
    });
  });

export const checkHermesAcpProviderStatus = (
  settings: HermesAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      HERMES_ACP_MODELS,
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
          message: "Hermes ACP is disabled.",
        },
      });
    }
    const binaryPath = settings.binaryPath?.trim() || "hermes";

    const versionExit = yield* Effect.exit(
      spawnAndCollect(
        binaryPath,
        ChildProcess.make(binaryPath, ["--version"], {
          env: environment,
          shell: process.platform === "win32",
        }),
      ),
    );
    if (versionExit._tag === "Failure") {
      const cause = Cause.squash(versionExit.cause);
      const message = cause instanceof Error ? cause.message : String(cause);
      const lower = message.toLowerCase();
      const isMissing = lower.includes("enoent") || lower.includes("notfound");
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !isMissing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isMissing
            ? `Hermes CLI ('${binaryPath}') is not installed or not on PATH.`
            : `Failed to execute '${binaryPath} --version': ${message}`,
        },
      });
    }
    const versionResult = versionExit.value;
    if (versionResult.code !== 0) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `'${binaryPath} --version' exited with code ${versionResult.code}: ${versionResult.stderr || versionResult.stdout || "(no output)"}`,
        },
      });
    }
    const version = parseGenericCliVersion(versionResult.stdout);

    const acpHelpExit = yield* Effect.exit(
      spawnAndCollect(
        binaryPath,
        ChildProcess.make(binaryPath, buildHermesAcpArgs(settings, ["--help"]), {
          env: environment,
          shell: process.platform === "win32",
        }),
      ),
    );
    if (acpHelpExit._tag === "Failure") {
      const cause = Cause.squash(acpHelpExit.cause);
      const message = cause instanceof Error ? cause.message : String(cause);
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `Failed to execute '${binaryPath} acp --help': ${message}`,
        },
      });
    }
    const acpHelpResult = acpHelpExit.value;
    if (acpHelpResult.code !== 0) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `'${binaryPath} acp --help' exited with code ${acpHelpResult.code}: ${acpHelpResult.stderr || acpHelpResult.stdout || "(no output)"}`,
        },
      });
    }

    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated", type: "hermes-acp" },
        message: version
          ? `Hermes ACP v${version} ready at '${binaryPath}'.`
          : `Hermes ACP available at '${binaryPath}'.`,
      },
    });
  });
