import { type LanguageModelV1 } from "ai";
import { z } from "zod";
import type { Container } from "./container";
import type { ServiceProvider } from "./serviceProvider";
import type { BaseMemory } from "./memory";

/**
 * Represents a memory configuration for storing data
 * @template Data - Type of data stored in memory
 */
export type Memory<Data = any> = {
  /** Unique identifier for this memory */
  key: string;
  /** Function to initialize memory data */
  create: () => Promise<Data> | Data;
};

/**
 * Extracts the data type from a Memory type
 * @template TMemory - Memory type to extract data from
 */
export type InferMemoryData<TMemory extends Memory<any>> =
  TMemory extends Memory<infer Data> ? Data : never;

/**
 * Represents an execution chain with experts and metadata
 */
export type Chain = {
  /** Unique identifier for the chain */
  id: string;
  /** Current thinking/reasoning state */
  thinking: string;
  /** Goal or purpose of this chain */
  purpose: string;
  /** List of experts involved in the chain */
  experts: { name: string; data: string }[];
};

/**
 * Interface for storing and retrieving memory data
 */
export interface MemoryStore {
  /**
   * Retrieves data from memory
   * @template T - Type of data to retrieve
   * @param key - Key to lookup
   * @returns Promise resolving to data or null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Stores data in memory
   * @template T - Type of data to store
   * @param key - Key to store under
   * @param value - Data to store
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Removes data from memory
   * @param key - Key to remove
   */
  delete(key: string): Promise<void>;

  /**
   * Removes all data from memory
   */
  clear(): Promise<void>;
}

/**
 * Interface for storing and retrieving vector data
 */
export interface VectorStore {
  /** Optional connection string for the vector store */
  connection?: string;

  /**
   * Adds or updates data in the vector store
   * @param contextId - Unique identifier for the context
   * @param data - Data to add or update
   */
  upsert(contextId: string, data: any): Promise<void>;

  /**
   * Searches the vector store for similar data
   * @param contextId - Context to search within
   * @param query - Query text to search for
   * @returns Array of matching documents
   */
  query(contextId: string, query: string): Promise<any[]>;

  /**
   * Creates a new index in the vector store
   * @param indexName - Name of the index to create
   */
  createIndex(indexName: string): Promise<void>;

  /**
   * Deletes an existing index from the vector store
   * @param indexName - Name of the index to delete
   */
  deleteIndex(indexName: string): Promise<void>;
}

/**
 * Represents the working memory state during execution
 */
export interface WorkingMemory {
  /** List of input references */
  inputs: InputRef[];
  /** List of output references */
  outputs: OutputRef[];
  /** List of thought records */
  thoughts: Thought[];
  /** List of action calls */
  calls: ActionCall[];
  /** List of action results */
  results: ActionResult[];
  // chains: Chain[];
}

/**
 * Represents an action that can be executed with typed parameters
 * @template Schema - Zod schema defining parameter types
 * @template Result - Return type of the action
 * @template Context - Context type for the action execution
 */
export type Action<
  Schema extends z.AnyZodObject = z.AnyZodObject,
  Result = any,
  Context = any,
  TAgent extends AnyAgent = AnyAgent,
  TMemory extends Memory<any> = Memory<any>,
> = {
  name: string;
  description?: string;
  schema: Schema;
  memory?: TMemory;
  install?: (agent: TAgent) => Promise<void> | void;
  enabled?: (ctx: Context & { data: InferMemoryData<TMemory> }) => boolean;
  examples?: z.infer<Schema>[];
  handler: (
    call: ActionCall<z.infer<Schema>>,
    ctx: Context & { data: InferMemoryData<TMemory> },
    agent: TAgent
  ) => Promise<Result>;
  format?: (result: Result) => string | string[];
};

export type OutputSchema = z.AnyZodObject | z.ZodString;

export type OutputRefResponse = Omit<OutputRef, "ref" | "type">;

export type OutputResponse =
  | OutputRefResponse
  | OutputRefResponse[]
  | undefined
  | void;

export type Output<
  Schema extends OutputSchema = OutputSchema,
  Context = any,
  Response extends OutputResponse = OutputResponse,
  TAgent extends AnyAgent = AnyAgent,
