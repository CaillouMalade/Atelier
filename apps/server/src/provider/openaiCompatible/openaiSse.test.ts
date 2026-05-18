import { describe, expect, it } from "vitest";

import { parseSseBlock, safeJsonParse } from "./openaiSse.ts";

describe("parseSseBlock", () => {
  it("parses an OpenAI chat-completions chunk (data: only)", () => {
    const block = `data: {"choices":[{"delta":{"content":"hi"}}]}`;
    expect(parseSseBlock(block)).toEqual({
      event: undefined,
      data: `{"choices":[{"delta":{"content":"hi"}}]}`,
    });
  });

  it("parses a Responses-style event with both event: and data:", () => {
    const block = `event: response.output_text.delta\ndata: {"delta":"hello"}`;
    expect(parseSseBlock(block)).toEqual({
      event: "response.output_text.delta",
      data: `{"delta":"hello"}`,
    });
  });

  it("joins multi-line data: per the SSE spec", () => {
    const block = `event: msg\ndata: line one\ndata: line two`;
    expect(parseSseBlock(block)).toEqual({
      event: "msg",
      data: `line one\nline two`,
    });
  });

  it("recognises Hermes' hermes.tool.progress event", () => {
    const block = `event: hermes.tool.progress\ndata: {"name":"terminal"}`;
    expect(parseSseBlock(block)).toEqual({
      event: "hermes.tool.progress",
      data: `{"name":"terminal"}`,
    });
  });

  it("recognises the [DONE] sentinel as a data event", () => {
    expect(parseSseBlock(`data: [DONE]`)).toEqual({ event: undefined, data: "[DONE]" });
  });

  it("returns null for empty blocks and keep-alive comments", () => {
    expect(parseSseBlock("")).toBeNull();
    expect(parseSseBlock("\n\n")).toBeNull();
    expect(parseSseBlock(": this is an SSE keep-alive comment")).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    const block = `event: response.created\r\ndata: {"response":{"id":"resp_1"}}`;
    expect(parseSseBlock(block)).toEqual({
      event: "response.created",
      data: `{"response":{"id":"resp_1"}}`,
    });
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("returns undefined for malformed JSON instead of throwing", () => {
    expect(safeJsonParse("not json")).toBeUndefined();
    expect(safeJsonParse("{a:1}")).toBeUndefined();
  });
});
