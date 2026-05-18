import type {
  EnvironmentId,
  ProjectReadFileResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit: number,
    refreshToken = 0,
  ) =>
    ["projects", "search-entries", environmentId ?? null, cwd, query, limit, refreshToken] as const,
  readFile: (environmentId: EnvironmentId | null, cwd: string | null, relativePath: string) =>
    ["projects", "read-file", environmentId ?? null, cwd, relativePath] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export const EMPTY_READ_FILE_RESULT: ProjectReadFileResult = {
  relativePath: "",
  contents: "",
  encoding: "utf8",
  mimeType: "text/plain",
  sizeBytes: 0,
};

export function projectSearchEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  refresh?: boolean;
  refreshToken?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(
      input.environmentId,
      input.cwd,
      input.query,
      limit,
      input.refreshToken ?? 0,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
        ...(input.refresh === true ? { refresh: true } : {}),
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectReadFileQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.environmentId, input.cwd, input.relativePath ?? ""),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.relativePath) {
        throw new Error("Workspace file reading is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.relativePath !== null &&
      input.relativePath.length > 0,
  });
}
