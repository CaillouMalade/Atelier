# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

Atelier is a local-first coding-agent workbench. The user-facing app is branded
Atelier, while some internal package names, env vars, state directories, and the
published CLI are still inherited from T3 Code (`t3`, `@t3tools/*`,
`T3CODE_*`, `~/.t3`).

This repository is a VERY EARLY WIP. Proposing changes that improve long-term
maintainability is encouraged when they stay tied to the current product shape.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js HTTP/WebSocket server. Owns persistence, auth, project/workspace APIs, source control, terminals, provider sessions, and the static web app in production.
- `apps/web`: React/Vite UI. Owns chat, project/thread navigation, settings, terminal UI, source control UI, and the Atelier workbench with changed files, artifacts, browser, and scratch tabs.
- `apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process, configures desktop identity/updates, and loads the shared web app.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Runtime (Important)

Atelier ships built-in provider drivers for Codex, Claude Code, Cursor Agent, and OpenCode. Provider instances are configured in settings, then resolved through the driver/instance registry so users can keep multiple named accounts or homes for the same driver.

Codex still uses `codex app-server` (JSON-RPC over stdio) under the hood. Other providers use their own driver adapters, but all runtime activity is normalized into the same orchestration/event model before it reaches the UI.

How we use it in this codebase:

- Built-in drivers are registered in `apps/server/src/provider/builtInDrivers.ts`.
- Provider instances are hydrated from server settings in `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts`.
- Provider dispatch and thread event logging are coordinated through `apps/server/src/provider/Layers/ProviderService.ts`.
- WebSocket server routes Effect RPC methods and subscriptions in `apps/server/src/ws.ts`.
- Web app consumes projected orchestration state through `apps/web/src/rpc/wsRpcClient.ts` subscriptions.

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
