import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity } from "../canon/canon";
import { LLMClient } from "../llm/providers";
import { createDirectorRegistry, ToolContext } from "./tools";
import { runToolLoop, buildDirectorSystemPrompt } from "./tool-executor";
import { CampaignSettings } from "./schema";

export type SceneContext = {
  burgId: number;
  burg: any;
  state?: any;
  location?: CanonEntity;
  npcs: CanonEntity[];
  factions: CanonEntity[];
};

export type ChatState = {
  currentBurgId?: number;
  currentLocationId?: string;
  currentNpcId?: string;
  directorHistory: { role: "user" | "assistant"; content: string }[];
  npcHistories: Record<string, { role: "user" | "assistant"; content: string }[]>;
};

export function newChatState(): ChatState {
  return { directorHistory: [], npcHistories: {} };
}

/**
 * Tool-based director using LLM tool calls to orchestrate scenes.
 */
export async function directScene(opts: {
  llm: LLMClient;
  generationLlm?: LLMClient;  // Separate LLM for content generation
  world: AzgaarWorld;
  canon: CanonStore;
  state: ChatState;
  userText: string;
  campaignSettings?: CampaignSettings;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onLLMComplete?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined) => void;
}): Promise<{ reply: string; scene?: SceneContext; state: ChatState }> {
  // Ensure canon DB is initialized
  opts.canon.initDb();

  // Create tool registry and context
  const registry = createDirectorRegistry();
  const ctx: ToolContext = {
    world: opts.world,
    canon: opts.canon,
    llm: opts.llm,
    generationLlm: opts.generationLlm,
    state: opts.state,
    campaignSettings: opts.campaignSettings,
  };

  // Add user message to history
  opts.state.directorHistory.push({ role: "user", content: opts.userText });

  // Run the tool loop
  const result = await runToolLoop({
    llm: opts.llm,
    registry,
    ctx,
    systemPrompt: buildDirectorSystemPrompt(opts.campaignSettings),
    userMessage: opts.userText,
    maxIterations: 15,
    onToolCall: opts.onToolCall,
    onToolResult: opts.onToolResult,
    onLLMComplete: opts.onLLMComplete,
  });

  // Use narration from session.narrate if available, otherwise use final text
  const reply = result.narration || result.finalText || "I processed your request but have nothing to narrate.";

  // Add assistant response to history
  opts.state.directorHistory.push({ role: "assistant", content: reply });

  // Build scene context from current state
  let scene: SceneContext | undefined;
  if (result.state.currentBurgId) {
    const burg = opts.world.getBurg(result.state.currentBurgId);
    if (burg) {
      const location = result.state.currentLocationId
        ? opts.canon.getEntity(result.state.currentLocationId)
        : undefined;

      // Get NPCs at location
      const npcs: CanonEntity[] = [];
      if (location) {
        const rels = opts.canon.listRelations({ entity_id: location.id, limit: 200 });
        const npcIds = rels
          .filter((r) => r.rel_type === "located_at" && r.to_id === location.id)
          .map((r) => r.from_id);
        for (const id of npcIds) {
          const e = opts.canon.getEntity(id);
          if (e && e.type === "npc") npcs.push(e);
        }
      }

      // Get factions in burg
      const factions = opts.canon.listEntities({
        type: "faction",
        anchors: { burgId: result.state.currentBurgId },
        limit: 20,
      });

      scene = {
        burgId: result.state.currentBurgId,
        burg,
        state: typeof burg.state === "number" ? opts.world.getState(burg.state) : undefined,
        location: location?.type === "location" ? location : undefined,
        npcs,
        factions,
      };
    }
  }

  return { reply, scene, state: result.state };
}
