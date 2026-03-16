import { LanguageModel, Prompt, Tool, Toolkit } from "@effect/ai";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import type { AiError } from "@effect/ai/AiError";
import { FetchHttpClient } from "@effect/platform";
import { Config, Effect, Layer, Schema } from "effect";

const model = OpenRouterLanguageModel.model("stepfun/step-3.5-flash:free");
const maxSteps = 5;

const taskCompleted = Tool.make("task_completed", {
  description: "Call this tool to end your tool loop",
  success: Schema.Boolean,
  failure: Schema.Never,
});

const TaskCompletedTools = Toolkit.make(taskCompleted);

const TaskCompletedToolHandlers = TaskCompletedTools.toLayer({
  task_completed: () => Effect.succeed(true),
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

toolLoopAgent.pipe(
  Effect.provide(TaskCompletedToolHandlers),
  Effect.provide(model),
  Effect.provide(OpenRouter),
  Effect.runPromise,
);
