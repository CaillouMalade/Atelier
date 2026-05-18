import { describe, it } from "@effect/vitest";
import { HermesAcpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vitest";

import { makePendingHermesAcpProvider } from "./HermesAcpProvider.ts";

const decodeSettings = Schema.decodeSync(HermesAcpSettings);

describe("makePendingHermesAcpProvider", () => {
  it.effect("publishes a synthetic selectable model because Hermes ACP has no model list", () =>
    Effect.gen(function* () {
      const status = yield* makePendingHermesAcpProvider(decodeSettings({ enabled: true }));

      expect(status.models.map((model) => model.slug)).toEqual(["hermes-agent"]);
    }),
  );
});
