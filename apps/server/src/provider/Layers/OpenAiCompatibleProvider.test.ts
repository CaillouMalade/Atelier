import { describe, it } from "@effect/vitest";
import { OpenAiCompatibleSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect } from "vitest";

import { checkOpenAiCompatibleProviderStatus } from "./OpenAiCompatibleProvider.ts";

const decodeSettings = Schema.decodeSync(OpenAiCompatibleSettings);

describe("checkOpenAiCompatibleProviderStatus", () => {
  it.effect("marks custom-model-only instances ready when /v1/models is empty", () =>
    Effect.gen(function* () {
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] }))),
        ),
      );
      const status = yield* checkOpenAiCompatibleProviderStatus(
        decodeSettings({
          baseUrl: "http://127.0.0.1:11434",
          customModels: ["local/model"],
        }),
      ).pipe(Effect.provide(http));

      expect(status.status).toBe("ready");
      expect(
        status.models.map((model) => ({ slug: model.slug, isCustom: model.isCustom })),
      ).toEqual([{ slug: "local/model", isCustom: true }]);
    }),
  );
});
