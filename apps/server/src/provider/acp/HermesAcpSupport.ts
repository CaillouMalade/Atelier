/**
 * HermesAcpSupport — spawn helpers for `hermes acp` (or `hermes -p <profile>
 * acp`) wrapped in the shared `AcpSessionRuntime`.
 *
 * Mirrors `CursorAcpSupport` in structure but is much simpler:
 *   - no custom auth method (Hermes ACP uses the user's own
 *     `~/.hermes/config.yaml` and credential setup, so we authenticate with
 *     the no-op `hermes` method id and let the ACP server treat it as a
 *     bootstrap signal)
 *   - no custom model picker — Hermes' model is server-side config
 *   - no Hermes-specific ACP extension messages
 *
 * @module provider/acp/HermesAcpSupport
 */
import { type HermesAcpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

type HermesAcpSpawnSettings = Pick<HermesAcpSettings, "binaryPath" | "profile">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpSpawnSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Build the spawn input for `hermes [-p profile] acp`.
 *
 * Hermes' docs list aliases (`hermes acp`, `hermes-acp`, `python -m
 * acp_adapter`); we use the canonical `hermes acp` form because it
 * supports the `-p <profile>` shorthand which the others don't reliably.
 */
export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpSpawnSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const binaryPath = hermesSettings?.binaryPath?.trim() || "hermes";
  return {
    command: binaryPath,
    args: buildHermesAcpArgs(hermesSettings),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function buildHermesAcpArgs(
  hermesSettings: Pick<HermesAcpSpawnSettings, "profile"> | null | undefined,
  trailingArgs: ReadonlyArray<string> = [],
): string[] {
  const profile = hermesSettings?.profile?.trim();
  return [...(profile && profile.length > 0 ? ["-p", profile] : []), "acp", ...trailingArgs];
}

/**
 * Materialise the Hermes ACP runtime inside the given scope. The auth
 * method id is `"hermes"` — Hermes ACP doesn't require an explicit auth
 * call but the protocol mandates one, so we send the bootstrap method
 * Hermes' docs use (`hermes acp --setup` paths through the same method).
 */
export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: "hermes",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
