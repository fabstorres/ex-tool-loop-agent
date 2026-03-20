import { LanguageModel, Prompt, Tool, Toolkit } from "@effect/ai";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { NodeContext } from "@effect/platform-node";
import type { AiError } from "@effect/ai/AiError";
import { FetchHttpClient, FileSystem, Path } from "@effect/platform";
import { Config, Console, Effect, Layer, Schema, Stream } from "effect";
import type { StreamPart } from "@effect/ai/Response";

const model = OpenRouterLanguageModel.model("stepfun/step-3.5-flash:free");
const maxSteps = 25;

const taskCompleted = Tool.make("task_completed", {
  description: "Call this tool to end your tool loop",
  success: Schema.Boolean,
  failure: Schema.Never,
});

const TaskCompletedTools = Toolkit.make(taskCompleted);

const TaskCompletedToolHandlers = TaskCompletedTools.toLayer({
  task_completed: () => Effect.succeed(true),
});

class ReadFileError extends Schema.TaggedError<ReadFileError>("ReadFileError")("ReadFileError", {
  reason: Schema.Literal("not_found", "permission_denied", "unknown"),
  message: Schema.String,
}) {}

const readFileTool = Tool.make("read_file", {
  description: "Read file from the given arguement",
  parameters: {
    path: Schema.String,
  },
  success: Schema.String,
  failure: ReadFileError,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem],
});

class GlobError extends Schema.TaggedError<GlobError>("GlobError")("GlobError", {
  reason: Schema.Literal("invalid_pattern", "not_found", "permission_denied", "unknown"),
  message: Schema.String,
}) {}

class WriteFileError extends Schema.TaggedError<WriteFileError>("WriteFileError")("WriteFileError", {
  reason: Schema.Literal("not_found", "permission_denied", "unknown"),
  message: Schema.String,
}) {}

const toReadFileError = (error: { _tag: string; reason?: string; message: string }) =>
  new ReadFileError({
    reason:
      error._tag === "SystemError" && error.reason === "NotFound"
        ? "not_found"
        : error._tag === "SystemError" && error.reason === "PermissionDenied"
          ? "permission_denied"
          : "unknown",
    message: error.message,
  });

const toGlobError = (error: { _tag: string; reason?: string; message: string }) =>
  new GlobError({
    reason:
      error._tag === "SystemError" && error.reason === "NotFound"
        ? "not_found"
        : error._tag === "SystemError" && error.reason === "PermissionDenied"
          ? "permission_denied"
          : "unknown",
    message: error.message,
  });

const toWriteFileError = (error: { _tag: string; reason?: string; message: string }) =>
  new WriteFileError({
    reason:
      error._tag === "SystemError" && error.reason === "NotFound"
        ? "not_found"
        : error._tag === "SystemError" && error.reason === "PermissionDenied"
          ? "permission_denied"
          : "unknown",
    message: error.message,
  });

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globPatternToRegExp = (pattern: string) => {
  let source = "^";

  for (const char of pattern) {
    source += char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char);
  }

  source += "$";

  return new RegExp(source);
};

const globTool = Tool.make("glob", {
  description: "Glob files from the current working directory (non-recursive)",
  parameters: {
    pattern: Schema.String,
  },
  success: Schema.Array(Schema.String),
  failure: GlobError,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem, Path.Path],
});

const writeFileTool = Tool.make("write_file", {
  description: "Write text content to a file path",
  parameters: {
    path: Schema.String,
    content: Schema.String,
  },
  success: Schema.Struct({
    path: Schema.String,
    bytesWritten: Schema.Number,
  }),
  failure: WriteFileError,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem],
});

const AgentTools = Toolkit.make(readFileTool, globTool, writeFileTool);

