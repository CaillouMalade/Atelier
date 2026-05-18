import type { ProjectEntry, ProjectReadFileResult, ScopedThreadRef } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from "@lexical/markdown";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  Code2Icon,
  Columns2Icon,
  ExternalLinkIcon,
  FileIcon,
  FilePenLineIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  Maximize2Icon,
  MinusIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows2Icon,
  SaveIcon,
  SearchIcon,
  SparklesIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
  type ChangeEvent as ReactChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { $getRoot, type EditorState, type EditorThemeClasses, type LexicalEditor } from "lexical";

import {
  projectQueryKeys,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "../lib/projectReactQuery";
import { readEnvironmentApi } from "../environmentApi";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useGitStatus } from "../lib/gitStatusState";
import { cn } from "../lib/utils";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { deriveWorkLogEntries } from "../session-logic";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, Thread, TurnDiffSummary } from "../types";
import { useServerKeybindings } from "../rpc/serverState";
import ChatMarkdown from "./ChatMarkdown";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type WorkbenchSingletonTabId = "changes" | "outputs" | "browser" | "scratch";
type WorkbenchTabId = WorkbenchSingletonTabId | `file:${string}` | `output:${string}`;
type WorkbenchPaneId = "primary" | "secondary";
type WorkbenchSplitOrientation = "vertical" | "horizontal";

type WorkbenchSingletonTab = {
  readonly id: WorkbenchSingletonTabId;
  readonly kind: WorkbenchSingletonTabId;
  readonly title: string;
  readonly shortTitle: string;
  readonly icon: typeof FolderIcon;
};

type WorkbenchTab =
  | WorkbenchSingletonTab
  | {
      readonly id: `file:${string}`;
      readonly kind: "file";
      readonly title: string;
      readonly shortTitle: string;
      readonly icon: typeof FileIcon;
      readonly path: string;
    }
  | {
      readonly id: `output:${string}`;
      readonly kind: "output";
      readonly title: string;
      readonly shortTitle: string;
      readonly icon: typeof SparklesIcon;
      readonly path: string;
      readonly contents?: string;
    };

interface WorkbenchPaneState {
  readonly id: WorkbenchPaneId;
  readonly tabIds: WorkbenchTabId[];
  readonly activeTabId: WorkbenchTabId | null;
}

export interface WorkspaceFileOpenRequest {
  readonly relativePath: string;
  readonly nonce: number;
  readonly threadKey: string;
  readonly source?: "workspace" | "output";
}

interface AtelierWorkbenchProps {
  threadRef: ScopedThreadRef;
  diffOpen: boolean;
  renderDiffContent: boolean;
  diffContent: ReactNode;
  fileOpenRequest: WorkspaceFileOpenRequest | null;
  onOpenDiff: () => void;
  onCloseDiff: () => void;
}

interface WorkspaceTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: ProjectEntry["kind"];
  readonly children: WorkspaceTreeNode[];
}

const WORKBENCH_WIDTH_STORAGE_KEY = "atelier:workbench-width";
const WORKBENCH_EXPANDED_STORAGE_KEY = "atelier:workbench-expanded";
const WORKBENCH_SCRATCH_STORAGE_PREFIX = "atelier:scratch:";
const WORKBENCH_BROWSER_STORAGE_PREFIX = "atelier:browser:";
const DEFAULT_WORKBENCH_WIDTH = 420;
const MIN_WORKBENCH_WIDTH = 240;
const FALLBACK_MAX_WORKBENCH_WIDTH = 760;
const COMPACT_WORKBENCH_WIDTH = 220;
const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];

const DEFAULT_WORKBENCH_TABS: ReadonlyArray<WorkbenchSingletonTab> = [
  {
    id: "changes",
    kind: "changes",
    title: "Changes",
    shortTitle: "Diffs",
    icon: WorkflowIcon,
  },
  {
    id: "outputs",
    kind: "outputs",
    title: "Artifacts",
    shortTitle: "Artifacts",
    icon: SparklesIcon,
  },
  {
    id: "browser",
    kind: "browser",
    title: "Browser",
    shortTitle: "Web",
    icon: GlobeIcon,
  },
  {
    id: "scratch",
    kind: "scratch",
    title: "Scratch",
    shortTitle: "Scratch",
    icon: FilePenLineIcon,
  },
];

const DEFAULT_WORKBENCH_TAB_MAP = new Map<WorkbenchTabId, WorkbenchTab>(
  DEFAULT_WORKBENCH_TABS.map((tab) => [tab.id, tab]),
);

const DEFAULT_WORKBENCH_PANES: WorkbenchPaneState[] = [
  {
    id: "primary",
    tabIds: ["outputs"],
    activeTabId: "outputs",
  },
  {
    id: "secondary",
    tabIds: [],
    activeTabId: null,
  },
];

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function basename(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function dirname(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function isAbsolutePath(input: string): boolean {
  return input.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(input);
}

function absoluteFileReadTarget(filePath: string): { cwd: string; relativePath: string } | null {
  const normalized = filePath.replaceAll("\\", "/").trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const relativePath = normalized.replace(/^\/+/u, "");
  return relativePath.length > 0 ? { cwd: "/", relativePath } : null;
}

function workbenchMaxWidth(): number {
  if (typeof window === "undefined") return FALLBACK_MAX_WORKBENCH_WIDTH;
  return Math.max(FALLBACK_MAX_WORKBENCH_WIDTH, Math.floor(window.innerWidth * 0.92));
}

function compactPath(path: string, maxSegments = 3): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return path;
  return `.../${segments.slice(-maxSegments).join("/")}`;
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

function isMarkdownPath(path: string): boolean {
  return [".md", ".mdx", ".markdown"].includes(extensionOf(path));
}

function isHtmlPath(path: string): boolean {
  return [".html", ".htm"].includes(extensionOf(path));
}

function isSvgPath(path: string): boolean {
  return extensionOf(path) === ".svg";
}

function isImagePath(path: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"].includes(extensionOf(path));
}

function isPdfPath(path: string): boolean {
  return extensionOf(path) === ".pdf";
}

function isJsonPath(path: string): boolean {
  return extensionOf(path) === ".json";
}

function isPreviewableOutputPath(path: string): boolean {
  const extension = extensionOf(path);
  return (
    isMarkdownPath(path) ||
    isHtmlPath(path) ||
    isSvgPath(path) ||
    isImagePath(path) ||
    isJsonPath(path) ||
    [".txt", ".css", ".js", ".jsx", ".ts", ".tsx", ".astro", ".yaml", ".yml"].includes(extension)
  );
}

function fileTabId(path: string): `file:${string}` {
  return `file:${path}`;
}

function outputTabId(path: string): `output:${string}` {
  return `output:${path}`;
}

function makeFileTab(path: string): WorkbenchTab {
  return {
    id: fileTabId(path),
    kind: "file",
    title: basename(path),
    shortTitle: basename(path),
    icon: FileIcon,
    path,
  };
}

function makeOutputTab(path: string, contents?: string): WorkbenchTab {
  return {
    id: outputTabId(path),
    kind: "output",
    title: basename(path),
    shortTitle: basename(path),
    icon: SparklesIcon,
    path,
    ...(contents !== undefined ? { contents } : {}),
  };
}

function dataUrlForFile(file: ProjectReadFileResult): string | null {
  if (file.encoding === "base64") {
    return `data:${file.mimeType};base64,${file.contents}`;
  }
  if (isSvgPath(file.relativePath)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.contents)}`;
  }
  return null;
}

function joinRelativePath(directory: string, name: string): string {
  const trimmedDirectory = directory.replace(/^\/+|\/+$/g, "");
  const trimmedName = name.replace(/^\/+/g, "");
  return trimmedDirectory.length > 0 ? `${trimmedDirectory}/${trimmedName}` : trimmedName;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Failed to read ${file.name}.`));
        return;
      }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(file);
  });
}

function sortWorkspaceTreeNodes(items: WorkspaceTreeNode[]) {
  items.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const item of items) sortWorkspaceTreeNodes(item.children);
}

