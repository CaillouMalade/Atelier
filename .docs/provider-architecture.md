# Provider architecture

The web app communicates with the server through Effect RPC over WebSocket. The
wire surface is defined in `packages/contracts/src/rpc.ts`, and the browser
wraps it through `apps/web/src/rpc/wsTransport.ts` and
`apps/web/src/rpc/wsRpcClient.ts`.

## Built-in drivers

The server currently ships these first-party provider drivers:

- `codex`: OpenAI Codex CLI / app-server integration
- `claudeAgent`: Claude Code agent SDK integration
- `cursor`: Cursor Agent / ACP integration, marked Early Access in the UI
- `opencode`: OpenCode SDK/CLI integration

Drivers are registered in `apps/server/src/provider/builtInDrivers.ts`.
Provider instances are configured in server settings and materialized by the
provider instance registry. That lets users define multiple named instances of
the same driver, such as `codex_work` and `codex_personal`.

## Runtime flow

1. The UI sends typed RPC calls for orchestration, providers, terminal, source
   control, settings, workspace files, and auth.
2. `apps/server/src/ws.ts` routes those calls to server services.
3. `ProviderService` resolves the selected provider instance and calls its
   adapter.
4. Provider-native events flow through `ProviderRuntimeIngestion`.
5. Orchestration events are persisted and projected into shell/thread state.
6. The UI receives changes through RPC subscriptions and renders the chat,
   activity timeline, workbench, terminal, and source-control state.

## Provider settings

Legacy single-instance settings still exist under `settings.providers.<driver>`.
The newer driver-agnostic map lives under `settings.providerInstances`, keyed by
`ProviderInstanceId`. Built-in default instance IDs match their driver names, so
existing settings and provider status caches continue to work during migration.

Sensitive provider environment variables are stored through the server secret
store. Values are redacted before settings are sent back to the browser.

## Determinism

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** consumes provider runtime streams and emits orchestration commands.
2. **ProviderCommandReactor** reacts to orchestration intent events and dispatches provider calls.
3. **CheckpointReactor** captures git checkpoints on turn start/complete and publishes runtime receipts.

These workers use `DrainableWorker` internally and expose `drain()` for
deterministic test synchronization.