const AgentToolHandlers = AgentTools.toLayer({
  read_file: ({ path }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      return yield* fileSystem.readFileString(path).pipe(Effect.mapError(toReadFileError));
    }),
  glob: ({ pattern }) =>
    Effect.gen(function* () {
      if (pattern.includes("/") || pattern.includes("\\")) {
        return yield* Effect.fail(
          new GlobError({
            reason: "invalid_pattern",
            message: "Only non-recursive file name patterns are supported",
          }),
        );
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const pathApi = yield* Path.Path;
      const matcher = globPatternToRegExp(pattern);
      const entries = yield* fileSystem.readDirectory(".").pipe(Effect.mapError(toGlobError));
      const matches = yield* Effect.forEach(entries, (entry) =>
        fileSystem.stat(pathApi.join(".", entry)).pipe(
          Effect.map((info) => (info.type === "File" && matcher.test(entry) ? entry : undefined)),
          Effect.mapError(toGlobError),
        ),
      );

      return matches.filter((entry): entry is string => entry !== undefined).sort();
    }),
  write_file: ({ path, content }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.writeFileString(path, content).pipe(Effect.mapError(toWriteFileError));

      return {
        path,
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    }),
});

const toolLoopAgent = Effect.gen(function* () {
  let session = Prompt.empty;

  session = Prompt.setSystem(
    session,
    "You are in a tool loop and after you have completed your task you must call task_completed to finish early. Do not tell the user you are in a loop.",
  );

  session = Prompt.merge(
    session,
    Prompt.make("Tell the user a fun fact. When you are done, call the task_completed tool."),
  );

  const toolLoop = (
    step: number,
  ): Effect.Effect<void, AiError, LanguageModel.LanguageModel | Tool.HandlersFor<typeof TaskCompletedTools.tools>> =>
    Effect.gen(function* () {
      if (step >= maxSteps) {
        return;
      }

      const response = yield* LanguageModel.generateText({
        prompt: session,
        toolkit: TaskCompletedTools,
      });

      session = Prompt.merge(session, Prompt.fromResponseParts(response.content));

      console.log(`[step ${step + 1}] ${response.text}`);

      if (response.toolResults.some((result) => result.name === "task_completed" && result.result === true)) {
        return;
      }

      yield* toolLoop(step + 1);
    });

  yield* toolLoop(0);
  return session;
});

const OpenRouter = OpenRouterClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

// toolLoopAgent.pipe(
//   Effect.provide(TaskCompletedToolHandlers),
//   Effect.provide(model),
//   Effect.provide(OpenRouter),
//   Effect.runPromise,
// );

const streamPrompt = LanguageModel.streamText({
  prompt: "Hello, can you solve two sum in Python",
})
  .pipe(
    Stream.runForEach((part) => {
      if (part.type === "text-delta") {
        return Console.log(part.delta);
      }
      return Effect.void;
    }),
  )
  .pipe(Effect.provide(model), Effect.provide(TaskCompletedToolHandlers));

// streamPrompt.pipe(Effect.provide(OpenRouter), Effect.runPromise);

const agentToolLoop = Effect.gen(function* () {
  let session = Prompt.make(
    "Read the README.md file and write a more detailed document about the project, focusing only on the agentToolLoop and its tools.",
  );
  let step = 0;
  let shouldContinue = true;

  const parts: Array<StreamPart<typeof AgentTools.tools>> = [];

  while (step < maxSteps && shouldContinue) {
    step += 1;
    parts.splice(0, parts.length);
    yield* LanguageModel.streamText({
      prompt: session,
      toolkit: AgentTools,
    }).pipe(
      Stream.runForEach((part) => {
        parts.push(part);
        switch (part.type) {
          case "finish":
            if (part.reason !== "tool-calls") {
              shouldContinue = false;
            }
            break;
          case "text-delta":
            process.stdout.write(part.delta);
            break;
        }
        return Effect.void;
      }),
    );

    process.stdout.write("\n");

    session = Prompt.merge(session, Prompt.fromResponseParts(parts));
  }

  return Effect.void;
});

agentToolLoop.pipe(
  Effect.provide(AgentToolHandlers),
  Effect.provide(model),
  Effect.provide(OpenRouter),
  Effect.provide(NodeContext.layer),
  Effect.runPromise,
);
