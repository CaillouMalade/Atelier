import { describe, expect, it } from "vitest";

import { pickTransport } from "./HermesAdapter.ts";

describe("pickTransport", () => {
  it("selects /v1/runs when runs feature flags are advertised under .features", () => {
    // Real shape from `GET /v1/capabilities` per the Hermes docs.
    const capabilities = {
      object: "hermes.api_server.capabilities",
      platform: "hermes-agent",
      model: "hermes-agent",
      auth: { type: "bearer", required: true },
      features: {
        chat_completions: true,
        responses_api: true,
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
      },
    };
    expect(pickTransport(capabilities)).toBe("runs");
  });

  it("falls back to /v1/responses when runs API is unavailable", () => {
    expect(
      pickTransport({
        features: {
          chat_completions: true,
          responses_api: true,
          run_submission: false,
          run_events_sse: false,
          run_stop: false,
        },
      }),
    ).toBe("responses");
  });

  it("falls back to /v1/chat/completions when only chat is available", () => {
    expect(
      pickTransport({
        features: { chat_completions: true, responses_api: false, run_submission: false },
      }),
    ).toBe("chat_completions");
  });

  it("treats an empty capabilities response as chat_completions only", () => {
    expect(pickTransport({})).toBe("chat_completions");
    expect(pickTransport({ features: {} })).toBe("chat_completions");
  });

  it("ignores flags at the top level (must live under .features)", () => {
    // Guards against a regression where the parser read top-level flags
    // and would have picked /v1/runs against gateways that don't actually
    // expose those routes.
    expect(
      pickTransport({
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
      }),
    ).toBe("chat_completions");
  });

  it("requires ALL three runs flags before selecting runs", () => {
    expect(
      pickTransport({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: false,
          responses_api: true,
        },
      }),
    ).toBe("responses");
  });
});
