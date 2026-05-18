# TODO

## Provider integration handoff (updated 2026-05-18)

### Verified done

- [x] Hermes ACP readiness probe uses supported commands for Hermes v0.13.0:
  `hermes --version` and `hermes acp --help`.
- [x] Hermes ACP does not depend on unsupported `hermes acp --version` or
  `hermes acp --check`.
- [x] Blank Hermes ACP profile runs plain `hermes acp`, matching Arthur's
  working VS Code setup.
- [x] Nonblank Hermes ACP profile runs `hermes -p <profile> acp`; `default`
  was checked manually.
- [x] Hermes ACP publishes a synthetic selectable model, `hermes-agent`
  ("Hermes Agent"), because ACP itself does not advertise models and Hermes
  owns model selection in its config.
- [x] Local Hermes ACP works in the dev app with binary `hermes`, blank
  profile, model `Hermes Agent`.
- [x] Remote Hermes HTTP works against `http://100.83.147.17:8642` when using
  the Hermes HTTP provider and the remote gateway's `API_SERVER_KEY` as token.
- [x] Hermes HTTP / OpenAI-compatible providers become selectable when
  `/v1/models` is empty but a custom model is configured.

### Verification commands

- `bun test apps/server/src/provider/acp/HermesAcpSupport.test.ts apps/server/src/provider/Layers/HermesAcpProvider.test.ts`
- `bun test apps/server/src/provider/acp/HermesAcpSupport.test.ts apps/server/src/provider/Layers/OpenAiCompatibleProvider.test.ts apps/server/src/provider/Layers/HermesProvider.test.ts apps/server/src/provider/openaiCompatible/openaiHttp.test.ts apps/server/src/provider/Layers/HermesAdapter.test.ts`
- `bun run typecheck`

### Packaging note

- Do not package the DMG unless explicitly requested.
- After packaging, verify the packaged macOS app can find `hermes`. If not,
  set Hermes ACP "Binary path" to the absolute path from `which hermes`.

## Backlog / bugs for next version (logged 2026-05-18)

Reported by Arthur — not yet triaged, not yet assigned. Do not start work on
these without explicit instruction; they are logged here so any agent picking
up the codebase can see them.

### Bugs

- [x] **PDF artifacts leak across chats.** When alternating between chats, a
  PDF opened in one chat (an artifact) tries to open in the other chat where
  it doesn't exist. The PDF viewer / artifact state seems to be shared or
  not scoped per-thread. Repro: open a PDF artifact in chat A, switch to
  chat B, observe attempt to open the chat-A PDF in chat B's context.
- [x] **Uncommitted files should not appear in artifacts.** The issue is not
  primarily the displayed date: uncommitted files seem to be included in the
  artifacts list at all. Artifact discovery should exclude uncommitted files
  unless the user explicitly adds or opens them as artifacts.
- [x] **Sending a chat auto-opens the sidebar and artifacts pane.** Sending
  a message forces the sidebar / artifacts panel open even if the user had
  deliberately closed it. The send action should not change panel
  visibility — respect the user's current layout.
- [x] **Cannot `git pull` from the source control UI — only push and commit
  work.** Pull is either missing or broken in the source control surface.
  Check the VCS driver / source-control provider wiring (see
  `.plans/19-version-control-phase-1-vcs-driver-foundation.md` and
  `.plans/20-version-control-phase-2-source-control-provider-foundation.md`).

### Feature requests / UX

- [x] **Allow the app window to be made very narrow.** Today there's a min
  width that prevents using Atelier as a slim chat window docked next to
  other windows. It does not need to work perfectly at extreme sizes; just
  let it compress substantially more, roughly toward a slim tenth-of-screen
  chat-window use case.
- [x] **Add files into the folder tree from the UI.** In the folder-tree
  exploration view, there is no way to add a PDF / file. Add either
  drag-and-drop onto a folder node, or a `+` button on hover, or both. Nice
  to have; not critical if it turns messy.
- [x] **Add a refresh button to the folder tree.** The folder tree appears to
  be indexed once when the app or chat loads. If a chat creates a new
  subdirectory or note, the folder tree does not update. Add a manual refresh
  action in the folder-tree view so the user can rescan when needed.
- [x] **Keyboard shortcut to collapse the right sidebar.** There is currently
  no shortcut for this. Pick a binding consistent with the existing
  sidebar/keybindings convention (see `KEYBINDINGS.md`).
- [ ] **Allow project icon and color customization.** Bare minimum for
  organizing projects: let users choose a project icon and color. Use a good
  icon set, not emoji.
- [ ] **Consider project pinning and folders.** Pinning projects and creating
  folders for projects would help organize many projects. Only do this if the
  UI can stay simple and clean; skip it if it would make the project list
  feel busy or overbuilt.

### Implemented 2026-05-18

- Artifacts panel no longer adds previewable files directly from the dirty
  working tree. It now uses proposed plans, turn diff summaries, and activity
  outputs only.
- Workspace drawer has a refresh button. The web query sends a `refresh` flag
  and the server invalidates the workspace-entry cache before rebuilding the
  index.
- Workspace drawer can add files into the workspace root or a hovered folder
  with a `+` button, and supports drag-and-drop onto the drawer or folder rows.
  Project file writes now accept base64 payloads so PDFs and other binary files
  survive upload intact.
- Source control actions include an explicit Pull menu item when the branch has
  an upstream. Pull uses the existing VCS pull RPC and success/error toasts.
- Workbench file/artifact open requests are scoped to the originating thread so
  an artifact opened in one chat cannot replay into another chat after route
  changes.
- Workbench collapsed/expanded state is persisted in local storage so sending
  a chat or remounting the route does not reopen the right workbench after the
  user has closed it.
- `workbench.toggle` is part of the default configurable keybindings as
  `mod+shift+b`, and is documented in `KEYBINDINGS.md`.
- Desktop window, left sidebar, main content, and workbench minimum widths were
  lowered so the app can compress much more than before.

Verification:

- Arthur manually checked the dev app and confirmed the implemented items work
  as expected.
- Arthur manually checked PDF/artifact switching across chats, source-control
  pull visibility, workspace file add via buttons/drag-and-drop, and the
  configurable right-workbench shortcut.
- `bun --cwd apps/web test src/components/GitActionsControl.logic.test.ts`
- `bunx vitest run apps/server/src/workspace/Layers/WorkspaceFileSystem.test.ts apps/server/src/keybindings.test.ts`
- `bunx vitest run apps/server/src/server.test.ts`
- `bun --cwd apps/server test src/workspace/Layers/WorkspaceEntries.test.ts`
- `bun run typecheck`
