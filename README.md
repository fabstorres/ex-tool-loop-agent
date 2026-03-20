# Agent Tool Loop - Detailed Documentation

## Note

While building this, I discovered a bug in @effect/ai-openrouter@0.9.0 (the latest version prior to this example). The issue occurred when using toolkits with streaming, where tool call deltas could produce malformed objects during parsing.

This caused runtime failures because the schema did not allow partial data, effectively terminating the execution thread.

To demonstrate the problem, I opened issue #6128 with a minimal reproducible example. I then implemented a fix in #6131, which relaxes schema validation for partial tool call deltas during streaming.

The fix was merged and released in @effect/ai-openrouter@0.9.1 (the latest version at the time of writing).

## Overview

The `agentToolLoop` is a sophisticated AI agent implementation that uses a loop-based architecture to interact with tools and accomplish file system operations. Unlike the simple `toolLoopAgent` which only uses a `task_completed` signal, the `agentToolLoop` dynamically uses a toolkit of file system tools to read, discover, and write files until the task is complete or a maximum step limit is reached.

## Architecture

### Core Loop Structure

The `agentToolLoop` is implemented as an Effect program that:

1. **Initializes a session** with a user prompt/instruction
2. **Iterates up to `maxSteps`** (default: 25) times
3. **Streams responses** from the language model while capturing tool calls
4. **Executes tool calls** using the provided handlers
5. **Merges tool results** back into the conversation history
6. **Continues** until either:
   - The language model returns a finish reason other than "tool-calls"
   - The maximum number of steps is reached

### Key Components

```typescript
const agentToolLoop = Effect.gen(function* () {
  let session = Prompt.make(initialPrompt);
  let step = 0;
  let shouldContinue = true;
  const parts: Array<StreamPart<typeof AgentTools.tools>> = [];

  while (step < maxSteps && shouldContinue) {
    step += 1;
    parts.splice(0, parts.length);

    // Stream the response and capture all parts
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

    // Update the conversation with the response (including tool results)
    session = Prompt.merge(session, Prompt.fromResponseParts(parts));
  }

  return Effect.void;
});
```

## Toolkit: Available Tools

The agent uses the `AgentTools` toolkit which includes three file system tools:

### 1. read_file

**Purpose**: Read the contents of a file from the filesystem.

**Schema**:

```typescript
const readFileTool = Tool.make("read_file", {
  description: "Read file from the given argument",
  parameters: {
    path: Schema.String,
  },
  success: Schema.String, // Returns file content as string
  failure: ReadFileError, // Returns error on failure
  failureMode: "return",
  dependencies: [FileSystem.FileSystem],
});
```

**Usage**: The agent can call this tool with a file path to retrieve its contents. It's essential for understanding existing files before modifying them.

**Errors**: Returns a `ReadFileError` with possible reasons:

- `not_found`: File does not exist
- `permission_denied`: Insufficient permissions
- `unknown`: Other I/O errors

### 2. glob

**Purpose**: Discover files in the current working directory using glob patterns (non-recursive).

**Schema**:

```typescript
const globTool = Tool.make("glob", {
  description: "Glob files from the current working directory (non-recursive)",
  parameters: {
    pattern: Schema.String, // e.g., "*.ts", "README.*"
  },
  success: Schema.Array(Schema.String), // Returns array of matching file names
  failure: GlobError,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem, Path.Path],
});
```

**Features**:

- Supports `*` (matches any characters) and `?` (matches single character)
- Only non-recursive - patterns containing `/` or `\\` are rejected
- Only matches files (not directories)
- Returns sorted array of matching file names

**Usage**: Used to discover what files exist, understand project structure, or find specific file types.

**Errors**: Returns a `GlobError` with reasons:

- `invalid_pattern`: Pattern contains path separators
- `not_found`: Current directory cannot be read
- `permission_denied`: Insufficient permissions
- `unknown`: Other errors

### 3. write_file

**Purpose**: Write text content to a file.

**Schema**:

```typescript
const writeFileTool = Tool.make("write_file", {
  description: "Write text content to a file path",
  parameters: {
    path: Schema.String,
    content: Schema.String,
  },
  success: Schema.Struct({
    path: Schema.String,
    bytesWritten: Schema.Number, // Number of bytes written
  }),
  failure: WriteFileError,
  failureMode: "return",
  dependencies: [FileSystem.FileSystem],
});
```

**Usage**: Creates new files or overwrites existing files with the provided content. Returns metadata about the write operation.

**Errors**: Returns a `WriteFileError` with the same reasons as `readFileError`.

## Tool Handlers

Each tool has a corresponding handler that implements the actual functionality. The handlers are provided as a layer to the agent:

```typescript
const AgentToolHandlers = AgentTools.toLayer({
  read_file: ({ path }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.readFileString(path).pipe(Effect.mapError(toReadFileError));
    }),
  glob: ({ pattern }) =>
    Effect.gen(function* () {
      // Validate pattern and perform globbing
      // ...
    }),
  write_file: ({ path, content }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(path, content).pipe(Effect.mapError(toWriteFileError));
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    }),
});
```

## Execution Flow

1. **Initialization**: The agent starts with a user prompt (in this case: "Read the README.md file and write a more detailed document about the project, focusing only on the agentToolLoop and its tools.")

2. **Step Loop**: For each step (up to maxSteps):
   - The language model generates a streamed response using the `AgentTools` toolkit
   - The response may include text deltas and tool calls
   - Text deltas are printed to stdout in real-time
   - Tool results are captured in the `parts` array
   - When a finish event occurs with a reason other than "tool-calls", the loop terminates

3. **Session Update**: After each streaming completes, the response parts (including tool results) are merged back into the conversation history via `Prompt.fromResponseParts()`.

4. **Continuation**: The loop continues as long as the LM indicates more tool calls are needed and the step limit hasn't been reached.

## Configuration

- **Model**: Uses `stepfun/step-3.5-flash:free` from OpenRouter
- **Max Steps**: 25 (configurable via constant)
- **API Key**: Requires `OPENROUTER_API_KEY` environment variable

## Running the Agent

```bash
bun install
bun run index.ts
```

The agent will:

1. Read the README.md file
2. Analyze the project structure using glob
3. Write a detailed document about the agentToolLoop and its tools
4. Complete when the task is done or max steps reached

## Technical Dependencies

- `@effect/ai` - Core AI abstractions
- `@effect/ai-openrouter` - OpenRouter integration
- `@effect/platform` - Platform effects (FileSystem, Path)
- `@effect/platform-node` - Node.js runtime
- `effect` - Effectful programming library
- `bun` - JavaScript runtime

## Error Handling

All tools use structured error types (`ReadFileError`, `GlobError`, `WriteFileError`) with specific failure reasons. This allows the language model to understand what went wrong and potentially retry or adjust its approach. Errors are returned in "return" failure mode, meaning the tool execution returns an error value rather than throwing.
