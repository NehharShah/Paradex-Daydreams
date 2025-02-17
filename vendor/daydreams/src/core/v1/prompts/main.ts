import {
  formatAction,
  formatContextLog,
  formatOutputInterface,
} from "../formatters";
import { createParser, createPrompt } from "../prompt";
import type { AnyAction, Log, Output } from "../types";

const promptTemplate = `
You are tasked with analyzing messages, formulating responses, and initiating actions based on a given context.
You will be provided with a set of available actions, outputs, and a current context.
Your instructions is to analyze the situation and respond appropriately.

## Instructions
- If asked for something - never do a summary unless you are asked to do a summary. Always respond with the exact information requested.
- You must use the available actions and outputs to respond to the context.
- You must reason about the context, think, and planned actions.

Here are the available actions you can initiate:
<available_actions>
{{actions}}
</available_actions>

Here are the available outputs you can use:
<outputs>
{{outputs}}
</outputs>

Here is the current context:
<context>
{{context}}
</context>

Now, analyze the following new context:
<context>
{{updates}}
</context>

Here's how you structure your response:
<response>
<reasoning>
[Your reasoning of the context, think, messages, and planned actions]
</reasoning>
[List of async actions to be initiated, if applicable]
<action name="[Action name]">[action arguments using the schema as JSON]</action>
[List of outputs, if applicable]
<output type="[Output type]">
[output data using the schema]
</output>
</response>

{{examples}}
`;

export const prompt = createPrompt(
  promptTemplate,
  ({
    outputs,
    actions,
    updates,
    context,
  }: {
    context: string | string[];
    outputs: Output[];
    updates: Log[];
    actions: AnyAction[];
  }) => ({
    context: context,
    outputs: outputs.map(formatOutputInterface),
    actions: actions.map(formatAction),
    updates: updates.map(formatContextLog),
    examples: [],
  }),
);

export const parse = createParser<
  {
    think: string[];
    response: string | undefined;
    reasonings: string[];
    actions: { name: string; data: any }[];
    outputs: { type: string; content: string }[];
  },
  {
    action: { name: string };
    output: { type: string };
  }
>(
  () => ({
    think: [],
    reasonings: [],
    actions: [],
    outputs: [],
    response: undefined,
  }),
  {
    response: (state, element, parse) => {
      state.response = element.content;
      return parse();
    },

    action: (state, element) => {
      console.log("=== STATE ===\n", state);
      console.log("=== ELEMENT ===\n", element);
      state.actions.push({
        name: element.attributes.name,
        data: JSON.parse(element.content),
      });
    },

    think: (state, element) => {
      state.think.push(element.content);
    },

    reasoning: (state, element) => {
      state.reasonings.push(element.content);
    },

    output: (state, element) => {
      state.outputs.push({
        type: element.attributes.type,
        content: element.content,
      });
    },
  },
);
