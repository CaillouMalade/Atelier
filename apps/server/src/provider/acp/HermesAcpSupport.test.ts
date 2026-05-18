import { describe, expect, it } from "vitest";

import { buildHermesAcpArgs, buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("invokes `hermes acp` by default", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "hermes", profile: "" }, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });

  it("falls back to bare `hermes` when binaryPath is empty", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "", profile: "" }, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });

  it("falls back to bare `hermes` when binaryPath is whitespace", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "   ", profile: "" }, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });

  it("injects `-p <profile>` when a profile is configured", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "hermes", profile: "alice" }, "/tmp/wd")).toEqual(
      {
        command: "hermes",
        args: ["-p", "alice", "acp"],
        cwd: "/tmp/wd",
      },
    );
  });

  it("ignores whitespace-only profile values", () => {
    expect(buildHermesAcpSpawnInput({ binaryPath: "hermes", profile: "   " }, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });

  it("respects a custom binary path (e.g. shim or absolute path)", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/usr/local/bin/hermes", profile: "" }, "/tmp/wd"),
    ).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });

  it("forwards the env when provided", () => {
    const env = { HERMES_LOG_LEVEL: "debug" } as NodeJS.ProcessEnv;
    expect(buildHermesAcpSpawnInput({ binaryPath: "hermes", profile: "" }, "/tmp/wd", env)).toEqual(
      {
        command: "hermes",
        args: ["acp"],
        cwd: "/tmp/wd",
        env,
      },
    );
  });

  it("tolerates null/undefined settings (uses defaults)", () => {
    expect(buildHermesAcpSpawnInput(null, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/wd")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/wd",
    });
  });
});

describe("buildHermesAcpArgs", () => {
  it("builds profile-aware args for readiness help probes", () => {
    expect(buildHermesAcpArgs({ profile: "" }, ["--help"])).toEqual(["acp", "--help"]);
    expect(buildHermesAcpArgs({ profile: "default" }, ["--help"])).toEqual([
      "-p",
      "default",
      "acp",
      "--help",
    ]);
  });
});
