import { z } from "zod";
import type { Context, WorkingMemory } from "./types";
import { formatContextLog } from "./formatters";
import { memory } from "./utils";

/**
 * Creates a context configuration
 * @template Memory - Type of working memory
 * @template Args - Zod schema type for context arguments
 * @template Ctx - Type of context data
 * @template Exports - Type of exported data
 * @param ctx - Context configuration object
 * @returns Typed context configuration
 */
export function context<
  Memory extends WorkingMemory = WorkingMemory,
  Args extends z.ZodTypeAny = any,
  Ctx = any,
  Exports = any,
>(ctx: Context<Memory, Args, Ctx, Exports>) {
  return ctx;
}

export function defaultContextRender(memory: WorkingMemory) {
  return [
    ...memory.inputs.filter((i) => i.processed === true),
    ...memory.outputs,
    ...memory.calls,
    ...memory.results.filter((i) => i.processed === true),
  ]
    .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1))
    .map((i) => formatContextLog(i))
    .flat();
}

export function createDefaultContextMemory(): WorkingMemory {
  return {
    inputs: [],
    outputs: [],
    thoughts: [],
    calls: [],
    results: [],
  };
}

export const defaultContextMemory = memory<WorkingMemory>({
  key: "default",
  create: createDefaultContextMemory,
});

export const defaultContext = context({
  type: "default",
  schema: z.string(),
  key: (key) => key,
  render: defaultContextRender,
});
