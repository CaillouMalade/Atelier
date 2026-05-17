# Atelier security audit — 2026-05-16

Read-only audit of the t3code-source-code monorepo. Solo-use threat model:
multi-user/tenancy issues deprioritized, but **High kept on anything that
crosses a trust boundary the single user actually has** — a browser tab they
open, AI-generated content rendered in the app, LAN/Tailscale reachability per
REMOTE.md, the SSH IPC bridge.

Scope: `apps/server`, `apps/desktop`, `apps/web`, `packages/ssh`,
`packages/tailscale`, `packages/contracts`, `packages/effect-acp`,
`packages/effect-codex-app-server`, REMOTE.md, `docs/observability.md`,
`patches/`, eyeballed `bun.lock`. See "Coverage gaps" for what was not opened.

File-path links below are relative to this file
(`../../apps/...` = `<repo-root>/apps/...`).

---

## TL;DR — top concerns

1. **DNS rebinding to loopback is unblocked.** Wildcard CORS + no `Origin`/`Host` check + `SameSite=Lax` cookie → a malicious webpage you visit can drive the local backend. Most users-with-a-browser, not multi-user, is the threat here.
2. **`T3CODE_UNSAFE_NO_AUTH=true` is a silent kill-switch for all auth, in every mode, with no startup warning.** One stray env export = unauth code execution surface.
3. **Workspace file + terminal RPCs trust client-supplied `cwd` as the root** with no allowlist or realpath. Any authenticated session reads/writes `/etc/passwd` (or spawns a PTY in `/`).
4. **`shell: process.platform === "win32"` is pervasive in spawn calls** in both backend (providers, editor) and Electron (SSH IPC). With renderer-controlled inputs, this is Windows RCE from any XSS or compromised renderer page.
5. **Electron preload `desktopBridge` follows the renderer anywhere.** No `will-navigate` guard → an attacker-controlled URL inherits `getSavedEnvironmentSecret`, `ensureSshEnvironment`, etc.
6. **AI-generated artifacts → renderer is the realistic XSS vector.** Today the Markdown pipeline is locked down well, but there's no CSP and the embedded browser pane keeps `allow-same-origin`, so a future regression turns straight into RCE via the loopback backend.

---

## Critical / High

