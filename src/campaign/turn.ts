import type { LLMClient, ChatMessage, ToolCall, ToolDefinition } from "../llm/providers";
import type { CampaignSession } from "./session";
import type { CampaignToolRegistry } from "./tools";
import { CAMPAIGN_BUILDER_SYSTEM_PROMPT } from "./prompt";
import type { HistoryEntry } from "./types";

export const MAX_TOOL_CALLS_PER_TURN = 10;
const CONVERSATION_TAIL = 40;

const WIRE_SEPARATOR = "__";

function toWireName(name: string): string {
  return name.replace(/\./g, WIRE_SEPARATOR);
}

function fromWireName(name: string): string {
  return name.replace(new RegExp(WIRE_SEPARATOR, "g"), ".");
}

function sanitizeToolDefinitions(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((d) => ({ ...d, name: toWireName(d.name) }));
}

export interface RunTurnOpts {
  session: CampaignSession;
  registry: CampaignToolRegistry;
  llm: LLMClient;
  userText: string;
  maxToolCalls?: number;
  systemPrompt?: string;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onAssistant?: (text: string) => void;
}

export interface RunTurnResult {
  assistantText: string;
  toolCallCount: number;
  stoppedReason: "end_turn" | "max_tool_calls" | "tool_use" | "max_tokens";
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildMessages(session: CampaignSession): ChatMessage[] {
  const history = session.getState().history;
  const tail = history.slice(-CONVERSATION_TAIL);
  const messages: ChatMessage[] = [];

  for (let i = 0; i < tail.length; i++) {
    const entry = tail[i]!;
    if (entry.kind === "user") {
      messages.push({ role: "user", content: entry.text });
    } else if (entry.kind === "assistant") {
      const adjacent = collectAdjacentToolCalls(tail, i);
      if (adjacent.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: entry.text,
          toolCalls: adjacent.toolCalls,
        });
        for (const tr of adjacent.toolResults) {
          messages.push({ role: "tool", content: tr.content, toolCallId: tr.toolCallId });
        }
        i = adjacent.skipTo;
      } else {
        messages.push({ role: "assistant", content: entry.text });
      }
    }
  }
  return messages;
}

interface AdjacentToolBundle {
  toolCalls: ToolCall[];
  toolResults: { content: string; toolCallId: string }[];
  skipTo: number;
}

function collectAdjacentToolCalls(history: HistoryEntry[], assistantIdx: number): AdjacentToolBundle {
  const calls: ToolCall[] = [];
  const results: { content: string; toolCallId: string }[] = [];
  let cursor = assistantIdx + 1;
  while (cursor < history.length) {
    const next = history[cursor]!;
    if (next.kind === "tool_call") {
      const id = `call_${calls.length}_${cursor}`;
      calls.push({ id, name: toWireName(next.tool), arguments: (next.args as Record<string, any>) ?? {} });
      cursor += 1;
      const peek = history[cursor];
      if (peek && peek.kind === "tool_result" && peek.tool === next.tool) {
        results.push({ content: JSON.stringify(peek.result ?? {}), toolCallId: id });
        cursor += 1;
      } else {
        results.push({ content: JSON.stringify({ error: "no result recorded" }), toolCallId: id });
      }
      continue;
    }
    break;
  }
  return { toolCalls: calls, toolResults: results, skipTo: cursor - 1 };
}

export async function runOneTurn(opts: RunTurnOpts): Promise<RunTurnResult> {
  const {
    session,
    registry,
    llm,
    userText,
    maxToolCalls = MAX_TOOL_CALLS_PER_TURN,
    systemPrompt = CAMPAIGN_BUILDER_SYSTEM_PROMPT,
    onToolCall,
    onToolResult,
    onAssistant,
  } = opts;

  session.appendHistory({ kind: "user", text: userText, ts: nowIso() });

  let messages = buildMessages(session);
  let toolCallCount = 0;
  let assistantText = "";
  let stoppedReason: RunTurnResult["stoppedReason"] = "end_turn";

  const wireTools = sanitizeToolDefinitions(registry.toolDefinitions);

  while (true) {
    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: wireTools,
      toolChoice: "auto",
    });

    const calls = result.toolCalls ?? [];

    if (result.text) {
      session.appendHistory({ kind: "assistant", text: result.text, ts: nowIso() });
      assistantText = result.text;
      onAssistant?.(result.text);
    } else if (calls.length === 0) {
      session.appendHistory({ kind: "assistant", text: "", ts: nowIso() });
    }

    if (calls.length === 0) {
      stoppedReason = result.stopReason ?? "end_turn";
      break;
    }

    const newAssistantMessage: ChatMessage = {
      role: "assistant",
      content: result.text ?? "",
      toolCalls: calls,
    };
    messages = [...messages, newAssistantMessage];

    for (const call of calls) {
      if (toolCallCount >= maxToolCalls) {
        stoppedReason = "max_tool_calls";
        break;
      }
      toolCallCount += 1;
      const dispatchName = fromWireName(call.name);
      const observedCall: ToolCall = { ...call, name: dispatchName };
      onToolCall?.(observedCall);
      session.appendHistory({ kind: "tool_call", tool: dispatchName, args: call.arguments, ts: nowIso() });

      let toolResult: unknown;
      try {
        toolResult = await registry.execute(dispatchName, call.arguments);
      } catch (e) {
        toolResult = { error: e instanceof Error ? e.message : String(e) };
      }

      onToolResult?.(dispatchName, toolResult);
      session.appendHistory({ kind: "tool_result", tool: dispatchName, result: toolResult, ts: nowIso() });
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult ?? {}),
        toolCallId: call.id,
      });
    }

    if (stoppedReason === "max_tool_calls") break;
  }

  session.flush();
  return { assistantText, toolCallCount, stoppedReason };
}