> = {
  type: string;
  description?: string;
  instructions?: string;
  schema: Schema;
  install?: (agent: TAgent) => Promise<void>;
  enabled?: (ctx: Context) => boolean;
  handler: (
    params: z.infer<Schema>,
    ctx: Context,
    agent: TAgent
  ) => Promise<Response> | Response;
  format?: (res: Response) => string | string[];
  examples?: z.infer<Schema>[];
};

export type AnyAction = Action<any, any, any>;

/**
 * Represents an input handler with validation and subscription capability
 * @template Schema - Zod schema for input parameters
 * @template Context - Context type for input handling
 */
export type Input<
  Schema extends z.AnyZodObject = z.AnyZodObject,
  Context extends AgentContext<WorkingMemory, AnyContext> = AgentContext<
    WorkingMemory,
    AnyContext
  >,
  TAgent extends AnyAgent = AnyAgent,
> = {
  type: string;
  description?: string;
  schema: Schema;
  format?: (params: z.infer<Schema>) => string | string[];
  install?: (agent: TAgent) => Promise<void>;
  handler?: (
    params: z.infer<Schema>,
    ctx: Context,
    agent: TAgent
  ) => Promise<boolean> | boolean;
  subscribe?: (
    send: <TContext extends AnyContext>(
      contextHandler: TContext,
      args: z.infer<TContext["schema"]>,
      data: z.infer<Schema>
    ) => void,
    agent: TAgent
  ) => (() => void) | void | Promise<void>;
};

/** Reference to an input event in the system */
export type InputRef = {
  ref: "input";
  type: string;
  data: any;
  params?: Record<string, string>;
  timestamp: number;
  processed?: boolean;
  formatted?: string | string[];
};

/** Reference to an output event in the system */
export type OutputRef = {
  ref: "output";
  type: string;
  data: any;
  params?: Record<string, string>;
  timestamp: number;
  formatted?: string | string[];
};

/** Represents a call to an action */
export type ActionCall<Data = any> = {
  ref: "action_call";
  id: string;
  name: string;
  data: Data;
  timestamp: number;
};

/** Represents the result of an action execution */
export type ActionResult<Data = any> = {
  ref: "action_result";
  callId: string;
  name: string;
  data: Data;
  timestamp: number;
  processed?: boolean;
  formatted?: string | string[];
};

/** Represents a thought or reasoning step */
export type Thought = {
  ref: "thought";
  content: string;
  timestamp: number;
};

export type Log = InputRef | OutputRef | Thought | ActionCall | ActionResult;

/** Properties required for Chain-of-Thought execution */
export type COTProps = {
  model: LanguageModelV1;
  plan: string;
  inputs: InputRef[];
  actions: Action[];
  outputs: Output[];
  logs: Log[];
};

/** Response structure from Chain-of-Thought execution */
export type COTResponse = {
  plan: string[];
  actions: ActionCall[];
  outputs: OutputRef[];
  thinking: Thought[];
};

/** Represents an XML element structure */
export type XMLElement = {
  tag: string;
  params?: Record<string, string>;
  content: string | (XMLElement | string)[];
};

/** Utility type to preserve type information */
export type Pretty<type> = { [key in keyof type]: type[key] } & unknown;

/**
 * Extracts variable names from a template string
 * @template T - Template string type
 */
export type ExtractTemplateVariables<T extends string> =
  T extends `${infer Start}{{${infer Var}}}${infer Rest}`
    ? Var | ExtractTemplateVariables<Rest>
    : never;

/**
 * Creates a type mapping template variables to string values
 * @template T - Template string type
 */
export type TemplateVariables<T extends string> = Pretty<{
  [K in ExtractTemplateVariables<T>]: string | string[] | object;
}>;

/** Represents an expert system with instructions and actions */
export type Expert<Context = any> = {
  type: string;
  description: string;
  instructions: string;
  model?: LanguageModelV1;
  actions?: Action<any, any, Context>[];
};

export interface AgentContext<
  Memory extends WorkingMemory = WorkingMemory,
  TContext extends Context<Memory, any, any, any> = Context<
    Memory,
    any,
    any,
    any
  >,
> {
  id: string;
  context: TContext;
  args: z.infer<TContext["schema"]>;
  ctx: InferContextCtx<TContext>;
  memory: Memory;
}