### H1 — DNS rebinding to loopback + missing `Origin`/`Host` validation
- **Where:** [httpCors.ts:1-13](../../apps/server/src/httpCors.ts#L1-L13), applied via `browserApiCorsLayer` at [server.ts:315](../../apps/server/src/server.ts#L315); WS upgrade [ws.ts:1259-1308](../../apps/server/src/ws.ts#L1259-L1308); session cookie [auth/http.ts:93-98](../../apps/server/src/auth/http.ts#L93-L98).
- **What:** Every API response carries `Access-Control-Allow-Origin: *` with `Authorization` allowlisted. Server never validates `Origin` or `Host`. Session cookie is `SameSite=Lax`, no `Secure`. WS upgrade does not check `Origin`.
- **Why it matters:** A page on `evil.tld` that DNS-rebinds to `127.0.0.1:<port>` becomes same-origin with the backend in the user's browser. Lax `SameSite` does not block this — the cookie rides along. WS hijack via the same trick. The same setup also exposes you on LAN/Tailscale.
- **Fix direction:** Pin allowed `Host` (loopback + configured tailnet name), check `Origin` against an allowlist on both HTTP and WS upgrade, set `Secure` cookie when the request came in over HTTPS, consider `SameSite=Strict`.

### H2 — `T3CODE_UNSAFE_NO_AUTH=true` silently disables auth in every mode
- **Where:** [cli/config.ts:119](../../apps/server/src/cli/config.ts#L119); policy [auth/Layers/ServerAuthPolicy.ts:14-22](../../apps/server/src/auth/Layers/ServerAuthPolicy.ts#L14-L22); bypass surface [auth/Layers/ServerAuth.ts:40-46](../../apps/server/src/auth/Layers/ServerAuth.ts#L40-L46), [:108-110](../../apps/server/src/auth/Layers/ServerAuth.ts#L108-L110), [:378-380](../../apps/server/src/auth/Layers/ServerAuth.ts#L378-L380); pairing URL log suppressed at [serverRuntimeStartup.ts:445](../../apps/server/src/serverRuntimeStartup.ts#L445).
- **What:** Env-only switch. Sets policy to `unsafe-no-auth`, hands every request a synthetic owner session, accepts every WS upgrade unauthenticated, and *suppresses the warning banner*.
- **Why it matters:** A `.zshrc`/CI/PaaS export turns a `0.0.0.0`-bound backend into an unauth RCE surface (PTY + git + provider sessions + file APIs).
- **Fix direction:** Refuse to boot if `unsafeNoAuth` and `host` is not loopback; print a loud warning to stdout + log on every startup.

### H3 — Workspace file APIs trust client-supplied `cwd` as the root
- **Where:** [workspace/Layers/WorkspacePaths.ts:30-100](../../apps/server/src/workspace/Layers/WorkspacePaths.ts#L30-L100); [workspace/Layers/WorkspaceFileSystem.ts:81-176](../../apps/server/src/workspace/Layers/WorkspaceFileSystem.ts#L81-L176); WS handlers [ws.ts:967-998](../../apps/server/src/ws.ts#L967-L998).
- **What:** `resolveRelativePathWithinRoot` only checks the relative path doesn't `..` out of `workspaceRoot` — but `workspaceRoot` itself is whatever string the client sends. No realpath, no symlink check, no cross-reference to registered projects.
- **Why it matters:** Any authenticated WS session → read/write *anywhere* the server process can reach. `cwd="/"`, `relativePath="etc/passwd"` succeeds. Combined with H1/H4, an attacker page → arbitrary file read/write.
- **Fix direction:** Intersect requested `cwd` with the set of registered project roots; `realpath` both root and resolved path and verify containment.

### H4 — Terminal PTY accepts any `cwd` and arbitrary env
- **Where:** [terminal/Layers/Manager.ts:1338-1393](../../apps/server/src/terminal/Layers/Manager.ts#L1338-L1393); contract [contracts/src/terminal.ts:38-46](../../packages/contracts/src/terminal.ts#L38-L46); blocklist [Manager.ts:53](../../apps/server/src/terminal/Layers/Manager.ts#L53).
- **What:** Any authenticated client opens a PTY with arbitrary `cwd` and a 128-entry env map. The env blocklist only excludes T3-internal vars — `PATH`, `LD_PRELOAD`, `NODE_OPTIONS` are not filtered.
- **Why it matters:** Interactive shell as the server user, with custom `PATH` to hijack helper lookups.
- **Fix direction:** Confine `cwd` to registered project/worktree paths; strip dangerous env vars from client-supplied overrides.

### H5 — Windows shell-injection: editor launch + provider `binaryPath` with `shell: true`
- **Where:** Editor launch [process/externalLauncher.ts:330-345](../../apps/server/src/process/externalLauncher.ts#L330-L345) (quotes `cwd` with `"…"` then runs through `cmd.exe`). Same `shell: process.platform === "win32"` pattern across providers and helpers:
  - [provider/Layers/ClaudeProvider.ts:512](../../apps/server/src/provider/Layers/ClaudeProvider.ts#L512)
  - [provider/Layers/CursorProvider.ts:1055-1058](../../apps/server/src/provider/Layers/CursorProvider.ts#L1055-L1058)
  - [provider/Layers/CodexSessionRuntime.ts:726](../../apps/server/src/provider/Layers/CodexSessionRuntime.ts#L726)
  - [provider/opencodeRuntime.ts:284](../../apps/server/src/provider/opencodeRuntime.ts#L284), [:342](../../apps/server/src/provider/opencodeRuntime.ts#L342)
  - [provider/acp/AcpSessionRuntime.ts:205](../../apps/server/src/provider/acp/AcpSessionRuntime.ts#L205)
  - [textGeneration/ClaudeTextGeneration.ts:173](../../apps/server/src/textGeneration/ClaudeTextGeneration.ts#L173), [textGeneration/CodexTextGeneration.ts:218](../../apps/server/src/textGeneration/CodexTextGeneration.ts#L218)
- **What:** On Windows, `shell: true` concatenates argv into a single string handed to `cmd.exe /c`. Naive `"…"` wrapping doesn't escape `&`, `^`, `"`, etc. Client-settable `provider.binaryPath` (via `serverUpdateSettings`) reaches this path.
- **Why it matters:** Authenticated client → arbitrary command execution on Windows. Set `claude.binaryPath` to `cmd & start calc.exe` and trigger a status check.
- **Fix direction:** Remove `shell: true` everywhere — pass an absolute executable path with an argv array.

### H6 — Electron: SSH target from renderer → Windows command injection
- **Where:** [packages/ssh/src/command.ts:181-189](../../packages/ssh/src/command.ts#L181-L189), [packages/ssh/src/tunnel.ts:1152-1162](../../packages/ssh/src/tunnel.ts#L1152-L1162); IPC schema [packages/contracts/src/ipc.ts:235-240](../../packages/contracts/src/ipc.ts#L235-L240).
- **What:** `ensureSshEnvironment` IPC accepts `alias`/`hostname`/`username` as raw `Schema.String`. They flow into `ssh` argv with `shell: process.platform === "win32"`.
- **Why it matters:** Renderer-compromise (e.g. via AI-generated content path) → host RCE on Windows.
- **Fix direction:** Validate `alias`/`hostname`/`username` with a strict regex at the IPC schema boundary; drop `shell: true` on the `ssh` spawn.

### H7 — Electron preload bridge follows the renderer to any origin
- **Where:** [apps/desktop/src/window/DesktopWindow.ts:159-291](../../apps/desktop/src/window/DesktopWindow.ts#L159-L291); preload [apps/desktop/src/preload.ts:22-127](../../apps/desktop/src/preload.ts#L22-L127). No `will-navigate` / `will-frame-navigate` listener anywhere in `apps/desktop/`.
- **What:** Good defaults (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `setWindowOpenHandler` denies popups). But there is no top-level navigation guard, so if any code in the SPA sets `location.href = "https://evil.example"`, the attacker page inherits `window.desktopBridge` and can call `getSavedEnvironmentSecret`, `ensureSshEnvironment`, `bootstrapSshBearerSession`, `setClientSettings`, `getLocalEnvironmentBootstrap`, etc.
- **Fix direction:** `webContents.on("will-navigate", …)` + `will-frame-navigate`, pinned to `backendHttpUrl.origin` and `VITE_DEV_SERVER_URL`.

### H8 — WS RPC role gating: "client" sessions have the same powers as "owner"
- **Where:** WS RPC layer [ws.ts:161-1255](../../apps/server/src/ws.ts#L161-L1255) — no `session.role` check inside RPC handlers. Owner-only checks only exist on HTTP routes ([auth/http.ts:151](../../apps/server/src/auth/http.ts#L151), [:188-194](../../apps/server/src/auth/http.ts#L188-L194); [orchestration/http.ts:34-40](../../apps/server/src/orchestration/http.ts#L34-L40)).
- **What:** Any "client"-paired session can call `terminalOpen`, `projectsWriteFile`, `shellOpenInEditor`, `serverSignalProcess`, `vcsCreateWorktree`, `serverUpdateSettings`, etc.
- **Why it matters:** The owner/client distinction is meaningful only at the pairing-management level. Stealing a client credential is as good as stealing owner.
- **Fix direction:** Tag dangerous RPCs as owner-only.

---

## Medium

### M1 — Renderer can read decrypted saved bearer tokens
- **Where:** [ipc/methods/savedEnvironments.ts:42-49](../../apps/desktop/src/ipc/methods/savedEnvironments.ts#L42-L49); [settings/DesktopSavedEnvironments.ts:273-289](../../apps/desktop/src/settings/DesktopSavedEnvironments.ts#L273-L289).
- **What:** Tokens are encrypted at rest with Electron `safeStorage` but the `getSavedEnvironmentSecret(environmentId)` IPC decrypts and returns plaintext to the renderer.
- **Why it matters:** Combined with H7, attacker page enumerates `getSavedEnvironmentRegistry` → drains every saved bearer.
- **Fix direction:** Proxy bearer-using operations through the main process instead of handing the token to the renderer; or gate with `ElectronDialog.confirm`.

### M2 — Loopback confused-deputy in SSH bearer/WS-token bridge
- **Where:** [ipc/methods/sshEnvironment.ts:67-114](../../apps/desktop/src/ipc/methods/sshEnvironment.ts#L67-L114) → [ssh/DesktopSshRemoteApi.ts:75-121](../../apps/desktop/src/ssh/DesktopSshRemoteApi.ts#L75-L121) → [packages/ssh/src/tunnel.ts:994-1019](../../packages/ssh/src/tunnel.ts#L994-L1019).
- **What:** Renderer supplies `httpBaseUrl`; main process restricts the *hostname* to loopback but not the *port*. Renderer also picks the `Authorization: Bearer …` and body.
- **Why it matters:** Compromised renderer → request proxy to any local service trusting loopback (DBs, dev servers, other agents).
- **Fix direction:** Server-side allowlist of `host:port` pairs that correspond to live tunnels.

### M3 — Pairing token logged to local trace file (and possibly OTLP)
- **Where:** [serverRuntimeStartup.ts:442-449](../../apps/server/src/serverRuntimeStartup.ts#L442-L449); URL minter [auth/Layers/ServerAuth.ts:338-349](../../apps/server/src/auth/Layers/ServerAuth.ts#L338-L349); OTLP exporter [observability/Layers/Observability.ts:32-45](../../apps/server/src/observability/Layers/Observability.ts#L32-L45).
- **What:** Owner-bootstrap URL (token in the hash) goes through `logInfo` inside a span → persisted in `~/.t3/userdata/logs/server.trace.ndjson` and exported via OTLP if `T3CODE_OTLP_TRACES_URL` is set.
- **Why it matters:** Token has a 5-min TTL but lands in a long-lived NDJSON file with default umask perms, and potentially in a third-party observability backend.
- **Fix direction:** Strip the URL hash before logging.

### M4 — SSH-launched remote backend writes boot token to `~/.t3/ssh-launch/.../server.log`
- **Where:** [packages/ssh/src/tunnel.ts:603](../../packages/ssh/src/tunnel.ts#L603); headless formatter [startupAccess.ts:122-131](../../apps/server/src/startupAccess.ts#L122-L131).
- **What:** `t3 serve` headless prints the pairing token to stdout; the launcher script appends stdout into `server.log` with no rotation and no `chmod 700` on the dir.
- **Fix direction:** Redirect to `/dev/null` and rely solely on the explicit `t3 auth pairing create --json` over SSH, plus `chmod 700` the state dir.

### M5 — WS token in URL query string
- **Where:** [auth/Layers/ServerAuth.ts:39](../../apps/server/src/auth/Layers/ServerAuth.ts#L39), [:382-403](../../apps/server/src/auth/Layers/ServerAuth.ts#L382-L403); renderer uses it at [apps/web/src/environments/remote/api.ts:147](../../apps/web/src/environments/remote/api.ts#L147).
- **What:** 5-min WS bearer is accepted only via `?wsToken=…`. URL components leak via Referer, request logs, dev-tools, trace exporters.
- **Fix direction:** Use `Sec-WebSocket-Protocol` or a one-shot POST-then-upgrade pattern.

### M6 — Wildcard CORS on all API routes with `Authorization` allowlisted
- **Where:** [httpCors.ts](../../apps/server/src/httpCors.ts); auth routes [auth/http.ts](../../apps/server/src/auth/http.ts).
- **What:** `*` blocks credentialed cookies, but `Authorization: Bearer …` is allowed and `/api/auth/bootstrap` accepts an unauth body that exchanges a pairing token for a session.
- **Why it matters:** Any web page can complete the pairing exchange (the hosted-pairing flow is precisely this — but it's not restricted to the legitimate hosted origin).
- **Fix direction:** Reflect a configured allowlist of pairing-origin hosts.

### M7 — No CSP on the renderer
- **Where:** [apps/web/index.html:1-104](../../apps/web/index.html#L1-L104) — no meta CSP; no header in [apps/web/vite.config.ts](../../apps/web/vite.config.ts).
- **What:** Defense-in-depth gap. Current Markdown pipeline (react-markdown 10.1.0, no rehype-raw, no rehype-sanitize, default `urlTransform` strips `javascript:`) is well-locked — but a regression has no second line of defense.
- **Why it matters:** Renderer XSS pivots to RCE via the loopback session cookie. CSP forbidding `unsafe-inline`/`unsafe-eval` + `connect-src` allowlist would meaningfully blunt that pivot.
- **Fix direction:** Strict CSP with no `unsafe-*`, `connect-src` limited to configured environments, `frame-src` allowlist, `object-src 'none'`.

### M8 — Embedded browser pane keeps `allow-same-origin`
- **Where:** [apps/web/src/components/AtelierWorkbench.tsx:2190-2195](../../apps/web/src/components/AtelierWorkbench.tsx#L2190-L2195); URL normalization [:2241-2261](../../apps/web/src/components/AtelierWorkbench.tsx#L2241-L2261).
- **What:** `<iframe sandbox="allow-forms allow-same-origin allow-scripts">` with no host allowlist. `normalizeBrowserTarget` happily accepts `http://localhost:5733` → same-origin with the host app.
- **Why it matters:** User points the embedded browser at their own backend → that frame is same-origin and can read app state. Even at third-party origins, scripts in the iframe can `fetch('http://127.0.0.1:<port>/...')` — the H1 rebinding posture amplifies this.
- **Fix direction:** Drop `allow-same-origin`; block loopback/private-network URLs in `normalizeBrowserTarget`; add a `frame-src` CSP.

### M9 — No code-signing / hardened runtime / notarization in electron-builder config
- **Where:** [scripts/build-desktop-artifact.ts:562-628](../../scripts/build-desktop-artifact.ts#L562-L628).
- **What:** `mac` config sets only `target/icon/category`. No `hardenedRuntime`, no `entitlements`, no `notarize`, no `asarIntegrity`.
- **Fix direction:** Wire signing/notarization; fail the build if `--signed` is requested without a signing identity. Set `asarIntegrity: true`.

### M10 — Auto-updater feed URL not asserted HTTPS in code
- **Where:** [updates/DesktopUpdates.ts:112-125](../../apps/desktop/src/updates/DesktopUpdates.ts#L112-L125), [:538-558](../../apps/desktop/src/updates/DesktopUpdates.ts#L538-L558); [electron/ElectronUpdater.ts:73-78](../../apps/desktop/src/electron/ElectronUpdater.ts#L73-L78).
- **What:** Feed comes from packaged `app-update.yml`. No runtime check that `provider === "github"` and `url` is `https:`. Mock-updates branch deliberately uses `http://localhost`.
- **Fix direction:** Assert provider + protocol after reading `app-update.yml`; refuse to start the updater otherwise; ensure mock builds can't ship.

### M11 — Pairing token entropy ~60 bits + no apparent rate-limit on bootstrap
- **Where:** [auth/Layers/BootstrapCredentialService.ts:39-46](../../apps/server/src/auth/Layers/BootstrapCredentialService.ts#L39-L46).
- **What:** 12-char Crockford alphabet → 60 bits. Couldn't confirm any rate-limit on `/api/auth/bootstrap` failures.
- **Fix direction:** 16+ chars and/or rate-limit + lockout.

---

## Low / Info

- **L1** — `/.well-known/t3/environment` is unauthenticated and leaks `serverVersion`, project-dir basename ([http.ts:70-82](../../apps/server/src/http.ts#L70-L82)).
- **L2** — `/api/auth/session` is unauthenticated and reveals policy/role for the caller's cookie ([auth/http.ts:35-47](../../apps/server/src/auth/http.ts#L35-L47)).
- **L3** — Session cookie has no `Secure` flag ([auth/http.ts:88-98](../../apps/server/src/auth/http.ts#L88-L98)).
- **L4** — OTLP traces proxy forwards client-supplied trace bodies upstream verbatim ([http.ts:89-136](../../apps/server/src/http.ts#L89-L136)) — `wsToken` URLs may end up in upstream span attributes.
- **L5** — SSH bridge inherits the full server `process.env` into the `ssh` child ([packages/ssh/src/auth.ts:182](../../packages/ssh/src/auth.ts#L182)). Provider subprocesses inherit full server env too ([provider/ProviderInstanceEnvironment.ts:5-16](../../apps/server/src/provider/ProviderInstanceEnvironment.ts#L5-L16)).
- **L6** — `logsDir`, `stateDir`, and the SQLite file use default umask perms; only `secretsDir` is `chmod 700` ([config.ts:111-131](../../apps/server/src/config.ts#L111-L131), [auth/Layers/ServerSecretStore.ts:22-31](../../apps/server/src/auth/Layers/ServerSecretStore.ts#L22-L31)).
- **L7** — `pickFolder` IPC accepts a renderer-supplied `defaultPath` ([ipc/methods/window.ts:67-81](../../apps/desktop/src/ipc/methods/window.ts#L67-L81)) — social-engineering nudge, not direct disclosure.
- **L8** — DevTools menu present in packaged builds ([window/DesktopApplicationMenu.ts:182](../../apps/desktop/src/window/DesktopApplicationMenu.ts#L182)).
- **L9** — SSH host-key trust is fully delegated to the user's `~/.ssh/known_hosts` (no in-app TOFU UI) — expected, but undocumented in REMOTE.md.
- **L10** — `processRunner.run` permits caller-supplied `shell: boolean | string` ([processRunner.ts:27](../../apps/server/src/processRunner.ts#L27)); currently no untrusted caller uses it, but the foot-gun is in the API.

---

## Coverage gaps (not audited)

- **SQL layer** under `apps/server/src/persistence/` — pairing-link/session SQL not opened; assumed parameterized but unverified.
- **VCS / source-control drivers**: `GitVcsDriver.ts`, `GitHubCli.ts`, `GitLabCli.ts`, `BitbucketApi.ts`, `AzureDevOpsCli.ts` — many high-trust client values (branch, ref, URL) flow into argv; argv form is safer but git has had `--upload-pack=`-class bugs.
- **`packages/effect-acp` / `effect-codex-app-server`** JSON-RPC parsers — not audited for prototype-pollution / deserialization issues.
- **Dependency CVE scan** — no `npm audit` / `bun audit` / `osv-scanner` run. Eyeballed `bun.lock`: nothing obviously bad pinned, but a real scan should run before public release.
- **OAuth flows** for Codex / Claude / Cursor — relied on each CLI's own auth file; Atelier doesn't wrap them, but the env-inheritance posture (L5) means env-stored API keys do leak to those CLIs.
- **Lexical editor internals** and `@pierre/diffs` highlighter for raw HTML emission — trusted as standard.
- **Bootstrap-FD handoff lifecycle** (`T3CODE_BOOTSTRAP_FD`) — design looks good (token via fd3 envelope, not argv/env); race conditions not stress-tested.
- **AppImage / NSIS / DMG installer payloads + post-install scripts** — not opened.
- **`packages/contracts` schemas** beyond `terminal.ts`, `editor.ts`, `project.ts`, `desktopBootstrap.ts`, `baseSchemas.ts`, `ipc.ts`.
- **Per-driver provider runtime trust** — only the spawn pattern was checked; the JSON-RPC framing each provider speaks was not audited.

---

## Suggested triage order

If picking three to address first:

1. **H1 (rebinding) + H8 (role gating) + H3 (workspace root)** — these compose into the worst realistic exploit chain: a webpage you visit → full FS read/write + PTY.
2. **H2 (`UNSAFE_NO_AUTH`)** — cheap fix, removes a footgun that's silent today.
3. **H7 (Electron `will-navigate`)** — one listener, broadly raises the cost of any future renderer compromise.
