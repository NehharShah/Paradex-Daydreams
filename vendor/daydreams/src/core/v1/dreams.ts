import {
  LogLevel,
  type Action,
  type ActionCall,
  type Agent,
  type AgentContext,
  type AnyAgent,
  type AnyContext,
  type Config,
  type Debugger,
  type Output,
  type Subscription,
  type WorkingMemory,
} from "./types";
import { Logger } from "./logger";
import { formatContext } from "./formatters";
import { generateText, type LanguageModelV1 } from "ai";
import { randomUUID } from "crypto";
import createContainer from "./container";
import { createServiceManager } from "./serviceProvider";
import {
  type Context,
  type InferContextCtx,
  type InferContextMemory,
} from "./types";
import { z } from "zod";
import { task, type TaskContext } from "./task";
import { parse, prompt } from "./prompts/main";
import {
  defaultContext,
  defaultContextMemory,
  defaultContextRender,
} from "./context";
import { createMemory, createMemoryStore } from "./memory";
import { createVectorStore } from "./memory/base";

export function createDreams<
  Memory extends WorkingMemory = WorkingMemory,
  TContext extends AnyContext = AnyContext,
>(config: Config<Memory, TContext>): Agent<Memory, TContext> {
  const inputSubscriptions = new Map<string, Subscription>();

  const logger = new Logger({
    level: config.logger ?? LogLevel.INFO,
    enableTimestamp: true,
    enableColors: true,
  });

  const contexts = new Map<string, { ctx: any }>();

  const {
    inputs = {},
    outputs = {},
    events = {},
    actions = [],
    experts = {},
    services = [],
    extensions = [],
    memory,
    model,
    reasoningModel,
  } = config;

  const container = config.container ?? createContainer();

  const contextsRunning = new Set<string>();

  const debug: Debugger = (...args) => {
    if (!config.debugger) return;
    try {
      config.debugger(...args);
    } catch {}
  };

  let booted = false;

  const serviceManager = createServiceManager(container);

  for (const extension of extensions) {
    if (extension.inputs) Object.assign(inputs, extension.inputs);
    if (extension.outputs) Object.assign(outputs, extension.outputs);
    if (extension.events) Object.assign(events, extension.events);
    if (extension.actions) actions.push(...extension.actions);
    if (extension.services) services.push(...extension.services);
  }

  for (const service of services) {
    serviceManager.register(service);
  }

  async function getContext<
    TContext extends Context<WorkingMemory, any, any, any>,
  >(contextHandler: TContext, args: z.infer<TContext["schema"]>) {
    const key = contextHandler.key(args);
    const contextId = [contextHandler.type, key].join(":");

    const ctx = contexts.has(contextId)
      ? contexts.get(contextId)
      : contextHandler.setup
        ? await contextHandler.setup(args, agent)
        : {};

    const memory =
      (await agent.memory.store.get(contextId)) ??
      (contextHandler.create
        ? contextHandler.create({ key, args }, ctx)
        : defaultContextMemory.create());

    return {
      id: contextId,
      key,
      ctx,
      memory: memory as InferContextMemory<TContext>,
    };
  }

  const agent: Agent<Memory, TContext> = {
    inputs,
    outputs,
    events,
    actions,
    experts,
    memory: memory ?? createMemory(createMemoryStore(), createVectorStore()),
    container,
    model,
    reasoningModel,
    debugger: debug,
    context: config.context ?? (defaultContext as TContext),
    emit: (event: string, data: any) => {
      logger.info("agent:event", event, data);
    },

    async start() {
      if (booted) return agent;

      booted = true;

      await serviceManager.bootAll();

      for (const extension of extensions) {
        if (extension.install) await extension.install(agent);
      }

      for (const [key, input] of Object.entries(agent.inputs)) {
        if (input.install) await Promise.resolve(input.install(agent));

        if (input.subscribe) {
          const subscription = await Promise.resolve(
            input.subscribe((contextHandler, args, data) => {
              logger.info("agent", "input", { contextHandler, args, data });
              agent
                .send(contextHandler, args, { type: key, data })
                .catch((err) => {
                  console.error(err);
                  // logger.error("agent", "input", err);
                });
            }, agent)
          );

          if (subscription) inputSubscriptions.set(key, subscription);
        }
      }

      for (const output of Object.values(outputs)) {
        if (output.install) await Promise.resolve(output.install(agent));
      }

      for (const action of actions) {
        if (action.install) await Promise.resolve(action.install(agent));
      }

      return agent;
    },

    async stop() {},

    run: async (contextHandler, args) => {
      if (!booted) await agent.start();

      const {
        key,
        id: contextId,
        ctx,
        memory,
      } = await getContext(contextHandler, args);

      if (contextsRunning.has(contextId)) return;
      contextsRunning.add(contextId);

      const contextOuputs = Object.entries(agent.outputs)
        .filter(([_, output]) => (output.enabled ? output.enabled(ctx) : true))
        .map(([type, output]) => ({
          type,
          ...output,
        }));

      const maxSteps = 5;
      let step = 1;

      const contextActions = await Promise.all(
        actions.map(async (action) => {
          let actionMemory: unknown = {};

          if (action.memory) {
            actionMemory =
              (await agent.memory.store.get(action.memory.key)) ??
              action.memory.create();
          }

          const enabled = action.enabled
            ? action.enabled({
                ...ctx,
                data: actionMemory,
              })
            : true;

          return enabled ? action : undefined;
        })
      ).then((r) => r.filter((a) => !!a));

      while (maxSteps > step) {
        const data = await runGenerate({
          model: config.reasoningModel ?? config.model,
          context: contextHandler,
          actions: contextActions,
          outputs: contextOuputs,
          contextId,
          memory,
          logger,
          args,
          ctx,
          key,
        });

        logger.debug("agent:parsed", "data", data);

        memory.inputs.forEach((i) => {
          i.processed = true;
        });

        memory.results.forEach((i) => {
          i.processed = true;
        });

        for (const content of data.think) {
          logger.debug("agent:think", content);
        }

        for (const content of data.reasonings) {
          logger.debug("agent:reasoning", content);
        }

        for (const { type, content } of data.outputs) {
          const output = outputs[type];

          logger.info("agent:output", type, content);
          try {
            let parsedContent = content;
            if (typeof content === "string") {
              try {
                parsedContent = JSON.parse(content);
              } catch {
                parsedContent = content;
              }
            }

            const data = output.schema.parse(parsedContent);

            const response = await output.handler(data, ctx, agent);

            if (Array.isArray(response)) {
              for (const res of response) {
                memory.outputs.push({
                  ref: "output",
                  type,
                  formatted:
                    res.formatted ??
                    (output.format ? output.format(response) : undefined),
                  ...res,
                });
              }
            } else if (response) {
              memory.outputs.push({
                ref: "output",
                type,
                formatted:
                  response.formatted ??
                  (output.format ? output.format(response) : undefined),
                ...response,
              });
            }
          } catch (error) {
            logger.error("agent:output", type, error);
          }
        }

        await Promise.allSettled(
          data.actions.map(async ({ name, data }) => {
            const action = actions.find((a) => a.name === name);

            if (!action) {
              logger.error("agent:action", "ACTION_MISMATCH", {
                name,
                data,
              });
              return Promise.reject(new Error("ACTION MISMATCH"));
            }

            try {
              const call: ActionCall = {
                ref: "action_call",
                id: randomUUID(),
                data: action.schema.parse(data),
                name: name,
                timestamp: Date.now(),
              };

              memory.calls.push(call);

              let actionMemory: unknown = {};

              if (action.memory) {
                actionMemory =
                  (await agent.memory.store.get(action.memory.key)) ??
                  action.memory.create();
              }

              const result = await runAction({
                action,
                call,
                agent,
                logger,
                context: {
                  id: contextId,
                  context: contextHandler,
                  ctx,
                  args,
                  memory,
                  data: actionMemory,
                },
              });

              memory.results.push({
                ref: "action_result",
                callId: call.id,
                data: result,
                name: call.name,
                timestamp: Date.now(),
                processed: false,
                formatted: action.format ? action.format(result) : undefined,
              });
            } catch (error) {
              logger.error("agent:action", "ACTION_FAILED", { error });
              throw error;
            }
          })
        );

        await agent.memory.store.set(contextId, memory);
        await agent.memory.vector.upsert(contextId, [memory]);

        if (
          [...memory.results, ...memory.inputs].find(
            (i) => i.processed === false
          ) === undefined
        )
          break;

        step++;
      }

      await agent.memory.store.set(contextId, memory);
      await agent.memory.vector.upsert(contextId, [memory]);
      contextsRunning.delete(contextId);
    },

    send: async (contextHandler, args, params: { type: string; data: any }) => {
      if (params.type in agent.inputs === false) return;

      const {
        key,
        id: contextId,
        ctx,
        memory,
      } = await getContext(contextHandler, contextHandler.schema.parse(args));

      const input = agent.inputs[params.type];

      const data = input.schema.parse(params.data);

      if (input.handler) {
        await input.handler(
          data,
          {
            type: contextHandler.type,
            key,
            memory,
            ctx,
          } as any,
          agent
        );
      } else {
        memory.inputs.push({
          ref: "input",
          type: params.type,
          data,
          timestamp: Date.now(),
          formatted: input.format ? input.format(data) : undefined,
        });
      }

      await agent.evaluator({
        type: contextHandler.type,
        key,
        memory,
        ctx,
      } as any);

      await agent.memory.store.set(contextId, memory);
      await agent.memory.vector.upsert(contextId, [memory]);
      await agent.run(contextHandler, args);
    },

    evaluator: async (ctx) => {
      const { id, memory } = ctx;
      logger.debug("agent:evaluator", "memory", memory);
    },
  };

  return agent;
}