export type AnyAgent = Agent<any, any>;

export interface Agent<
  Memory extends WorkingMemory = WorkingMemory,
  TContext extends Context<Memory, any, any, any> = Context<
    Memory,
    any,
    any,
    any
  >,
> {
  memory: BaseMemory;

  context: TContext;

  debugger: Debugger;

  container: Container;

  model: LanguageModelV1;
  reasoningModel?: LanguageModelV1;

  inputs: Record<string, InputConfig<any, AgentContext<Memory, TContext>>>;
  outputs: Record<
    string,
    Omit<Output<any, AgentContext<Memory, TContext>>, "type">
  >;

  events: Record<string, z.AnyZodObject>;

  experts: Record<string, ExpertConfig<AgentContext<Memory, TContext>>>;

  actions: Action<
    any,
    any,
    AgentContext<Memory, TContext>,
    Agent<Memory, TContext>,
    any
  >[];

  //
  emit: (...args: any[]) => void;
  run: <TContext extends Context<WorkingMemory, any, any, any>>(
    context: TContext,
    args: z.infer<TContext["schema"]>
  ) => Promise<void>;
  send: <TContext extends Context<WorkingMemory, any, any, any>>(
    context: TContext,
    args: z.infer<TContext["schema"]>,
    input: { type: string; data: any }
  ) => Promise<void>;
  evaluator: (ctx: AgentContext<Memory, TContext>) => Promise<void>;

  start(): Promise<this>;
  stop(): Promise<void>;
}

// export type ContextHandler<T extends WorkingMemory = WorkingMemory> = (
//   memory: MemoryStore
// ) => {
//   get: (id: string) => Promise<{ id: string; memory: T }>;
//   save: (id: string, data: T) => Promise<void>;
//   render: (data: T) => string | string[];
// };

// export type InferMemoryFromHandler<THandler extends ContextHandler<any>> =
//   THandler extends ContextHandler<infer Memory> ? Memory : unknown;

// export type InferContextFromHandler<THandler extends ContextHandler<any>> =
//   AgentContext<InferMemoryFromHandler<THandler>>;

export type Debugger = (contextId: string, keys: string[], data: any) => void;

export type Config<
  TMemory extends WorkingMemory = WorkingMemory,
  TContext extends AnyContext = AnyContext,
> = {
  // context: Context;
  memory?: BaseMemory;
  container?: Container;
  context?: TContext;
  debugger?: Debugger;
  services?: ServiceProvider[];
  inputs?: Record<
    string,
    InputConfig<any, AgentContext<TMemory, TContext>, Agent<TMemory, TContext>>
  >;
  outputs?: Record<
    string,
    OutputConfig<
      any,
      AgentContext<TMemory, TContext>,
      any,
      Agent<TMemory, TContext>
    >
  >;

  events?: Record<string, z.AnyZodObject>;

  experts?: Record<string, ExpertConfig<AgentContext<TMemory, TContext>>>;

  actions?: Action<
    any,
    any,
    AgentContext<TMemory, TContext>,
    Agent<TMemory, TContext>,
    any
  >[];

  extensions?: Extension<TMemory, TContext>[];

  model: LanguageModelV1;
  reasoningModel?: LanguageModelV1;
  logger?: LogLevel;
};

/** Configuration type for inputs without type field */
export type InputConfig<
  T extends z.AnyZodObject = z.AnyZodObject,
  Context extends AgentContext<WorkingMemory, AnyContext> = AgentContext<
    WorkingMemory,
    AnyContext
  >,
  TAgent extends AnyAgent = AnyAgent,
> = Omit<Input<T, Context, TAgent>, "type">;

/** Configuration type for outputs without type field */
export type OutputConfig<
  Schema extends OutputSchema = OutputSchema,
  Context extends AgentContext<WorkingMemory, AnyContext> = AgentContext<
    WorkingMemory,
    AnyContext
  >,
  Response extends OutputResponse = OutputResponse,
  TAgent extends AnyAgent = AnyAgent,
> = Omit<Output<Schema, Context, Response, TAgent>, "type">;

/** Configuration type for experts without type field */
export type ExpertConfig<Context = any> = Omit<Expert<Context>, "type">;

/** Function type for subscription cleanup */
export type Subscription = () => void;

