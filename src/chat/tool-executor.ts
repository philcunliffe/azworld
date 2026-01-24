import { LLMClient, ChatMessage, CompleteResult, ToolCall } from "../llm/providers";
import { ToolRegistry, ToolContext } from "./tools";
import { ChatState } from "./director";

export type ToolLoopOptions = {
  llm: LLMClient;
  registry: ToolRegistry;
  ctx: ToolContext;
  systemPrompt: string;
  userMessage: string;
  maxIterations?: number;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any) => void;
};

export type ToolLoopResult = {
  finalText: string;
  narration?: string;
  state: ChatState;
  toolCallsExecuted: Array<{ name: string; args: any; result: any }>;
  iterations: number;
};

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    llm,
    registry,
    ctx,
    systemPrompt,
    userMessage,
    maxIterations = 10,
    onToolCall,
    onToolResult,
  } = opts;

  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const toolCallsExecuted: Array<{ name: string; args: any; result: any }> = [];

  let finalText = "";
  let narration: string | undefined;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: registry.getDefinitions(),
      toolChoice: "auto",
      maxTokens: 2000,
      temperature: 0.7,
    });

    // Accumulate any text output
    if (result.text) {
      finalText += (finalText ? "\n" : "") + result.text;
    }

    // If no tool calls, we're done
    if (!result.toolCalls?.length || result.stopReason !== "tool_use") {
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: result.text || "",
      toolCalls: result.toolCalls,
    });

    // Execute each tool call
    for (const tc of result.toolCalls) {
      if (onToolCall) onToolCall(tc.name, tc.arguments);

      let toolResult: any;
      try {
        toolResult = await registry.execute(tc.name, tc.arguments, ctx);
      } catch (e: any) {
        toolResult = { error: e?.message || String(e) };
      }

      if (onToolResult) onToolResult(tc.name, toolResult);

      toolCallsExecuted.push({
        name: tc.name,
        args: tc.arguments,
        result: toolResult,
      });

      // Check for narration in session.narrate results
      if (tc.name === "session.narrate" && toolResult?.narration) {
        narration = toolResult.narration;
      }

      // Add tool result message
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        toolCallId: tc.id,
      });
    }
  }

  return {
    finalText,
    narration,
    state: ctx.state,
    toolCallsExecuted,
    iterations,
  };
}

// Director system prompt for tool-use mode
export const DIRECTOR_SYSTEM_PROMPT = `You are a tabletop RPG Director/GM assistant managing a fantasy world.

Your job is to orchestrate scenes and content by using tools. Follow this process:

1. GROUND the request:
   - Use world.lookupBurg or world.lookupState to resolve any mentioned places
   - Use session.getContext to understand the current scene state

2. QUERY existing content:
   - Use canon.query to find existing locations, NPCs, factions that match the user's request
   - Use canon.getActiveEvents to find events affecting the area (ALWAYS do this before generation!)

3. GENERATE only what's missing:
   - If no suitable location exists, use generate.location
   - If more NPCs are needed, use generate.npcs
   - If a faction is needed, use generate.faction
   - CRITICAL: Pass the activeEvents JSON string to generation tools so content reflects world state!
   - Example: generate.location({ kind: "tavern", burgId: 42, activeEvents: "[{...events from getActiveEvents...}]" })

4. PERSIST generated content:
   - Use canon.upsert to save each generated entity
   - Use canon.link to create relationships (NPC works_at location, etc.)

5. SET the scene:
   - Use session.setLocation to establish where the action is
   - Use session.narrate to deliver the final narrative to the user

CONTEXT-AWARE GENERATION RULES:
- ALWAYS call canon.getActiveEvents BEFORE any generate.* tool
- Pass the events array as JSON string in the activeEvents parameter
- Generated content MUST naturally reflect active events:
  * An earthquake (catastrophic, 3 days ago) → damaged buildings, refugees, rubble, fear
  * A monarch's death (major, 12 days ago) → mourning banners, hushed voices, political talk
  * An ongoing festival → celebration, crowds, decorations, vendors
  * A plague (severe) → empty streets, sick people, closed businesses
- The narration should also mention relevant events organically

IMPORTANT CONSTRAINTS:
- ALWAYS query canon.getActiveEvents before generating content
- ALWAYS check canon.query before generating to avoid duplicates
- Generated entities must be persisted with canon.upsert before session.narrate
- Relations must be created with canon.link
- The final output should use session.narrate with engaging narrative text
- Use open vocabulary for entity kinds (not limited to predefined types)

When the user mentions entering a place (tavern, guild hall, temple, etc.):
1. Look up the burg by name
2. Check for active events in the area
3. Check for existing locations of that type
4. Generate or select a location (passing active events!)
5. Persist and link any new content
6. Set the location and narrate the scene

Be creative but consistent with existing canon. Reflect world events naturally in all descriptions.`;
