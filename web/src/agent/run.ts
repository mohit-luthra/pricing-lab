/** The tool-calling loop. `callModel` is injected so the loop can be tested without a network. */
import type { CategoryModel } from "@/engine/types";
import { describeCategory, runTool, type ToolCall } from "./tools";
import { verifyNumbers, type Verification } from "./verify";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type ModelReply = { content: string | null; toolCalls: ToolCall[] };
export type CallModel = (messages: ChatMessage[]) => Promise<ModelReply>;

export interface Step { name: string; args: string; result: Record<string, unknown> }
export interface AgentAnswer { text: string; steps: Step[]; verification: Verification; rounds: number; refused: boolean }

export const MAX_ROUNDS = 4;

/** Shown instead of whatever the model wrote whenever it answered without running a tool. */
export const OFF_TOPIC = "I can only answer pricing and promotion questions for this category.";

export async function ask(model: CategoryModel, question: string, callModel: CallModel,
                          history: ChatMessage[] = [], onStep?: (steps: Step[]) => void): Promise<AgentAnswer> {
  const context = describeCategory(model);
  const messages: ChatMessage[] = [
    { role: "system", content: context }, ...history, { role: "user", content: question },
  ];
  const steps: Step[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await callModel(messages);
    if (!reply.toolCalls.length) {
      // An answer is only shown if at least one tool actually ran. This is what stops the
      // assistant being used as a general chatbot: off-topic text is thrown away, not displayed.
      if (!steps.some((s) => !("error" in s.result))) {
        return { text: OFF_TOPIC, steps, rounds: round, refused: true, verification: { checked: 0, unsupported: [] } };
      }
      const text = (reply.content ?? "").trim() || "No answer was produced.";
      return { text, steps, rounds: round, refused: false, verification: verifyNumbers(text, [...steps.map((s) => s.result), context, question]) };
    }
    messages.push({
      role: "assistant", content: reply.content,
      tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    });
    for (const call of reply.toolCalls) {
      const result = runTool(model, call.name, call.arguments);
      steps.push({ name: call.name, args: call.arguments, result });
      onStep?.([...steps]);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return {
    text: "Stopped: the assistant kept calling tools without reaching an answer.",
    steps, rounds: MAX_ROUNDS, refused: false, verification: { checked: 0, unsupported: [] },
  };
}
