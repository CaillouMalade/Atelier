/**
 * OpenAiCompatibleTextGeneration — non-streaming `/v1/chat/completions`
 * helper used for commit messages, branch names, PR titles, and thread
 * titles. Shared by the generic OpenAI-compatible driver and the Hermes
 * driver — both backends speak the same protocol.
 *
 * @module textGeneration/OpenAiCompatibleTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

import { normalizeOpenAiBaseUrl } from "../provider/openaiCompatible/openaiHttp.ts";

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const REQUEST_TIMEOUT_MS = 180_000;

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optional(Schema.String),
      }),
    }),
  ),
});
const decodeChatCompletionResponse = Schema.decodeUnknownEffect(ChatCompletionResponse);

export interface OpenAiCompatibleTextGenerationInput {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly fallbackModel: string;
}

export const makeOpenAiCompatibleTextGeneration = Effect.fn(
  "makeOpenAiCompatibleTextGeneration",
)(function* (settings: OpenAiCompatibleTextGenerationInput) {
  const httpClient = yield* HttpClient.HttpClient;

  const failOp = (operation: Operation, detail: string, cause?: unknown) =>
    new TextGenerationError({
      operation,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  const runJson = Effect.fn("runJson")(function* <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const trimmedBaseUrl = settings.baseUrl.trim();
    if (trimmedBaseUrl.length === 0) {
      return yield* failOp(input.operation, "Base URL is not configured.");
    }
    const base = normalizeOpenAiBaseUrl(trimmedBaseUrl);
    const apiToken = settings.apiToken.trim();
    const model = input.modelSelection.model || settings.fallbackModel;

    const requestBody = {
      model,
      stream: false,
      messages: [{ role: "user", content: input.prompt }],
    };

    const httpRequest = HttpClientRequest.post(`${base}/v1/chat/completions`).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      apiToken.length > 0
        ? HttpClientRequest.setHeader("authorization", `Bearer ${apiToken}`)
        : (request) => request,
      HttpClientRequest.bodyJsonUnsafe(requestBody),
    );

    const response = yield* httpClient.execute(httpRequest).pipe(
      Effect.timeout(REQUEST_TIMEOUT_MS),
      Effect.mapError((cause) =>
        failOp(
          input.operation,
          cause instanceof Error ? cause.message : "Chat-completions request failed.",
          cause,
        ),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const detail =
        response.status === 401 || response.status === 403
          ? `Gateway rejected authentication (HTTP ${response.status}). Check the API token.`
          : `Gateway returned HTTP ${response.status}.${bodyText ? ` ${bodyText.slice(0, 500)}` : ""}`;
      return yield* failOp(input.operation, detail);
    }

    const parsed = yield* response.json.pipe(
      Effect.mapError((cause) =>
        failOp(input.operation, "Gateway returned a non-JSON response.", cause),
      ),
    );
    const decoded = yield* decodeChatCompletionResponse(parsed).pipe(
      Effect.mapError((cause) =>
        failOp(
          input.operation,
          "Gateway returned a response that did not match the OpenAI chat-completions shape.",
          cause,
        ),
      ),
    );

    const rawText = (decoded.choices[0]?.message.content ?? "").trim();
    if (rawText.length === 0) {
      return yield* failOp(input.operation, "Gateway returned empty output.");
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawText)).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(failOp(input.operation, "Gateway returned invalid structured output.", cause)),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenAiCompatibleTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runJson({
      operation: "generateCommitMessage",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenAiCompatibleTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runJson({
      operation: "generatePrContent",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenAiCompatibleTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runJson({
      operation: "generateBranchName",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenAiCompatibleTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runJson({
      operation: "generateThreadTitle",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