function buildWorkspaceTree(entries: readonly ProjectEntry[]): WorkspaceTreeNode[] {
  const nodes = new Map<string, WorkspaceTreeNode>();
  const ensureNode = (entry: Pick<ProjectEntry, "path" | "kind">): WorkspaceTreeNode => {
    const existing = nodes.get(entry.path);
    if (existing) return existing;
    const node: WorkspaceTreeNode = {
      path: entry.path,
      name: basename(entry.path),
      kind: entry.kind,
      children: [],
    };
    nodes.set(entry.path, node);
    return node;
  };

  for (const entry of entries) {
    ensureNode(entry);
    let parentPath = dirname(entry.path);
    while (parentPath) {
      ensureNode({ path: parentPath, kind: "directory" });
      parentPath = dirname(parentPath);
    }
  }

  const roots: WorkspaceTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = dirname(node.path);
    const parent = parentPath ? nodes.get(parentPath) : null;
    if (parent) {
      if (!parent.children.some((child) => child.path === node.path)) {
        parent.children.push(node);
      }
      continue;
    }
    roots.push(node);
  }

  sortWorkspaceTreeNodes(roots);
  return roots;
}

function flattenTree(
  nodes: readonly WorkspaceTreeNode[],
  openDirectories: ReadonlySet<string>,
  depth = 0,
): Array<{ node: WorkspaceTreeNode; depth: number }> {
  const rows: Array<{ node: WorkspaceTreeNode; depth: number }> = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && openDirectories.has(node.path)) {
      rows.push(...flattenTree(node.children, openDirectories, depth + 1));
    }
  }
  return rows;
}

function summarizeChangedFiles(thread: Thread | undefined, gitFiles: readonly GitStatusFile[]) {
  if (gitFiles.length > 0) {
    return gitFiles.map((file) => ({
      path: file.path,
      additions: file.insertions,
      deletions: file.deletions,
      kind: "working tree",
    }));
  }

  const latestCheckpoint = thread?.turnDiffSummaries.at(-1);
  return (
    latestCheckpoint?.files.map((file) => ({
      path: file.path,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      kind: file.kind ?? "checkpoint",
    })) ?? []
  );
}

interface OutputCandidate {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly subtitle: string;
  readonly createdAt: string;
  readonly kind: "plan" | "file" | "diff";
  readonly contents?: string;
}

interface ActivityOutputCandidate {
  readonly path: string;
  readonly createdAt: string;
  readonly subtitle: string;
}

