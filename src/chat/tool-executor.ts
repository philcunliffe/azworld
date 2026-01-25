import { LLMClient, ChatMessage, CompleteResult, ToolCall } from "../llm/providers";
import { ToolRegistry, ToolContext } from "./tools";
import { ChatState } from "./director";
import { CampaignSettings } from "./schema";
import { formatSettingsForPrompt } from "./campaign-settings";
import { SkillMetadata, formatSkillsForPrompt } from "./skills";

export type ToolLoopOptions = {
  llm: LLMClient;
  registry: ToolRegistry;
  ctx: ToolContext;
  systemPrompt: string;
  userMessage: string;
  maxIterations?: number;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onLLMComplete?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined) => void;
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
    onLLMComplete,
  } = opts;

  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const toolCallsExecuted: Array<{ name: string; args: any; result: any }> = [];

  let finalText = "";
  let narration: string | undefined;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`[director] Iteration ${iterations}/${maxIterations}, messages: ${messages.length}`);

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: registry.getDefinitions(),
      toolChoice: "auto",
      maxTokens: 2000,
      temperature: 0.7,
    });

    // Report token usage
    if (onLLMComplete && result.usage) {
      onLLMComplete(result.usage);
    }

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

      const startTime = Date.now();
      let toolResult: any;
      try {
        toolResult = await registry.execute(tc.name, tc.arguments, ctx);
      } catch (e: any) {
        toolResult = { error: e?.message || String(e) };
      }
      const elapsedMs = Date.now() - startTime;

      if (onToolResult) onToolResult(tc.name, toolResult, elapsedMs);

      toolCallsExecuted.push({
        name: tc.name,
        args: tc.arguments,
        result: toolResult,
      });

      // Check for narration in session_narrate results
      if (tc.name === "session_narrate" && toolResult?.narration) {
        narration = toolResult.narration;
      }

      // Add tool result message
      const resultContent = JSON.stringify(toolResult);
      console.log(`[director] Tool ${tc.name} result: ${resultContent.length} chars`);
      messages.push({
        role: "tool",
        content: resultContent,
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
const DIRECTOR_SYSTEM_PROMPT_BASE = `You are a tabletop RPG Director/GM assistant managing a fantasy world.

Your job is to orchestrate scenes and content by using tools. Follow this process:

1. GROUND the request:
   - Use world_lookupBurg or world_lookupState to resolve any mentioned places
   - Use session_getContext to understand the current scene state

2. QUERY existing content:
   - Use canon_query to find existing locations, NPCs, factions that match the user's request
   - Use canon_getActiveEvents to find events affecting the area

3. GENERATE only what's missing:
   - If no suitable location exists, use generate_location (auto-saves to canon)
   - If more NPCs are needed, use generate_npcs (auto-saves to canon)
   - If a faction is needed, use generate_faction (auto-saves to canon)
   - Pass activeEvents JSON string so generated content reflects world state

4. SET the scene:
   - Use session_setLocation to establish where the action is
   - Use session_narrate to deliver the final narrative to the user

NOTE ON TOOL RESULTS:
- Generation tools auto-persist to canon and return only IDs and summaries
- Query tools return truncated results; use canon_get for full details if needed
- Do NOT re-persist entities that generation tools already saved

CONTEXT-AWARE GENERATION RULES:
- ALWAYS call canon_getActiveEvents BEFORE any generate_* tool
- Pass the events array as JSON string in the activeEvents parameter
- Generated content MUST naturally reflect active events:
  * Earthquake → damaged buildings, refugees, rubble, fear
  * Monarch's death → mourning banners, hushed voices, political talk
  * Festival → celebration, crowds, decorations, vendors
  * Plague → empty streets, sick people, closed businesses

IMPORTANT CONSTRAINTS:
- Check canon_query before generating to avoid duplicates
- The final output should use session_narrate with engaging narrative text
- Use open vocabulary for entity kinds (not limited to predefined types)

When the user mentions entering a place (tavern, guild hall, temple, etc.):
1. Look up the burg by name
2. Check for active events in the area
3. Check for existing locations of that type
4. Generate or select a location (passing active events if generating)
5. Set the location and narrate the scene

Be creative but consistent with existing canon.`;

/**
 * Build the director system prompt with optional campaign settings and skills.
 */
export function buildDirectorSystemPrompt(settings?: CampaignSettings, skills?: SkillMetadata[]): string {
  let prompt = DIRECTOR_SYSTEM_PROMPT_BASE;

  const campaignContext = formatSettingsForPrompt(settings);
  if (campaignContext) {
    prompt += `\n\n${campaignContext}\n\nApply these campaign settings to all narration and generated content.`;
  }

  if (skills && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  return prompt;
}

// Legacy export for backward compatibility
export const DIRECTOR_SYSTEM_PROMPT = DIRECTOR_SYSTEM_PROMPT_BASE;
