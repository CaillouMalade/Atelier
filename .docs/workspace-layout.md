# Workspace layout

- `/apps/server`: Node.js HTTP/WebSocket server. Owns persistence, auth, provider sessions, orchestration, terminals, source control, workspace files, and the built web app in production.
- `/apps/web`: React + Vite UI. Chat/session control, project/thread navigation, settings, terminal UI, source control, and the Atelier workbench. Connects to the server via WebSocket RPC.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process and loads the shared web app.
- `/apps/marketing`: Astro marketing site inherited from upstream. It is not the source of truth for the private Atelier app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) — no barrel index.
- `/packages/ssh`: SSH launch/tunnel helpers for desktop-managed remote environments.
- `/packages/tailscale`: Tailscale endpoint discovery and Serve integration helpers.
