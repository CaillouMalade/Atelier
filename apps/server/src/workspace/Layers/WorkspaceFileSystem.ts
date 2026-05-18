import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Buffer } from "node:buffer";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const MAX_WORKSPACE_FILE_READ_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".csv",
  ".env",
  ".gitignore",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mdx", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
]);

function extensionOf(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  const slashIndex = lower.lastIndexOf("/");
  const basename = slashIndex === -1 ? lower : lower.slice(slashIndex + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return basename === ".gitignore" ? ".gitignore" : "";
  return basename.slice(dotIndex);
}

function mimeTypeFor(relativePath: string): string {
  return MIME_TYPE_BY_EXTENSION.get(extensionOf(relativePath)) ?? "text/plain";
}

function shouldDecodeAsText(relativePath: string, bytes: Uint8Array): boolean {
  const extension = extensionOf(relativePath);
  if (TEXT_EXTENSIONS.has(extension)) return true;
  return !bytes.slice(0, 1024).includes(0);
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const bytes = yield* fileSystem.readFile(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readFile",
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (bytes.length > MAX_WORKSPACE_FILE_READ_BYTES) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: `File is too large to preview (${bytes.length} bytes).`,
        });
      }

      if (shouldDecodeAsText(target.relativePath, bytes)) {
        const contents = new TextDecoder("utf-8").decode(bytes);
        return {
          relativePath: target.relativePath,
          contents,
          encoding: "utf8",
          mimeType: mimeTypeFor(target.relativePath),
          sizeBytes: bytes.length,
        };
      }

      return {
        relativePath: target.relativePath,
        contents: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
        mimeType: mimeTypeFor(target.relativePath),
        sizeBytes: bytes.length,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const writeEffect =
      input.encoding === "base64"
        ? fileSystem.writeFile(target.absolutePath, Buffer.from(input.contents, "base64"))
        : fileSystem.writeFileString(target.absolutePath, input.contents);
    yield* writeEffect.pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