function collectOutputCandidates(input: {
  thread: Thread | undefined;
  activityFiles: readonly ActivityOutputCandidate[];
  turnDiffSummaries: readonly TurnDiffSummary[];
}): OutputCandidate[] {
  const proposedPlans = input.thread?.proposedPlans ?? [];
  const byPath = new Map<string, OutputCandidate>();

  for (const plan of proposedPlans) {
    const path = `.atelier/plans/${plan.id}.md`;
    byPath.set(path, {
      id: `plan:${plan.id}`,
      path,
      title: firstMarkdownHeading(plan.planMarkdown) ?? "Proposed plan",
      subtitle: plan.implementedAt ? "Implemented plan" : "Pending plan",
      createdAt: plan.createdAt,
      kind: "plan",
      contents: plan.planMarkdown,
    });
  }

  for (const summary of input.turnDiffSummaries) {
    for (const file of summary.files) {
      if (!isPreviewableOutputPath(file.path)) continue;
      byPath.set(file.path, {
        id: `checkpoint:${summary.turnId}:${file.path}`,
        path: file.path,
        title: basename(file.path),
        subtitle: `${summary.status ?? "checkpoint"} · ${file.kind ?? "modified"}`,
        createdAt: summary.completedAt,
        kind: "file",
      });
    }
  }

  for (const file of input.activityFiles) {
    if (!isPreviewableOutputPath(file.path)) continue;
    byPath.set(file.path, {
      id: `activity:${file.path}`,
      path: file.path,
      title: basename(file.path),
      subtitle: file.subtitle,
      createdAt: file.createdAt,
      kind: "file",
    });
  }

  return [...byPath.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

function collectActivityOutputCandidates(thread: Thread | undefined): ActivityOutputCandidate[] {
  if (!thread) return [];
  const workEntries = deriveWorkLogEntries(thread.activities, undefined);
  const byPath = new Map<string, ActivityOutputCandidate>();

  for (const entry of workEntries) {
    const paths = entry.changedFiles ?? [];
    for (const path of paths) {
      byPath.set(path, {
        path,
        createdAt: entry.createdAt,
        subtitle:
          entry.requestKind === "file-change" || entry.itemType === "file_change"
            ? "generated or modified file"
            : "tool output",
      });
    }
  }

  return [...byPath.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

type GitStatusFile = {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
};

function useWorkbenchWidth() {
  const [width, setWidth] = useState(() =>
    readStoredNumber(WORKBENCH_WIDTH_STORAGE_KEY, DEFAULT_WORKBENCH_WIDTH),
  );
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      dragRef.current = { startX: event.clientX, startWidth: width };
      document.body.classList.add("resizing");

      const onPointerMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const nextWidth = Math.max(
          MIN_WORKBENCH_WIDTH,
          Math.min(workbenchMaxWidth(), drag.startWidth - (moveEvent.clientX - drag.startX)),
        );
        setWidth(nextWidth);
      };

      const onPointerUp = () => {
        dragRef.current = null;
        document.body.classList.remove("resizing");
        window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      event.preventDefault();
    },
    [width],
  );

  useEffect(() => {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  return { width, onPointerDown };
}

export function AtelierWorkspaceDrawer(props: {
  threadRef: ScopedThreadRef;
  open: boolean;
  onClose: () => void;
  onOpenFile: (relativePath: string) => void;
}) {
  const thread = useStore(
    useMemo(() => createThreadSelectorByRef(props.threadRef), [props.threadRef]),
  );
  const activeProject = useStore((state) =>
    thread
      ? selectProjectByRef(state, {
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        })
      : undefined,
  );
  const activeCwd = thread?.worktreePath ?? activeProject?.cwd ?? null;
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [uploadTargetDirectory, setUploadTargetDirectory] = useState("");
  const [isAddingFiles, setIsAddingFiles] = useState(false);
  const [addFilesError, setAddFilesError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [openDirectories, setOpenDirectories] = useState<ReadonlySet<string>>(
    () => new Set(["src", "apps", "packages", ".docs", "docs"]),
  );

  const trimmedWorkspaceQuery = workspaceQuery.trim();
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId: thread?.environmentId ?? null,
      cwd: activeCwd,
      query: trimmedWorkspaceQuery.length > 0 ? trimmedWorkspaceQuery : ".",
      limit: trimmedWorkspaceQuery.length > 0 ? 180 : 5000,
      refresh: workspaceRefreshToken > 0,
      refreshToken: workspaceRefreshToken,
      enabled: props.open && Boolean(thread?.environmentId && activeCwd),
    }),
  );

  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const workspaceTree = useMemo(() => buildWorkspaceTree(workspaceEntries), [workspaceEntries]);
  const visibleTreeRows = useMemo(
    () => flattenTree(workspaceTree, openDirectories),
    [openDirectories, workspaceTree],
  );
  const toggleDirectory = useCallback((path: string) => {
    setOpenDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const refreshWorkspaceEntries = useCallback(() => {
    setWorkspaceRefreshToken((token) => token + 1);
  }, []);
  const openAddFilesPicker = useCallback((directory: string) => {
    setUploadTargetDirectory(directory);
    setAddFilesError(null);
    fileInputRef.current?.click();
  }, []);
  const addFilesToWorkspace = useCallback(
    async (directory: string, files: FileList | readonly File[]) => {
      if (!activeCwd || !thread?.environmentId || files.length === 0) {
        return;
      }
      const api = readEnvironmentApi(thread.environmentId);
      if (!api) {
        setAddFilesError("Workspace API is unavailable.");
        return;
      }

      setIsAddingFiles(true);
      setAddFilesError(null);
      try {
        for (const file of Array.from(files)) {
          await api.projects.writeFile({
            cwd: activeCwd,
            relativePath: joinRelativePath(directory, file.name),
            contents: await readFileAsBase64(file),
            encoding: "base64",
          });
        }
        refreshWorkspaceEntries();
        setOpenDirectories((previous) => {
          if (!directory) return previous;
          const next = new Set(previous);
          next.add(directory);
          return next;
        });
      } catch (error) {
        setAddFilesError(error instanceof Error ? error.message : "Failed to add file.");
      } finally {
        setIsAddingFiles(false);
      }
    },
    [activeCwd, refreshWorkspaceEntries, thread?.environmentId],
  );
  const onFilesSelected = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const files = event.currentTarget.files;
      if (files) {
        void addFilesToWorkspace(uploadTargetDirectory, files);
      }
      event.currentTarget.value = "";
    },
    [addFilesToWorkspace, uploadTargetDirectory],
  );

  if (!props.open) {
    return null;
  }

  return (
    <aside className="hidden h-full min-h-0 w-80 shrink-0 border-r border-border bg-card text-foreground shadow-sm lg:flex lg:flex-col">
      <WorkspacePanel
        project={activeProject}
        activeCwd={activeCwd}
        query={workspaceQuery}
        onQueryChange={setWorkspaceQuery}
        onRefresh={refreshWorkspaceEntries}
        onAddFiles={openAddFilesPicker}
        onDropFiles={(directory, files) => void addFilesToWorkspace(directory, files)}
        isAddingFiles={isAddingFiles}
        addFilesError={addFilesError}
        isLoading={workspaceEntriesQuery.isFetching && workspaceEntries.length === 0}
        isRefreshing={workspaceEntriesQuery.isFetching && workspaceEntries.length > 0}
        isError={workspaceEntriesQuery.isError}
        truncated={workspaceEntriesQuery.data?.truncated ?? false}
        rows={visibleTreeRows}
        openDirectories={openDirectories}
        onToggleDirectory={toggleDirectory}
        onOpenFile={props.onOpenFile}
        onClose={props.onClose}
      />
      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        multiple
        onChange={onFilesSelected}
      />
    </aside>
  );
}

export function AtelierWorkbench({
  threadRef,
  diffOpen,
  renderDiffContent,
  diffContent,
  fileOpenRequest,
  onOpenDiff,
  onCloseDiff,
}: AtelierWorkbenchProps) {
  const thread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const keybindings = useServerKeybindings();
  const activeProject = useStore((state) =>
    thread
      ? selectProjectByRef(state, {
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        })
      : undefined,
  );
  const activeCwd = thread?.worktreePath ?? activeProject?.cwd ?? null;
  const gitStatus = useGitStatus({
    environmentId: thread?.environmentId ?? null,
    cwd: activeCwd,
  });
  const { turnDiffSummaries } = useTurnDiffSummaries(thread);
  const { width, onPointerDown } = useWorkbenchWidth();
  const [expanded, setExpanded] = useState(() =>
    readStoredBoolean(WORKBENCH_EXPANDED_STORAGE_KEY, true),
  );
  const [tabById, setTabById] = useState<ReadonlyMap<WorkbenchTabId, WorkbenchTab>>(
    () => new Map(DEFAULT_WORKBENCH_TAB_MAP),
  );
  const [panes, setPanes] = useState<WorkbenchPaneState[]>(() => [
    {
      id: "primary",
      tabIds: [...DEFAULT_WORKBENCH_PANES[0]!.tabIds],
      activeTabId: DEFAULT_WORKBENCH_PANES[0]!.activeTabId,
    },
    {
      id: "secondary",
      tabIds: [...DEFAULT_WORKBENCH_PANES[1]!.tabIds],
      activeTabId: DEFAULT_WORKBENCH_PANES[1]!.activeTabId,
    },
  ]);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitOrientation, setSplitOrientation] = useState<WorkbenchSplitOrientation>("vertical");
  const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;

  const gitFiles = gitStatus.data?.workingTree.files ?? [];
  const changedFiles = summarizeChangedFiles(thread, gitFiles);
  const activityFiles = useMemo(() => collectActivityOutputCandidates(thread), [thread]);
  const activeProviderLabel = thread?.modelSelection.instanceId ?? "provider";
  const activeModelLabel = thread?.modelSelection.model ?? "model";
  const outputCandidates = useMemo(
    () => collectOutputCandidates({ thread, activityFiles, turnDiffSummaries }),
    [activityFiles, thread, turnDiffSummaries],
  );
  const outputCount = outputCandidates.length;

  useEffect(() => {
    window.localStorage.setItem(WORKBENCH_EXPANDED_STORAGE_KEY, String(expanded));
  }, [expanded]);

  useEffect(() => {
    setTabById(new Map(DEFAULT_WORKBENCH_TAB_MAP));
    setPanes([
      {
        id: "primary",
        tabIds: [...DEFAULT_WORKBENCH_PANES[0]!.tabIds],
        activeTabId: DEFAULT_WORKBENCH_PANES[0]!.activeTabId,
      },
      {
        id: "secondary",
        tabIds: [...DEFAULT_WORKBENCH_PANES[1]!.tabIds],
        activeTabId: DEFAULT_WORKBENCH_PANES[1]!.activeTabId,
      },
    ]);
    setSplitOpen(false);
  }, [threadKey]);

  const activePaneId = panes.find((pane) => pane.activeTabId !== null)?.id ?? "primary";

  const activateTab = useCallback(
    (tabId: WorkbenchTabId, paneId: WorkbenchPaneId = activePaneId) => {
      setExpanded(true);
      setPanes((previous) =>
        previous.map((pane) => {
          if (pane.id !== paneId) return pane;
          return {
            ...pane,
            tabIds: pane.tabIds.includes(tabId) ? pane.tabIds : [...pane.tabIds, tabId],
            activeTabId: tabId,
          };
        }),
      );
      if (tabId === "changes") {
        onOpenDiff();
        return;
      }
      if (diffOpen) {
        onCloseDiff();
      }
    },
    [activePaneId, diffOpen, onCloseDiff, onOpenDiff],
  );

  const ensureTab = useCallback(
    (tab: WorkbenchTab, paneId: WorkbenchPaneId = activePaneId) => {
      setTabById((previous) => {
        if (previous.get(tab.id) === tab) return previous;
        const next = new Map(previous);
        next.set(tab.id, tab);
        return next;
      });
      activateTab(tab.id, paneId);
    },
    [activateTab, activePaneId],
  );

  useEffect(() => {
    if (!diffOpen) return;
    setExpanded(true);
    setPanes((previous) =>
      previous.map((pane, index) =>
        index === 0
          ? {
              ...pane,
              tabIds: pane.tabIds.includes("changes") ? pane.tabIds : ["changes", ...pane.tabIds],
              activeTabId: "changes",
            }
          : pane,
      ),
    );
  }, [diffOpen]);

  useEffect(() => {
    if (!fileOpenRequest) return;
    if (fileOpenRequest.threadKey !== threadKey) return;
    const tab =
      fileOpenRequest.source === "output"
        ? makeOutputTab(fileOpenRequest.relativePath)
        : makeFileTab(fileOpenRequest.relativePath);
    ensureTab(tab, activePaneId);
  }, [activePaneId, ensureTab, fileOpenRequest, threadKey]);

  const closeTab = useCallback(
    (tabId: WorkbenchTabId, paneId: WorkbenchPaneId) => {
      setPanes((previous) =>
        previous.map((pane) => {
          if (pane.id !== paneId) return pane;
          const nextTabIds = pane.tabIds.filter((id) => id !== tabId);
          const nextActiveTabId =
            pane.activeTabId === tabId ? (nextTabIds.at(-1) ?? null) : pane.activeTabId;
          return {
            ...pane,
            tabIds: nextTabIds,
            activeTabId: nextActiveTabId,
          };
        }),
      );
      if (tabId === "changes" && diffOpen) {
        onCloseDiff();
      }
    },
    [diffOpen, onCloseDiff],
  );

  const closeSplit = useCallback(() => {
    setSplitOpen(false);
    setPanes((previous) => {
      const primaryPane = previous.find((pane) => pane.id === "primary");
      const secondaryPane = previous.find((pane) => pane.id === "secondary");
      if (!primaryPane || !secondaryPane || secondaryPane.tabIds.length === 0) {
        return previous;
      }

      const mergedTabIds = [
        ...primaryPane.tabIds,
        ...secondaryPane.tabIds.filter((tabId) => !primaryPane.tabIds.includes(tabId)),
      ];

      return previous.map((pane) => {
        if (pane.id === "primary") {
          return {
            ...pane,
            tabIds: mergedTabIds,
            activeTabId:
              primaryPane.activeTabId ?? secondaryPane.activeTabId ?? mergedTabIds.at(-1) ?? null,
          };
        }
        if (pane.id === "secondary") {
          return {
            ...pane,
            tabIds: [],
            activeTabId: null,
          };
        }
        return pane;
      });
    });
  }, []);

  const toggleSplit = useCallback(
    (orientation: WorkbenchSplitOrientation) => {
      if (splitOpen && splitOrientation === orientation) {
        closeSplit();
        return;
      }
      setSplitOpen(true);
      setSplitOrientation(orientation);
    },
    [closeSplit, splitOpen, splitOrientation],
  );

  const moveActiveTab = useCallback((fromPaneId: WorkbenchPaneId) => {
    setSplitOpen(true);
    setPanes((previous) => {
      const fromPane = previous.find((pane) => pane.id === fromPaneId);
      const tabId = fromPane?.activeTabId;
      if (!tabId) return previous;
      const targetPaneId: WorkbenchPaneId = fromPaneId === "primary" ? "secondary" : "primary";
      return previous.map((pane) => {
        if (pane.id === fromPaneId) {
          const nextTabIds = pane.tabIds.filter((id) => id !== tabId);
          return {
            ...pane,
            tabIds: nextTabIds,
            activeTabId: nextTabIds.at(-1) ?? null,
          };
        }
        if (pane.id === targetPaneId) {
          return {
            ...pane,
            tabIds: pane.tabIds.includes(tabId) ? pane.tabIds : [...pane.tabIds, tabId],
            activeTabId: tabId,
          };
        }
        return pane;
      });
    });
  }, []);

  const openOutput = useCallback(
    (path: string) => {
      const output = outputCandidates.find((candidate) => candidate.path === path);
      ensureTab(makeOutputTab(path, output?.contents), activePaneId);
    },
    [activePaneId, ensureTab, outputCandidates],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
        },
      });
      if (!command) return;

      if (command === "workbench.toggle") {
        event.preventDefault();
        event.stopPropagation();
        setExpanded((previous) => !previous);
        return;
      }

      const tabByCommand: Partial<Record<string, WorkbenchSingletonTabId>> = {
        "workbench.diffs": "changes",
        "workbench.artifacts": "outputs",
        "workbench.web": "browser",
        "workbench.notes": "scratch",
      };
      const tabId = tabByCommand[command];
      if (!tabId) return;

      event.preventDefault();
      event.stopPropagation();
      activateTab(tabId);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activateTab, keybindings]);

  const visiblePanes = splitOpen ? panes : panes.filter((pane) => pane.id === "primary");

  if (!expanded) {
    return (
      <aside
        className="relative hidden h-full min-h-0 shrink-0 border-l border-border bg-card/80 text-foreground shadow-sm xl:flex xl:flex-col"
        style={{ width: COMPACT_WORKBENCH_WIDTH }}
      >
        <div
          className="absolute inset-y-0 left-[-4px] z-10 w-2 cursor-ew-resize"
          onPointerDown={onPointerDown}
        />
        <CompactWorkbenchRail
          project={activeProject}
          thread={thread}
          gitStatus={gitStatus}
          changedFiles={changedFiles}
          outputCount={outputCount}
          outputCandidates={outputCandidates}
          activeProviderLabel={activeProviderLabel}
          activeModelLabel={activeModelLabel}
          onExpand={() => setExpanded(true)}
          onSelectTab={activateTab}
          onOpenOutput={openOutput}
        />
      </aside>
    );
  }

  return (
    <aside
      className="relative hidden h-full min-h-0 shrink-0 flex-col border-l border-border bg-card text-foreground shadow-sm lg:flex"
      style={{ width }}
    >
      <div
        className="absolute inset-y-0 left-[-4px] z-20 w-2 cursor-ew-resize"
        onPointerDown={onPointerDown}
      />
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => setExpanded(false)}
                aria-label="Collapse Atelier workbench"
              >
                <PanelRightCloseIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Collapse workbench</TooltipPopup>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <span className="truncate px-1 text-xs font-medium text-muted-foreground">Workbench</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={splitOpen && splitOrientation === "vertical" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => toggleSplit("vertical")}
                aria-label={
                  splitOpen && splitOrientation === "vertical"
                    ? "Unsplit workbench"
                    : "Split workbench vertically"
                }
              >
                <Columns2Icon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {splitOpen && splitOrientation === "vertical" ? "Unsplit" : "Split vertically"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={splitOpen && splitOrientation === "horizontal" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => toggleSplit("horizontal")}
                aria-label={
                  splitOpen && splitOrientation === "horizontal"
                    ? "Unsplit workbench"
                    : "Split workbench horizontally"
                }
              >
                <Rows2Icon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {splitOpen && splitOrientation === "horizontal" ? "Unsplit" : "Split horizontally"}
          </TooltipPopup>
        </Tooltip>
      </div>
      <WorkbenchToolLauncherBar
        activeTabId={panes.find((pane) => pane.id === activePaneId)?.activeTabId ?? null}
        outputCount={outputCount}
        onSelectTab={activateTab}
      />

      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          splitOpen && splitOrientation === "horizontal" ? "flex flex-col" : "flex",
        )}
      >
        {visiblePanes.map((pane) => (
          <WorkbenchPane
            key={pane.id}
            pane={pane}
            tabById={tabById}
            activeCwd={activeCwd}
            thread={thread}
            threadRef={threadRef}
            activeProject={activeProject}
            gitStatus={gitStatus}
            changedFiles={changedFiles}
            turnDiffSummaries={turnDiffSummaries}
            outputCandidates={outputCandidates}
            renderDiffContent={renderDiffContent}
            diffContent={diffContent}
            splitOpen={splitOpen}
            onActivateTab={(tabId) => activateTab(tabId, pane.id)}
            onCloseTab={(tabId) => closeTab(tabId, pane.id)}
            onMoveActiveTab={() => moveActiveTab(pane.id)}
            onOpenOutput={openOutput}
          />
        ))}
      </div>
    </aside>
  );
}

