import { describe, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vitest";

import { checkHermesProviderStatus } from "./HermesProvider.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);

describe("checkHermesProviderStatus", () => {
  it.effect("marks custom-model-only gateways ready when /v1/models is empty", () =>
    Effect.gen(function* () {
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.endsWith("/v1/models")) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] })));
          }
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
        }),
      );
      const status = yield* checkHermesProviderStatus(
        decodeSettings({
          baseUrl: "http://127.0.0.1:8642",
          customModels: ["hermes/custom"],
        }),
      ).pipe(Effect.provide(http));

      expect(status.status).toBe("ready");
      expect(
        status.models.map((model) => ({ slug: model.slug, isCustom: model.isCustom })),
      ).toEqual([{ slug: "hermes/custom", isCustom: true }]);
    }),
  );
});
