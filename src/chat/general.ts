import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { LLMClient } from "../llm/providers";
import { createGeneralChatRegistry, ToolContext } from "./tools";
import { runToolLoop } from "./tool-executor";
import { ChatState, GeneralChatMessage, ChatBlock } from "./director";
import { CampaignSettings } from "./schema";
import { formatSettingsForPrompt } from "./campaign-settings";

const GENERAL_CHAT_SYSTEM_PROMPT = `You are a world-building assistant for a fantasy world. You help the user explore, discuss, and expand their world's lore, entities, and canon.

WORLD MODEL:
- "States" are countries, kingdoms, empires, republics -- large political entities
- "Burgs" are cities, towns, villages -- settlements within states
- "Canon" entities (NPCs, factions, locations, events, etc.) are user/AI-created content stored in the canon database

Your capabilities:
1. ANSWER QUESTIONS about the world using query tools to ground your responses in existing canon and world data
2. DISCUSS lore, history, factions, NPCs, locations, events, and relationships
3. PROPOSE GENERATION PLANS when the user wants to create new content

LOOKUP WORKFLOW:
- Use the "search" tool as your PRIMARY lookup. It searches across ALL entity types at once (states, burgs, cultures, religions, NPCs, factions, locations, events, etc.) and returns details + relations for top results in a single call.
- Only fall back to world_lookupBurg, world_lookupState, or canon_query if you need very specific filtered queries.
- Use canon_getActiveEvents to understand current world state
- Give informative, conversational responses grounded in the actual world data

CREATING NEW CONTENT:
- When the user wants to create new entities (NPCs, locations, factions, events, markers, etc.), use propose_plan to present a structured plan
- Do NOT directly call generate_* tools unless the user explicitly says to skip review (e.g., "just create it", "go ahead and generate")
- The propose_plan tool creates an interactive card the user can approve or reject
- Always check canon_query first to avoid proposing duplicates
- For wilderness locations (ruins, towers, dungeons, shrines, monster lairs, etc.), use type "marker" -- these are placed on the map between burgs, not inside them

RESPONSE FORMAT:
- Write conversational, well-formatted responses using markdown
- Use headings (##, ###) to organize sections about different topics
- Use **bold** for entity names and key terms
- Use bullet lists for attributes, relationships, and details
- NEVER dump raw JSON or tool output to the user -- always synthesize into readable prose
- Keep responses focused and scannable -- use short paragraphs
- When describing an entity, lead with a brief overview, then break details into clear sections

IMPORTANT:
- You have no scene/location concept -- you work across the entire world
- Be conversational and helpful, not just a tool executor
- Provide context and analysis, not just raw data`;

export type GeneralChatOptions = {
  llm: LLMClient;
  generationLlm?: LLMClient;
  world: AzgaarWorld;
  canon: CanonStore;
  state: ChatState;
  userText: string;
  campaignSettings?: CampaignSettings;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onLLMComplete?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined) => void;
};

export async function generalChat(opts: GeneralChatOptions): Promise<{
  reply: string;
  blocks: ChatBlock[];
  history: GeneralChatMessage[];
}> {
  opts.canon.initDb();

  const registry = createGeneralChatRegistry();
  const ctx: ToolContext = {
    world: opts.world,
    canon: opts.canon,
    llm: opts.llm,
    generationLlm: opts.generationLlm,
    state: opts.state,
    campaignSettings: opts.campaignSettings,
  };

  // Add user message to history
  opts.state.generalHistory.push({ role: "user", content: opts.userText });

  // Build system prompt
  let systemPrompt = GENERAL_CHAT_SYSTEM_PROMPT;
  const campaignContext = formatSettingsForPrompt(opts.campaignSettings);
  if (campaignContext) {
    systemPrompt += `\n\n${campaignContext}\n\nApply these campaign settings to generated content.`;
  }

  // Run the tool loop
  const result = await runToolLoop({
    llm: opts.llm,
    registry,
    ctx,
    systemPrompt,
    userMessage: opts.userText,
    maxIterations: 15,
    onToolCall: opts.onToolCall,
    onToolResult: opts.onToolResult,
    onLLMComplete: opts.onLLMComplete,
  });

  const reply = result.finalText || "I processed your request.";

  // Build blocks from tool calls and proposed plans
  const blocks: ChatBlock[] = [];

  // Add tool call blocks (excluding propose_plan -- those become plan blocks)
  for (const tc of result.toolCallsExecuted) {
    if (tc.name === "propose_plan") continue;
    blocks.push({ type: "tool_call", name: tc.name, status: "done" });
  }

  // Add text block
  if (reply) {
    blocks.push({ type: "text", text: reply });
  }

  // Extract proposed plans from context
  const proposedPlans = (ctx.state as any)._proposedPlans as Array<{
    planId: string;
    summary: string;
    entities: any[];
    burgId?: number;
    burgName?: string;
  }> | undefined;

  if (proposedPlans) {
    for (const plan of proposedPlans) {
      blocks.push({
        type: "plan",
        planId: plan.planId,
        entities: plan.entities,
        summary: plan.summary,
        status: "pending",
      });
    }
    // Clean up temporary storage
    delete (ctx.state as any)._proposedPlans;
  }

  // Add assistant message with blocks to history
  const assistantMsg: GeneralChatMessage = { role: "assistant", content: reply, blocks };
  opts.state.generalHistory.push(assistantMsg);

  return { reply, blocks, history: opts.state.generalHistory };
}
