# Atelier

Atelier is a local-first workbench for running coding agents against real projects. It combines a chat timeline, terminal, source control tools, workspace file browsing, artifacts, an embedded web pane, and a live Markdown scratchpad into one desktop/web UI.

## Read This First

This repository is in the middle of a product fork/rebrand. Do not assume every
old name in the tree is stale, and do not assume every new name has been migrated
all the way down.

The current user-facing product is **Atelier**.

The current backend/CLI/package internals are still mostly inherited from
upstream T3 Code:

- CLI command: `t3`
- npm package: `t3`
- workspace package scope: `@t3tools/*`
- environment variable prefix: `T3CODE_*`
- default state directory: `~/.t3`
- some app IDs, artifact names, update metadata, tests, and compatibility paths

These inherited names are intentional for now. They should not be renamed in a
drive-by cleanup. Renaming them safely requires compatibility aliases,
migration logic, update-path review, packaging review, and test updates.

When docs or code disagree, use this rule:

1. User-facing desktop/web product name: **Atelier**.
2. Runtime/backend implementation name: often still `t3`.
3. Legacy upstream references in tests or compatibility paths may be correct.
4. `apps/marketing` is inherited upstream marketing content and is not current
   Atelier product copy.
5. Release/distribution docs are inherited and must be reviewed before public
   Atelier distribution.

## What Not To Break

- Do not blindly replace `t3`, `@t3tools`, `T3CODE`, or `~/.t3`.
- Do not treat `apps/marketing` as authoritative product messaging.
- Do not change release domains, app IDs, package names, artifact names, or
  updater metadata without checking the packaging/release flow.
- Do not remove legacy T3 Code state-path handling; it may preserve existing
  user data.
- Do not assume a doc that mentions `t3` is wrong. The CLI is still named `t3`.

## Current Product Truth

Atelier currently means:

- Private, early-stage app, not a polished public release.
- Desktop product name: `Atelier`.
- CLI/backend package name: `t3`.
- Built-in agent drivers: Codex, Claude Code, Cursor Agent, and OpenCode.
- Cursor support is marked early access in the UI.
- Public package managers and upstream release links are not the source of truth for this fork.

## What Is In The App

- Chat threads backed by provider sessions and project/worktree state.
- Provider settings for multiple named instances, including separate homes and environment variables.
- Right-side Atelier workbench with changed files, artifacts, browser, and scratch tabs.
- Workspace drawer for opening files from the active project.
- Artifact previews for generated or changed workspace files.
- Live editable Markdown for scratch notes and Markdown workspace files.
- Terminal drawer, command palette, customizable keybindings, and source control integrations.
- Desktop shell that launches the backend on loopback with an auth token.
- Browser access when a backend is running and reachable over HTTP/WebSocket.

## Prerequisites

- Bun `1.3.11`
- Node compatible with the server package: `^22.16 || ^23.11 || >=24.10`
- Git
- At least one authenticated provider CLI:
  - Codex: install the Codex CLI and run `codex login`
  - Claude: install Claude Code and run `claude auth login`
  - Cursor Agent: install/configure the Cursor agent CLI
  - OpenCode: install OpenCode and run its auth setup

The UI can start without a provider, but coding sessions will not run until at least one provider is installed and authenticated.

## Local Development

```bash
bun install
bun run dev
```

Useful scripts:

```bash
bun run dev:web        # Vite web app only
bun run dev:server     # backend only
bun run dev:desktop    # Electron desktop app
bun run build
bun run typecheck
bun run lint
bun run test
```

Dev state defaults to `~/.t3/dev`. Production/server state defaults to `~/.t3/userdata`.

## Packaging

Local desktop packaging is available but still carries some inherited package identifiers:

```bash
bun run dist:desktop:dmg
```

The release workflow and hosted web deployment docs are inherited from upstream and need repo/domain/package review before being used for public Atelier distribution.

## Documentation Map

- [`.docs/quick-start.md`](./.docs/quick-start.md): short command reference
- [`.docs/architecture.md`](./.docs/architecture.md): runtime architecture
- [`.docs/provider-architecture.md`](./.docs/provider-architecture.md): provider/driver model
- [`KEYBINDINGS.md`](./KEYBINDINGS.md): keybinding file format and defaults
- [`REMOTE.md`](./REMOTE.md): LAN, Tailscale, hosted, and SSH remote access
- [`docs/source-control-providers.md`](./docs/source-control-providers.md): Git hosting integrations
- [`docs/providers/codex.md`](./docs/providers/codex.md): Codex account/provider setup
- [`docs/providers/claude.md`](./docs/providers/claude.md): Claude account/provider setup
- [`docs/observability.md`](./docs/observability.md): logs, traces, and OTLP