function WorkbenchToolLauncherBar(props: {
  activeTabId: WorkbenchTabId | null;
  outputCount: number;
  onSelectTab: (tabId: WorkbenchSingletonTabId) => void;
}) {
  return (
    <div className="grid h-11 shrink-0 grid-cols-4 gap-1 border-b border-border bg-card px-2 py-1.5">
      {DEFAULT_WORKBENCH_TABS.map((tab) => {
        const ToolIcon = tab.icon;
        const selected = props.activeTabId === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-background/65 hover:text-foreground",
            )}
            onClick={() => props.onSelectTab(tab.id)}
            title={`Open ${tab.title}`}
            aria-pressed={selected}
          >
            <ToolIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{tab.shortTitle}</span>
            {tab.id === "outputs" && props.outputCount > 0 ? (
              <span className="min-w-4 rounded-full bg-muted px-1 text-center text-[10px] text-muted-foreground">
                {props.outputCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function WorkbenchPane(props: {
  pane: WorkbenchPaneState;
  tabById: ReadonlyMap<WorkbenchTabId, WorkbenchTab>;
  activeCwd: string | null;
  thread: Thread | undefined;
  threadRef: ScopedThreadRef;
  activeProject: Project | undefined;
  gitStatus: ReturnType<typeof useGitStatus>;
  changedFiles: ReadonlyArray<{
    path: string;
    additions: number;
    deletions: number;
    kind: string;
  }>;
  turnDiffSummaries: readonly TurnDiffSummary[];
  outputCandidates: readonly OutputCandidate[];
  renderDiffContent: boolean;
  diffContent: ReactNode;
  splitOpen: boolean;
  onActivateTab: (tabId: WorkbenchTabId) => void;
  onCloseTab: (tabId: WorkbenchTabId) => void;
  onMoveActiveTab: () => void;
  onOpenOutput: (path: string) => void;
}) {
  const activeTab = props.pane.activeTabId ? props.tabById.get(props.pane.activeTabId) : undefined;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/60 first:border-l-0">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {props.pane.tabIds.map((tabId) => {
            const tab = props.tabById.get(tabId);
            if (!tab) return null;
            const TabIcon = tab.icon;
            const selected = tabId === props.pane.activeTabId;
            return (
              <div
                key={tabId}
                className={cn(
                  "group inline-flex h-6 min-w-0 max-w-36 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                  selected
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-background/65 hover:text-foreground",
                )}
                title={tab.title}
              >
                <button
                  type="button"
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => props.onActivateTab(tabId)}
                >
                  <TabIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{tab.shortTitle}</span>
                  {tab.id === "outputs" && props.outputCandidates.length > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">
                      {props.outputCandidates.length}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={cn(
                    "ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                    selected ? "opacity-70" : "opacity-0 group-hover:opacity-100",
                  )}
                  onClick={() => props.onCloseTab(tabId)}
                  aria-label={`Close ${tab.title}`}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        {props.splitOpen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={props.onMoveActiveTab}
                  disabled={!props.pane.activeTabId}
                  aria-label="Move active tab to other pane"
                >
                  {props.pane.id === "primary" ? <ArrowRightIcon /> : <ArrowLeftIcon />}
                </Button>
              }
            />
            <TooltipPopup side="bottom">Move tab</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          <WorkbenchTabContent
            tab={activeTab}
            activeCwd={props.activeCwd}
            thread={props.thread}
            threadRef={props.threadRef}
            activeProject={props.activeProject}
            gitStatus={props.gitStatus}
            changedFiles={props.changedFiles}
            turnDiffSummaries={props.turnDiffSummaries}
            outputCandidates={props.outputCandidates}
            renderDiffContent={props.renderDiffContent}
            diffContent={props.diffContent}
            onOpenOutput={props.onOpenOutput}
          />
        ) : (
          <EmptyWorkbenchState
            icon={FolderOpenIcon}
            title="No tab selected"
            description="Open a file, output, browser, note, or diff tab."
          />
        )}
      </div>
    </section>
  );
}

function WorkbenchTabContent(props: {
  tab: WorkbenchTab;
  activeCwd: string | null;
  thread: Thread | undefined;
  threadRef: ScopedThreadRef;
  activeProject: Project | undefined;
  gitStatus: ReturnType<typeof useGitStatus>;
  changedFiles: ReadonlyArray<{
    path: string;
    additions: number;
    deletions: number;
    kind: string;
  }>;
  turnDiffSummaries: readonly TurnDiffSummary[];
  outputCandidates: readonly OutputCandidate[];
  renderDiffContent: boolean;
  diffContent: ReactNode;
  onOpenOutput: (path: string) => void;
}) {
  switch (props.tab.kind) {
    case "changes":
      return (
        <ChangesPanel
          gitStatus={props.gitStatus}
          changedFiles={props.changedFiles}
          turnDiffSummaries={props.turnDiffSummaries}
          renderDiffContent={props.renderDiffContent}
          diffContent={props.diffContent}
        />
      );
    case "outputs":
      return (
        <OutputsPanel
          thread={props.thread}
          outputCandidates={props.outputCandidates}
          onOpenOutput={props.onOpenOutput}
        />
      );
    case "browser":
      return <BrowserPanel threadRef={props.threadRef} />;
    case "scratch":
      return <ScratchPanel threadRef={props.threadRef} activeProject={props.activeProject} />;
    case "file":
    case "output":
      return (
        <FileTabPanel
          environmentId={props.threadRef.environmentId}
          activeCwd={props.activeCwd}
          path={props.tab.path}
          {...(props.tab.kind === "output" && props.tab.contents !== undefined
            ? { initialContents: props.tab.contents }
            : {})}
          output={props.tab.kind === "output"}
        />
      );
  }
}

function CompactWorkbenchRail(props: {
  project: Project | undefined;
  thread: Thread | undefined;
  gitStatus: ReturnType<typeof useGitStatus>;
  changedFiles: ReadonlyArray<{
    path: string;
    additions: number;
    deletions: number;
    kind: string;
  }>;
  outputCount: number;
  outputCandidates: readonly OutputCandidate[];
  activeProviderLabel: string;
  activeModelLabel: string;
  onExpand: () => void;
  onSelectTab: (tab: WorkbenchTabId) => void;
  onOpenOutput: (path: string) => void;
}) {
  const running = props.thread?.session?.status === "running";
  const changedFileCount = props.changedFiles.length;
  const sourceFiles = props.changedFiles.slice(0, 5);
  const artifactFiles = props.outputCandidates.slice(0, 5);

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-foreground">Atelier</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {props.project?.name ?? "No workspace"}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={props.onExpand}
          aria-label="Expand Atelier workbench"
        >
          <PanelRightOpenIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <CompactCard title="Progress">
          <CompactStatusRow
            done
            label="Workspace indexed"
            {...(props.project?.name ? { detail: props.project.name } : {})}
          />
          <CompactStatusRow
            done={props.thread?.session !== null}
            label={running ? "Agent working" : "Agent ready"}
            detail={`${props.activeProviderLabel} · ${props.activeModelLabel}`}
          />
          <CompactStatusRow
            done={changedFileCount > 0}
            label={changedFileCount > 0 ? `${changedFileCount} changed file(s)` : "No changes yet"}
            {...(props.gitStatus.data?.refName ? { detail: props.gitStatus.data.refName } : {})}
          />
        </CompactCard>

        <CompactCard title="Branch Details">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={() => props.onSelectTab("changes")}
          >
            <WorkflowIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Changes</span>
            <span className="shrink-0 text-[11px]">
              +{props.gitStatus.data?.workingTree.insertions ?? 0} / -
              {props.gitStatus.data?.workingTree.deletions ?? 0}
            </span>
          </button>
          <CompactStatusRow
            done={props.gitStatus.data?.isRepo ?? false}
            label={props.gitStatus.data?.refName ?? "No Git repository"}
            detail={
              props.gitStatus.data?.hasUpstream
                ? `${props.gitStatus.data.aheadCount} ahead · ${props.gitStatus.data.behindCount} behind`
                : "local"
            }
          />
        </CompactCard>

        <CompactCard title="Sources">
          {sourceFiles.length > 0 ? (
            sourceFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                title={file.path}
                onClick={() => props.onSelectTab("outputs")}
              >
                <FileIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{basename(file.path)}</span>
              </button>
            ))
          ) : (
            <p className="px-1.5 py-1 text-xs text-muted-foreground/70">No indexed files yet.</p>
          )}
        </CompactCard>

        <CompactCard title="Artifacts">
          {artifactFiles.length > 0 ? (
            artifactFiles.map((output) => {
              const OutputIcon = isMarkdownPath(output.path)
                ? FileTextIcon
                : isImagePath(output.path)
                  ? ImageIcon
                  : SparklesIcon;
              return (
                <button
                  key={output.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                  title={output.path}
                  onClick={() => props.onOpenOutput(output.path)}
                >
                  <OutputIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{output.title}</span>
                  <span className="shrink-0 text-[11px]">
                    {formatRelativeTimeLabel(output.createdAt)}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="px-1.5 py-1 text-xs text-muted-foreground/70">No artifacts yet.</p>
          )}
          {props.outputCount > artifactFiles.length ? (
            <button
              type="button"
              className="mt-1 flex w-full items-center justify-between rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={() => props.onSelectTab("outputs")}
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <SparklesIcon className="size-3.5 shrink-0" />
                <span className="truncate">Show all</span>
              </span>
              <span className="shrink-0 text-[11px]">{props.outputCount}</span>
            </button>
          ) : null}
        </CompactCard>
      </div>
    </>
  );
}

function CompactCard(props: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-background/55 p-2">
      <div className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">{props.title}</div>
      <div className="space-y-0.5">{props.children}</div>
    </section>
  );
}

function CompactStatusRow(props: { done: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs">
      {props.done ? (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
      ) : (
        <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground/85">{props.label}</span>
      {props.detail ? (
        <span className="max-w-24 truncate text-[11px] text-muted-foreground">{props.detail}</span>
      ) : null}
    </div>
  );
}

function WorkbenchPanelShell(props: {
  title: string;
  subtitle?: string | null;
  icon: typeof FolderIcon;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{props.title}</h2>
          {props.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.subtitle}</p>
          ) : null}
        </div>
        {props.actions ? (
          <div className="flex shrink-0 items-center gap-1">{props.actions}</div>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

type FileBadgeSpec = { readonly label: string; readonly className: string };

const FILE_BADGE_BY_EXT: Readonly<Record<string, FileBadgeSpec>> = {
  ts: { label: "TS", className: "bg-blue-500/15 text-blue-500" },
  tsx: { label: "TS", className: "bg-blue-500/15 text-blue-500" },
  mts: { label: "TS", className: "bg-blue-500/15 text-blue-500" },
  cts: { label: "TS", className: "bg-blue-500/15 text-blue-500" },
  js: { label: "JS", className: "bg-amber-500/15 text-amber-600" },
  jsx: { label: "JS", className: "bg-amber-500/15 text-amber-600" },
  mjs: { label: "JS", className: "bg-amber-500/15 text-amber-600" },
  cjs: { label: "JS", className: "bg-amber-500/15 text-amber-600" },
  json: { label: "JS", className: "bg-amber-500/15 text-amber-600" },
  md: { label: "MD", className: "bg-slate-500/15 text-slate-500" },
  mdx: { label: "MD", className: "bg-slate-500/15 text-slate-500" },
  html: { label: "HTM", className: "bg-orange-500/15 text-orange-500" },
  htm: { label: "HTM", className: "bg-orange-500/15 text-orange-500" },
  css: { label: "CSS", className: "bg-cyan-500/15 text-cyan-500" },
  scss: { label: "CSS", className: "bg-cyan-500/15 text-cyan-500" },
  sass: { label: "CSS", className: "bg-cyan-500/15 text-cyan-500" },
  pdf: { label: "PDF", className: "bg-red-500/15 text-red-500" },
  png: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  jpg: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  jpeg: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  gif: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  webp: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  avif: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  ico: { label: "IMG", className: "bg-pink-500/15 text-pink-500" },
  svg: { label: "SVG", className: "bg-pink-500/15 text-pink-500" },
  yml: { label: "YML", className: "bg-violet-500/15 text-violet-500" },
  yaml: { label: "YML", className: "bg-violet-500/15 text-violet-500" },
  toml: { label: "TML", className: "bg-violet-500/15 text-violet-500" },
  py: { label: "PY", className: "bg-emerald-500/15 text-emerald-600" },
  go: { label: "GO", className: "bg-sky-500/15 text-sky-500" },
  rs: { label: "RS", className: "bg-orange-500/15 text-orange-600" },
  sh: { label: "SH", className: "bg-zinc-500/15 text-zinc-500" },
  bash: { label: "SH", className: "bg-zinc-500/15 text-zinc-500" },
  zsh: { label: "SH", className: "bg-zinc-500/15 text-zinc-500" },
  lock: { label: "LK", className: "bg-zinc-500/15 text-zinc-500" },
  txt: { label: "TXT", className: "bg-zinc-500/15 text-zinc-500" },
  env: { label: "ENV", className: "bg-yellow-500/15 text-yellow-600" },
};

function getFileBadge(name: string): FileBadgeSpec | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = lower.slice(dot + 1);
  return FILE_BADGE_BY_EXT[ext] ?? null;
}

function FileTypeBadge({ name }: { name: string }) {
  const badge = getFileBadge(name);
  if (!badge) {
    return <FileIcon className="size-3.5 shrink-0 text-muted-foreground/70" />;
  }
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm font-semibold leading-none tracking-tight",
        badge.label.length >= 3 ? "text-[8px]" : "text-[9px]",
        badge.className,
      )}
      aria-hidden
    >
      {badge.label}
    </span>
  );
}

function WorkspacePanel(props: {
  project: Project | undefined;
  activeCwd: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  isRefreshing: boolean;
  isError: boolean;
  truncated: boolean;
  rows: ReadonlyArray<{ node: WorkspaceTreeNode; depth: number }>;
  openDirectories: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onAddFiles: (directory: string) => void;
  onDropFiles: (directory: string, files: FileList) => void;
  isAddingFiles: boolean;
  addFilesError: string | null;
  onClose?: () => void;
}) {
  const handleDrop = (directory: string, event: ReactDragEvent<HTMLElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onDropFiles(directory, event.dataTransfer.files);
  };
  const allowFileDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
    }
  };

  return (
    <WorkbenchPanelShell
      title="Workspace"
      subtitle={props.activeCwd ?? "Open or create a thread with a workspace"}
      icon={FolderOpenIcon}
      actions={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => props.onAddFiles("")}
                  aria-label="Add files to workspace root"
                  disabled={!props.activeCwd || props.isAddingFiles}
                >
                  <PlusIcon />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Add files</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={props.onRefresh}
                  aria-label="Refresh workspace files"
                  disabled={!props.activeCwd || props.isRefreshing}
                >
                  <RefreshCwIcon className={cn(props.isRefreshing && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Refresh files</TooltipPopup>
          </Tooltip>
          {props.onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={props.onClose}
              aria-label="Close workspace file drawer"
            >
              <PanelRightCloseIcon />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="shrink-0 border-b border-border p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            className="h-8 pl-8 text-xs"
            value={props.query}
            placeholder="Filter files and folders"
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </div>
        {props.truncated ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Showing the highest ranked entries from a large workspace.
          </p>
        ) : null}
        {props.addFilesError ? (
          <p className="mt-2 text-[11px] text-destructive">{props.addFilesError}</p>
        ) : null}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onDragOver={allowFileDrop}
        onDrop={(event) => handleDrop("", event)}
      >
        {props.isLoading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} className="h-6 rounded-md" />
            ))}
          </div>
        ) : props.isError ? (
          <EmptyWorkbenchState
            icon={FolderIcon}
            title="Workspace index unavailable"
            description="The backend could not read entries for this workspace."
          />
        ) : props.rows.length === 0 ? (
          <EmptyWorkbenchState
            icon={FolderIcon}
            title={props.project ? "No matching files" : "No active workspace"}
            description={
              props.project
                ? "Try a broader query."
                : "Start a project thread and Atelier will show the workspace here."
            }
          />
        ) : (
          <div className="space-y-0.5">
            {props.rows.map(({ node, depth }) => {
              const isDirectory = node.kind === "directory";
              const isOpen = props.openDirectories.has(node.path);
              return (
                <div
                  key={node.path}
                  className="group flex h-7 w-full min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                  onDragOver={isDirectory ? allowFileDrop : undefined}
                  onDrop={isDirectory ? (event) => handleDrop(node.path, event) : undefined}
                  title={node.path}
                >
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 text-left"
                    style={{ paddingLeft: 6 + depth * 14 }}
                    onClick={() => {
                      if (isDirectory) props.onToggleDirectory(node.path);
                      else props.onOpenFile(node.path);
                    }}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                      {isDirectory ? (
                        isOpen ? (
                          <ChevronDownIcon className="size-3" />
                        ) : (
                          <ChevronRightIcon className="size-3" />
                        )
                      ) : null}
                    </span>
                    {isDirectory ? (
                      <FolderIcon className="size-3.5 shrink-0" />
                    ) : (
                      <FileTypeBadge name={node.name} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {!isDirectory ? (
                      <span className="hidden shrink-0 text-[10px] text-muted-foreground/45 group-hover:block">
                        {compactPath(dirname(node.path), 2)}
                      </span>
                    ) : null}
                  </button>
                  {isDirectory ? (
                    <button
                      type="button"
                      className="mr-1 hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground group-hover:flex"
                      aria-label={`Add files to ${node.path}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onAddFiles(node.path);
                      }}
                    >
                      <PlusIcon className="size-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </WorkbenchPanelShell>
  );
}

function ChangesPanel(props: {
  gitStatus: ReturnType<typeof useGitStatus>;
  changedFiles: ReadonlyArray<{
    path: string;
    additions: number;
    deletions: number;
    kind: string;
  }>;
  turnDiffSummaries: readonly TurnDiffSummary[];
  renderDiffContent: boolean;
  diffContent: ReactNode;
}) {
  const status = props.gitStatus.data;
  const summarySubtitle = status?.isRepo
    ? `${status.refName ?? "detached"} · ${status.aheadCount} ahead · ${status.behindCount} behind`
    : "Git details appear here when the workspace is a repository";

  return (
    <WorkbenchPanelShell title="Changes" subtitle={summarySubtitle} icon={WorkflowIcon}>
      <div className="grid shrink-0 grid-cols-3 gap-2 border-b border-border p-3">
        <MetricTile label="Files" value={String(props.changedFiles.length)} />
        <MetricTile label="Added" value={`+${status?.workingTree.insertions ?? 0}`} tone="add" />
        <MetricTile label="Deleted" value={`-${status?.workingTree.deletions ?? 0}`} tone="del" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {props.renderDiffContent ? (
          props.diffContent
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/70 px-4 py-2 text-xs font-medium text-muted-foreground">
              Working Tree
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {props.changedFiles.length > 0 ? (
                <div className="space-y-1">
                  {props.changedFiles.map((file) => (
                    <div
                      key={file.path}
                      className="rounded-lg border border-border/65 bg-background/50 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {file.path}
                        </span>
                        <span className="shrink-0">
                          <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{file.kind}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyWorkbenchState
                  icon={WorkflowIcon}
                  title="No changes to inspect"
                  description={
                    props.turnDiffSummaries.length > 0
                      ? "Select a completed turn from the chat to open its checkpoint diff."
                      : "Atelier will show changed files and checkpoints here."
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>
    </WorkbenchPanelShell>
  );
}

function MetricTile(props: { label: string; value: string; tone?: "add" | "del" }) {
  return (
    <div className="rounded-lg border border-border bg-background/55 px-3 py-2">
      <div className="text-[10px] font-medium text-muted-foreground uppercase">{props.label}</div>
      <div
        className={cn(
          "mt-1 text-sm font-semibold",
          props.tone === "add" && "text-success-foreground",
          props.tone === "del" && "text-destructive-foreground",
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

function OutputsPanel(props: {
  thread: Thread | undefined;
  outputCandidates: readonly OutputCandidate[];
  onOpenOutput: (path: string) => void;
}) {
  return (
    <WorkbenchPanelShell
      title="Artifacts"
      subtitle={
        props.thread
          ? "Previewable generated and modified files"
          : "Artifacts appear after a workspace session starts"
      }
      icon={SparklesIcon}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {props.outputCandidates.length > 0 ? (
          <div className="space-y-2">
            {props.outputCandidates.map((output) => {
              const OutputIcon =
                output.kind === "diff"
                  ? WorkflowIcon
                  : isImagePath(output.path)
                    ? ImageIcon
                    : isMarkdownPath(output.path)
                      ? FileTextIcon
                      : SparklesIcon;
              return (
                <button
                  key={output.id}
                  type="button"
                  className="w-full rounded-lg border border-border bg-background/55 p-3 text-left transition-colors hover:bg-background"
                  onClick={() => props.onOpenOutput(output.path)}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-card text-muted-foreground">
                      <OutputIcon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium text-foreground">
                        {output.title}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {output.path}
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground/75">
                        <span>{output.subtitle}</span>
                        <span>·</span>
                        <span>{formatRelativeTimeLabel(output.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyWorkbenchState
            icon={SparklesIcon}
            title="No artifacts yet"
            description="Generated HTML, Markdown, SVG, images, JSON, and useful text files will collect here."
          />
        )}
      </div>
    </WorkbenchPanelShell>
  );
}

function firstMarkdownHeading(markdown: string): string | null {
  const heading = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  return heading ? heading.replace(/^#+\s*/u, "").trim() : null;
}

function FileTabPanel(props: {
  environmentId: ScopedThreadRef["environmentId"];
  activeCwd: string | null;
  path: string;
  initialContents?: string;
  output: boolean;
}) {
  const queryClient = useQueryClient();
  const fileReadTarget = useMemo(() => {
    if (props.initialContents !== undefined) {
      return null;
    }
    if (isAbsolutePath(props.path) && props.output) {
      return absoluteFileReadTarget(props.path);
    }
    return props.activeCwd ? { cwd: props.activeCwd, relativePath: props.path } : null;
  }, [props.activeCwd, props.initialContents, props.output, props.path]);
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      environmentId: props.environmentId,
      cwd: fileReadTarget?.cwd ?? null,
      relativePath: fileReadTarget?.relativePath ?? null,
      enabled: props.initialContents === undefined,
    }),
  );
  const initialLoadedFile = useMemo<ProjectReadFileResult | null>(() => {
    if (props.initialContents === undefined) return null;
    return {
      relativePath: props.path,
      contents: props.initialContents,
      encoding: "utf8",
      mimeType: isMarkdownPath(props.path) ? "text/markdown" : "text/plain",
      sizeBytes: new TextEncoder().encode(props.initialContents).length,
    };
  }, [props.initialContents, props.path]);
  const loadedFile = initialLoadedFile ?? fileQuery.data;
  const [draft, setDraft] = useState("");
  const [lastLoadedKey, setLastLoadedKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadedFile || loadedFile.encoding !== "utf8") return;
    const nextLoadedKey = `${loadedFile.relativePath}:${loadedFile.sizeBytes}:${loadedFile.contents}`;
    if (lastLoadedKey === nextLoadedKey) return;
    setDraft(loadedFile.contents);
    setLastLoadedKey(nextLoadedKey);
    setSaveError(null);
  }, [lastLoadedKey, loadedFile]);

  const writeTarget = loadedFile?.encoding === "utf8" ? fileReadTarget : null;
  const canEdit = writeTarget !== null;
  const dirty = canEdit && loadedFile !== undefined && draft !== loadedFile.contents;
  const saveFile = useCallback(async () => {
    if (!canEdit || !loadedFile || !writeTarget) return;
    setSaving(true);
    setSaveError(null);
    try {
      const api = readEnvironmentApi(props.environmentId);
      if (!api) throw new Error("Environment API is unavailable.");
      await api.projects.writeFile({
        cwd: writeTarget.cwd,
        relativePath: writeTarget.relativePath,
        contents: draft,
      });
      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.readFile(
          props.environmentId,
          writeTarget.cwd,
          writeTarget.relativePath,
        ),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [canEdit, draft, loadedFile, props.environmentId, queryClient, writeTarget]);

  const fileIcon = isImagePath(props.path)
    ? ImageIcon
    : isMarkdownPath(props.path)
      ? FileTextIcon
      : FileIcon;

  return (
    <WorkbenchPanelShell
      title={basename(props.path)}
      subtitle={props.path}
      icon={fileIcon}
      actions={
        canEdit ? (
          <Button
            type="button"
            variant={dirty ? "default" : "ghost"}
            size="sm"
            onClick={saveFile}
            disabled={!dirty || saving}
          >
            <SaveIcon />
            <span>{saving ? "Saving" : "Save"}</span>
          </Button>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-hidden bg-background/45">
        {fileQuery.isFetching && !loadedFile ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-5 rounded-md" />
            ))}
          </div>
        ) : fileQuery.isError && !loadedFile ? (
          <EmptyWorkbenchState
            icon={FileIcon}
            title="File unavailable"
            description="Atelier could not read this workspace file."
          />
        ) : loadedFile ? (
          <FilePreviewSurface
            file={loadedFile}
            draft={draft}
            editable={canEdit}
            onDraftChange={setDraft}
          />
        ) : (
          <EmptyWorkbenchState
            icon={FileIcon}
            title="No file loaded"
            description="Open a workspace file from the left drawer."
          />
        )}
      </div>
      {saveError ? (
        <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive">
          {saveError}
        </div>
      ) : dirty ? (
        <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Unsaved changes
        </div>
      ) : null}
    </WorkbenchPanelShell>
  );
}

function FilePreviewSurface(props: {
  file: ProjectReadFileResult;
  draft: string;
  editable: boolean;
  onDraftChange: (value: string) => void;
}) {
  if (isMarkdownPath(props.file.relativePath) && props.file.encoding === "utf8") {
    return props.editable ? (
      <LiveMarkdownEditor
        value={props.draft}
        onChange={props.onDraftChange}
        ariaLabel={`${props.file.relativePath} Markdown editor`}
      />
    ) : (
      <MarkdownPreviewSurface value={props.draft || props.file.contents} />
    );
  }

  if (isHtmlPath(props.file.relativePath) && props.file.encoding === "utf8") {
    return (
      <iframe
        title={props.file.relativePath}
        srcDoc={props.file.contents}
        sandbox="allow-forms allow-scripts"
        className="h-full w-full border-0 bg-background"
      />
    );
  }

  if (isImagePath(props.file.relativePath) || isSvgPath(props.file.relativePath)) {
    const dataUrl = dataUrlForFile(props.file);
    if (dataUrl) {
      return (
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-4">
          <img
            src={dataUrl}
            alt={basename(props.file.relativePath)}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      );
    }
  }

  if (isPdfPath(props.file.relativePath)) {
    const dataUrl = dataUrlForFile(props.file);
    if (dataUrl) {
      return (
        <iframe
          title={props.file.relativePath}
          src={dataUrl}
          className="h-full w-full border-0 bg-background"
        />
      );
    }
  }

  if (props.file.encoding === "utf8") {
    return (
      <textarea
        className="h-full w-full resize-none border-0 bg-card p-4 font-mono text-xs leading-5 text-foreground outline-none"
        value={props.draft}
        readOnly={!props.editable}
        onChange={(event) => props.onDraftChange(event.target.value)}
        spellCheck={false}
      />
    );
  }

  return (
    <EmptyWorkbenchState
      icon={FileIcon}
      title="Binary preview unavailable"
      description="This file type cannot be rendered directly inside Atelier yet."
    />
  );
}

function MarkdownPreviewSurface(props: { value: string }) {
  return (
    <div className="h-full overflow-y-auto bg-card p-4">
      <div className="mx-auto max-w-3xl">
        <ChatMarkdown text={props.value} cwd={undefined} />
      </div>
    </div>
  );
}

const MARKDOWN_EDITOR_EXTERNAL_UPDATE_TAG = "atelier-markdown-external-update";
const MARKDOWN_EDITOR_TRANSFORMERS = TRANSFORMERS;
const MARKDOWN_EDITOR_THEME: EditorThemeClasses = {
  code: "my-3 block overflow-x-auto rounded-md border border-border bg-muted/45 px-3 py-2 font-mono text-xs leading-5 text-foreground",
  heading: {
    h1: "mt-5 mb-3 text-3xl font-semibold leading-tight text-foreground",
    h2: "mt-5 mb-2 text-2xl font-semibold leading-tight text-foreground",
    h3: "mt-4 mb-2 text-xl font-semibold leading-snug text-foreground",
    h4: "mt-3 mb-1.5 text-base font-semibold leading-snug text-foreground",
    h5: "mt-3 mb-1 text-sm font-semibold leading-snug text-foreground",
    h6: "mt-3 mb-1 text-xs font-semibold uppercase leading-snug text-muted-foreground",
  },
  link: "text-primary underline underline-offset-2",
  list: {
    checklist: "my-2 space-y-1 pl-1",
    listitem: "pl-1 text-sm leading-6 text-foreground/90",
    listitemChecked: "pl-1 text-sm leading-6 text-muted-foreground line-through",
    listitemUnchecked: "pl-1 text-sm leading-6 text-foreground/90",
    nested: {
      listitem: "list-none",
    },
    olDepth: [
      "my-2 list-decimal space-y-1 pl-7",
      "my-2 list-[lower-alpha] space-y-1 pl-7",
      "my-2 list-[lower-roman] space-y-1 pl-7",
    ],
    ul: "my-2 list-disc space-y-1 pl-7",
    ulDepth: [
      "my-2 list-disc space-y-1 pl-7",
      "my-2 list-[circle] space-y-1 pl-7",
      "my-2 list-[square] space-y-1 pl-7",
    ],
  },
  paragraph: "my-2 text-sm leading-6 text-foreground/90",
  quote:
    "my-3 border-l-2 border-border bg-muted/20 py-1 pl-3 text-sm leading-6 text-muted-foreground",
  text: {
    bold: "font-semibold text-foreground",
    code: "rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground",
    italic: "italic",
    strikethrough: "line-through",
    underline: "underline underline-offset-2",
  },
};

function LiveMarkdownEditor(props: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [initialMarkdown] = useState(props.value);
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      editorState: () => {
        $convertFromMarkdownString(initialMarkdown, MARKDOWN_EDITOR_TRANSFORMERS, undefined, true);
      },
      namespace: "AtelierMarkdownEditor",
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
      onError(error) {
        throw error;
      },
      theme: MARKDOWN_EDITOR_THEME,
    }),
    [initialMarkdown],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative h-full bg-card">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="h-full overflow-y-auto px-5 py-4 text-foreground outline-none [caret-color:var(--foreground)] [&_*::selection]:bg-primary/20"
              aria-placeholder="Start writing..."
              placeholder={<span />}
              spellCheck
            />
          }
          placeholder={
            <div className="pointer-events-none absolute top-4 left-5 text-sm text-muted-foreground/45">
              Start writing...
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <MarkdownEditorBridge value={props.value} onChange={props.onChange} />
        <HistoryPlugin />
        <ListPlugin shouldPreserveNumbering />
        <CheckListPlugin />
        <MarkdownShortcutPlugin transformers={MARKDOWN_EDITOR_TRANSFORMERS} />
      </div>
    </LexicalComposer>
  );
}

function MarkdownEditorBridge(props: { value: string; onChange: (value: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const latestMarkdownRef = useRef(props.value);
  const isApplyingExternalUpdateRef = useRef(false);

  useEffect(() => {
    if (props.value === latestMarkdownRef.current) return;
    isApplyingExternalUpdateRef.current = true;
    editor.update(
      () => {
        $getRoot().clear();
        $convertFromMarkdownString(props.value, MARKDOWN_EDITOR_TRANSFORMERS, undefined, true);
        latestMarkdownRef.current = props.value;
      },
      { tag: MARKDOWN_EDITOR_EXTERNAL_UPDATE_TAG },
    );
    isApplyingExternalUpdateRef.current = false;
  }, [editor, props.value]);

  const handleChange = useCallback(
    (editorState: EditorState, _editor: LexicalEditor, tags: Set<string>) => {
      if (isApplyingExternalUpdateRef.current || tags.has(MARKDOWN_EDITOR_EXTERNAL_UPDATE_TAG)) {
        return;
      }
      editorState.read(() => {
        const nextMarkdown = $convertToMarkdownString(
          MARKDOWN_EDITOR_TRANSFORMERS,
          undefined,
          true,
        );
        if (nextMarkdown === latestMarkdownRef.current) return;
        latestMarkdownRef.current = nextMarkdown;
        props.onChange(nextMarkdown);
      });
    },
    [props],
  );

  return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}

function BrowserPanel(props: { threadRef: ScopedThreadRef }) {
  const storageKey = `${WORKBENCH_BROWSER_STORAGE_PREFIX}${props.threadRef.environmentId}:${props.threadRef.threadId}`;
  const [url, setUrl] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(storageKey) ?? "";
  });
  const [draftUrl, setDraftUrl] = useState(url);

  useEffect(() => {
    window.localStorage.setItem(storageKey, url);
    setDraftUrl(url);
  }, [storageKey, url]);

  const browserTarget = normalizeBrowserTarget(url);
  const canRender = browserTarget.kind === "url";
  const openExternal = () => {
    if (browserTarget.kind === "url") {
      window.open(browserTarget.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <WorkbenchPanelShell
      title="Browser"
      subtitle={browserTarget.kind === "url" ? browserTarget.url : "Session-local browser surface"}
      icon={GlobeIcon}
      actions={
        <>
          <Button variant="ghost" size="icon-xs" disabled aria-label="Back">
            <ArrowLeftIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled aria-label="Forward">
            <ArrowRightIcon />
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <Button variant="ghost" size="icon-xs" disabled aria-label="Reload">
          <RefreshCwIcon />
        </Button>
        <div className="relative min-w-0 flex-1">
          <GlobeIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/65" />
          <Input
            className="h-8 pl-8 text-xs"
            value={draftUrl}
            placeholder="https://"
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setUrl(draftUrl.trim());
              }
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={browserTarget.kind !== "url"}
          onClick={openExternal}
          aria-label="Open externally"
        >
          <Maximize2Icon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-background/45">
        {canRender && browserTarget.kind === "url" ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">
                Some sites block embedding. Use external open if the frame stays blank.
              </span>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-background hover:text-foreground"
                onClick={openExternal}
              >
                <ExternalLinkIcon className="size-3" />
                External
              </button>
            </div>
            <iframe
              title={browserTarget.url}
              src={browserTarget.url}
              sandbox="allow-forms allow-same-origin allow-scripts"
              className="min-h-0 flex-1 border-0 bg-background"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-xs text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
                <GlobeIcon className="size-5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">Where to?</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {browserTarget.kind === "local"
                  ? "Local files open through Atelier file and output tabs."
                  : browserTarget.kind === "invalid"
                    ? browserTarget.message
                    : "Enter a URL, localhost address, or search text above."}
              </p>
              <div className="mt-4 grid gap-2">
                {[
                  { label: "OpenAI Codex docs", target: "https://developers.openai.com/codex" },
                  { label: "Atelier local app", target: "http://localhost:5733" },
                ].map(({ label, target }) => (
                  <button
                    key={target}
                    type="button"
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setUrl(target)}
                  >
                    <HistoryIcon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </WorkbenchPanelShell>
  );
}

type BrowserTarget =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "local"; message: string }
  | { kind: "invalid"; message: string };

function normalizeBrowserTarget(url: string): BrowserTarget {
  const trimmed = url.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^file:\/\//iu.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return {
      kind: "local",
      message: "Local files are previewed inside Atelier from the workspace drawer or Outputs tab.",
    };
  }
  if (/^https?:\/\//iu.test(trimmed)) return { kind: "url", url: trimmed };
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/iu.test(trimmed)) {
    return { kind: "url", url: `http://${trimmed}` };
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/iu.test(trimmed)) {
    return { kind: "url", url: `https://${trimmed}` };
  }
  return {
    kind: "url",
    url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`,
  };
}

function ScratchPanel(props: { threadRef: ScopedThreadRef; activeProject: Project | undefined }) {
  const storageKey = `${WORKBENCH_SCRATCH_STORAGE_PREFIX}${props.threadRef.environmentId}:${props.threadRef.threadId}`;
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(storageKey) ?? "";
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, value);
  }, [storageKey, value]);

  return (
    <WorkbenchPanelShell
      title="Scratch"
      subtitle={
        props.activeProject ? `${props.activeProject.name} · session local` : "Session local"
      }
      icon={FilePenLineIcon}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setValue("")}
          aria-label="Clear scratch"
        >
          <MinusIcon />
        </Button>
      }
    >
      <div className="min-h-0 flex-1 bg-background/45 p-3">
        <div className="h-full overflow-hidden rounded-lg border border-border bg-card">
          <LiveMarkdownEditor
            value={value}
            onChange={setValue}
            ariaLabel="Scratch Markdown editor"
          />
        </div>
      </div>
    </WorkbenchPanelShell>
  );
}

function EmptyWorkbenchState(props: {
  icon: typeof FolderIcon;
  title: string;
  description: string;
}) {
  const Icon = props.icon;
  return (
    <div className="flex h-full min-h-52 items-center justify-center p-6">
      <div className="max-w-xs text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <h3 className="mt-3 text-sm font-semibold text-foreground">{props.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}
