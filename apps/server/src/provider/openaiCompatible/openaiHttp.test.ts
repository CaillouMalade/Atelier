import { describe, expect, it } from "vitest";

import { isLoopbackUrl, normalizeOpenAiBaseUrl } from "./openaiHttp.ts";

describe("normalizeOpenAiBaseUrl", () => {
  it("returns the URL unchanged when no /v1 suffix is present", () => {
    expect(normalizeOpenAiBaseUrl("http://127.0.0.1:8642")).toBe("http://127.0.0.1:8642");
    expect(normalizeOpenAiBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });

  it("strips a trailing /v1 (Hermes, OpenRouter, OpenAI-direct)", () => {
    expect(normalizeOpenAiBaseUrl("http://127.0.0.1:8642/v1")).toBe("http://127.0.0.1:8642");
    expect(normalizeOpenAiBaseUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api",
    );
  });

  it("strips trailing slashes / variants", () => {
    expect(normalizeOpenAiBaseUrl("http://127.0.0.1:8642/")).toBe("http://127.0.0.1:8642");
    expect(normalizeOpenAiBaseUrl("http://127.0.0.1:8642/v1/")).toBe("http://127.0.0.1:8642");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOpenAiBaseUrl("  http://host:8642/v1  ")).toBe("http://host:8642");
  });

  it("handles Tailscale hostnames", () => {
    expect(normalizeOpenAiBaseUrl("http://workstation.tailnet.ts.net:8642/v1")).toBe(
      "http://workstation.tailnet.ts.net:8642",
    );
  });
});

describe("isLoopbackUrl", () => {
  it("recognises 127.0.0.1 and localhost as loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8642")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
  });

  it("recognises ::1 (IPv6 loopback)", () => {
    expect(isLoopbackUrl("http://[::1]:8642")).toBe(true);
  });

  it("treats Tailscale CGNAT (100.x.y.z) as non-loopback so API token is required", () => {
    expect(isLoopbackUrl("http://100.64.0.1:8642")).toBe(false);
  });

  it("treats RFC-1918 LAN ranges as non-loopback", () => {
    expect(isLoopbackUrl("http://192.168.1.10:8642")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.5:11434")).toBe(false);
  });

  it("returns false for unparseable URLs", () => {
    expect(isLoopbackUrl("not-a-url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