/** Enum defining available log levels */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

/** Interface for custom log writers */
export interface LogWriter {
  init(logPath: string): void;
  write(data: string): void;
}

/** Configuration options for logging */
export interface LoggerConfig {
  level: LogLevel;
  enableTimestamp?: boolean;
  enableColors?: boolean;
  logToFile?: boolean;
  logPath?: string;
  logWriter?: LogWriter;
}

/** Structure of a log entry */
export interface LogEntry {
  level: LogLevel;
  timestamp: Date;
  context: string;
  message: string;
  data?: any;
}

/** Results from a research operation */
export interface ResearchResult {
  learnings: string[];
  visitedUrls: string[];
}

/** Configuration for research operations */
export interface ResearchConfig {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
}

export interface IChain {
  /**
   * A unique identifier for the chain (e.g., "starknet", "ethereum", "solana", etc.)
   */
  chainId: string;

  /**
   * Read (call) a contract or perform a query on this chain.
   * The `call` parameter can be chain-specific data.
   */
  read(call: unknown): Promise<any>;

  /**
   * Write (execute a transaction) on this chain, typically requiring signatures, etc.
   */
  write(call: unknown): Promise<any>;
}
/** Type representing instructions that can be either a single string or array of strings */
export type Instruction = string | string[];

/** Type representing any Context with generic type parameters */
export type AnyContext = Context<any, any, any, any>;

/**
 * Extracts the Memory type from a Context type
 * @template TContext - The Context type to extract Memory from
 */
export type InferContextMemory<TContext extends AnyContext> =
  TContext extends Context<infer Memory> ? Memory : never;

/**
 * Extracts the Context type from a Context type
 * @template TContext - The Context type to extract Ctx from
 */
export type InferContextCtx<TContext extends AnyContext> =
  TContext extends Context<any, any, infer Ctx> ? Ctx : never;

/**
 * Configuration for a context that manages state and behavior
 * @template Memory - Type of working memory for this context
 * @template Args - Zod schema type for context arguments
 * @template Ctx - Type of context data
 * @template Exports - Type of exported data
 */
export type Context<
  Memory extends WorkingMemory = WorkingMemory,
  Args extends z.ZodTypeAny = never,
  Ctx = any,
  Exports = any,
> = {
  /** Unique type identifier for this context */
  type: string;
  /** Zod schema for validating context arguments */
  schema: Args;
  /** Optional description of this context */
  description?:
    | string
    | ((params: { key: string; args: z.infer<Args> }, ctx: Ctx) => string);
  /** Function to generate a unique key from context arguments */
  key: (args: z.infer<Args>) => string;

  /** Setup function to initialize context data */
  setup?: (args: z.infer<Args>, agent: AnyAgent) => Promise<Ctx> | Ctx;

  /** Optional instructions for this context */
  instructions?:
    | Instruction
    | ((params: { key: string; args: z.infer<Args> }, ctx: Ctx) => Instruction);

  /** Optional function to create new memory for this context */
  create?: (params: { key: string; args: z.infer<Args> }, ctx: Ctx) => Memory;
  /** Optional function to load existing memory */
  load?: (
    params: { key: string; args: z.infer<Args> },
    ctx: Ctx
  ) => Promise<Memory>;
  /** Optional function to save memory state */
  save?: (
    params: {
      key: string;
      args: z.infer<Args>;
      memory: Memory;
    },
    ctx: Ctx
  ) => Promise<void>;

  /** Optional function to render memory state as string(s) */
  render?: (memory: Memory, ctx: Ctx) => string | string[];
};

/** Enum defining roles for different types of handlers */
export enum HandlerRole {
  /** Handler for processing inputs */
  INPUT = "input",
  /** Handler for processing outputs */
  OUTPUT = "output",
  /** Handler for executing actions */
  ACTION = "action",
}

export type Extension<
  TMemory extends WorkingMemory = WorkingMemory,
  TContext extends AnyContext = AnyContext,
  Contexts extends Record<string, TContext> = Record<string, TContext>,
> = Pick<
  Config<TMemory, TContext>,
  "inputs" | "outputs" | "actions" | "services" | "events"
> & {
  name: string;
  install?: (agent: AnyAgent) => Promise<void> | void;
  contexts?: Contexts;
};