export const runGenerate = task(
  "agent:run:generate",
  async <TContext extends Context<WorkingMemory, any, any, any>>(
    {
      context,
      contextId,
      key,
      args,
      memory,
      outputs,
      actions,
      ctx,
      logger,
      model,
    }: {
      context: TContext;
      args: z.infer<TContext["schema"]>;
      contextId: string;
      key: string;
      memory: WorkingMemory;
      outputs: Output[];
      actions: Action[];
      ctx: InferContextCtx<TContext>;
      logger: Logger;
      model: LanguageModelV1;
    },
    { callId, debug }: TaskContext
  ) => {
    const newInputs = memory.inputs.filter((i) => i.processed !== true);

    debug(contextId, ["memory", callId], JSON.stringify(memory, null, 2));

    const system = prompt({
      context: formatContext({
        type: context.type ?? "system",
        key: key,
        description:
          typeof context.description === "function"
            ? context.description({ key, args }, ctx)
            : context.description,
        instructions:
          typeof context.instructions === "function"
            ? context.instructions({ key, args }, ctx)
            : context.instructions,
        content: context.render
          ? context.render(memory, ctx)
          : defaultContextRender(memory),
      }),

      outputs: outputs,
      actions: actions.filter((action) =>
        action.enabled ? action.enabled(ctx as any) : true
      ),
      updates: [
        ...newInputs,
        ...memory.results.filter((i) => i.processed !== true),
      ],
    });

    debug(contextId, ["prompt", callId], system);

    logger.debug("agent:system", system);

    const result = await generateText({
      model,
      system,
      messages: [
        {
          role: "assistant",
          content: "<think>",
        },
      ],
      stopSequences: ["</response>"],
    });

    const text = "<think>" + result.text + "</response>";

    debug(contextId, ["response", callId], text);

    logger.debug("agent:response", text);

    return parse(text);
  }
);

export const runAction = task(
  "agent:run:action",
  async <TContext extends AnyContext>({
    context,
    action,
    call,
    agent,
    logger,
  }: {
    context: AgentContext<InferContextMemory<TContext>, TContext> & {
      data: unknown;
    };
    action: Action;
    call: ActionCall;
    agent: AnyAgent;
    logger: Logger;
  }) => {
    try {
      const result = await action.handler(call, context, agent);
      return result;
    } catch (error) {
      logger.error("agent:action", "ACTION_FAILED", { error });
      throw error;
    }
  }
);
