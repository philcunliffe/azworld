/**
 * gen-agent.ts - Planning and execution sub-agents for intelligent generation
 *
 * This module provides a two-phase generation flow:
 * 1. Planning: Sub-agent explores context and produces a generation plan
 * 2. Execution: Sub-agent generates entities according to the plan
 *
 * The user approves the plan between phases.
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity, EntityType } from "../canon/canon";
import { LLMClient, completeJsonWithUsage, ToolDefinition, ToolCall, ChatMessage, TokenUsage } from "../llm/providers";
import { CampaignSettings } from "../chat/schema";
import { formatSettingsForGeneration } from "../chat/campaign-settings";
import {
  BrowseState,
  EntityRef,
  currentRef,
  currentBurgId,
  currentLocationId,
  setStack,
} from "./state";

// Types for generation planning
export type EntityPlan = {
  type: EntityType;
  name: string;
  kind?: string;
  reason: string;  // LLM-generated reason for THIS entity
  connectsTo: Array<{
    name: string;
    rel: string;
    isNew?: boolean;  // true if connecting to another new entity
    isExisting?: boolean;  // true if connecting to existing entity
  }>;
};

export type GenPlan = {
  description: string;
  userPrompt: string;
  entities: EntityPlan[];
  context: {
    burgId: number;
    burgName: string;
    stateName?: string;
    activeEvents: string[];
    existingEntities: string[];  // Names of similar entities found
  };
};

export type GenResult = {
  entityIds: string[];
  summary: string;
};

export type GenContext = {
  state: BrowseState;
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;
  campaignSettings?: CampaignSettings;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onTokens?: (usage: Partial<TokenUsage>) => void;
  onEntityStart?: (name: string, index: number, total: number) => void;
  onEntityComplete?: (name: string, index: number, total: number, tokens: number, elapsedMs: number) => void;
};

// Planning tools for the sub-agent
const PLANNING_TOOLS: ToolDefinition[] = [
  {
    name: "canon_query",
    description: "Search canon entities by type and/or text. Returns IDs and names only.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Entity type: npc, location, faction, event" },
        text: { type: "string", description: "Text to search for in name/summary" },
        burgId: { type: "string", description: "Filter by burg ID" },
        limit: { type: "string", description: "Max results (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "canon_getActiveEvents",
    description: "Get active events affecting the current location/burg",
    parameters: {
      type: "object",
      properties: {
        burgId: { type: "string", description: "Burg ID to check events for" },
        recencyDays: { type: "string", description: "How far back to look (default 90)" },
      },
      required: [],
    },
  },
  {
    name: "world_getBurgDetails",
    description: "Get details about a burg (city/town)",
    parameters: {
      type: "object",
      properties: {
        burgId: { type: "string", description: "Burg ID" },
      },
      required: ["burgId"],
    },
  },
  {
    name: "submit_plan",
    description: "Submit the generation plan. Call this when you have gathered enough context.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Brief description of what will be generated" },
        entities: {
          type: "string",
          description: "JSON array of entities to create, each with: type, name, kind (optional), reason, connectsTo (array of {name, rel, isNew?, isExisting?})",
        },
      },
      required: ["description", "entities"],
    },
  },
];

// Execute planning tools
async function executePlanningTool(
  name: string,
  args: Record<string, any>,
  ctx: GenContext
): Promise<any> {
  const burgId = currentBurgId(ctx.state);

  switch (name) {
    case "canon_query": {
      const type = args.type as EntityType | undefined;
      const text = args.text as string | undefined;
      const qBurgId = args.burgId ? Number(args.burgId) : burgId;
      const limit = args.limit ? Number(args.limit) : 10;

      const entities = ctx.canon.listEntities({
        type,
        text,
        anchors: qBurgId !== undefined ? { burgId: qBurgId } : undefined,
        limit,
      });

      return entities.map(e => ({ id: e.id, name: e.name, type: e.type, kind: e.payload?.kind }));
    }

    case "canon_getActiveEvents": {
      const qBurgId = args.burgId ? Number(args.burgId) : burgId;
      const recencyDays = args.recencyDays ? Number(args.recencyDays) : 90;

      const events = ctx.canon.getActiveEvents({ burgId: qBurgId, recencyDays });
      return events.map(e => ({
        name: e.name,
        scope: e.payload?.scope,
        severity: e.payload?.severity,
        daysAgo: e.payload?.daysAgo,
        summary: e.summary,
      }));
    }

    case "world_getBurgDetails": {
      const id = Number(args.burgId);
      const burg = ctx.world.getBurg(id);
      if (!burg) return { error: `Burg ${id} not found` };

      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;
      return {
        id: burg.id,
        name: burg.name,
        population: burg.population ?? burg.pop,
        capital: burg.capital,
        port: burg.port,
        state: state ? { id: state.id, name: state.name, form: state.formName ?? state.form } : null,
      };
    }

    case "submit_plan": {
      // This is handled specially - return the plan data
      let entities: EntityPlan[] = [];
      try {
        entities = JSON.parse(args.entities || "[]");
      } catch {
        entities = [];
      }
      return {
        _isPlan: true,
        description: args.description,
        entities,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Plan generation using a sub-agent with tools
 */
export async function planGeneration(
  prompt: string,
  genType: "location" | "npc" | "faction",
  kindHint: string | undefined,
  ctx: GenContext
): Promise<GenPlan> {
  const burgId = currentBurgId(ctx.state);
  if (burgId === undefined) {
    throw new Error("Navigate to a burg first (use: loc <burg name>)");
  }

  const burg = ctx.world.getBurg(burgId);
  if (!burg) {
    throw new Error(`Burg ${burgId} not found`);
  }

  const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;
  const locationId = currentLocationId(ctx.state);
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);

  const systemPrompt = `You are a world-building planning assistant. Your job is to plan entity generation for a tabletop RPG world.

Given a user's generation request, you should:
1. Query existing entities to avoid duplicates and find connection opportunities
2. Check for active events that should influence the generation
3. Get burg details for context
4. Create a coherent plan that fits the world

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
IMPORTANT GUIDELINES:
- Each entity needs a specific "reason" explaining why it's being created
- Reasons should be meaningful for audit ("Barkeep to staff the tavern" not just "Requested by user")
- Look for opportunities to connect new entities to existing ones
- Avoid duplicating names of existing entities
- Consider how active events might affect the generation

LOCATION REQUIREMENTS:
- For each location, determine what NPCs would naturally be present based on the location type
- Most locations should have at least 1 NPC (owner, worker, regular visitor, etc.)
- Some locations may have none (abandoned places, remote shrines, secret hideouts)
- Think about: Who runs this place? Who works here? Who frequents it?
- NPCs must have connectsTo entries linking them to the location with rel "located_at"

After gathering context, call submit_plan with your plan.`;

  const userMessage = `Generate: ${genType}${kindHint ? ` (${kindHint})` : ""}
User request: ${prompt}

Current context:
- Burg: ${burg.name} (ID: ${burgId})${state ? `, State: ${state.name}` : ""}
- Population: ${burg.population ?? burg.pop ?? "unknown"}${burg.capital ? ", Capital" : ""}${burg.port ? ", Port" : ""}
${locationId ? `- Current location ID: ${locationId}` : ""}

Start by querying for existing ${genType}s in this burg, then check active events, then submit your plan.`;

  const llm = ctx.llm;
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  // Run the planning agent loop
  let plan: GenPlan | null = null;
  let iterations = 0;
  const maxIterations = 5;

  while (!plan && iterations < maxIterations) {
    iterations++;

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: PLANNING_TOOLS,
      toolChoice: iterations === maxIterations ? "required" : "auto",
      maxTokens: 2000,
      temperature: 0.3,
    });

    // Report token usage
    if (result.usage && ctx.onTokens) {
      ctx.onTokens(result.usage);
    }

    // If no tool calls, the agent is done (shouldn't happen with proper prompting)
    if (!result.toolCalls?.length) {
      // Force submit_plan if we have text but no tool call
      if (result.text) {
        messages.push({ role: "assistant", content: result.text });
      }
      break;
    }

    // Process tool calls
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: result.text || "",
      toolCalls: result.toolCalls,
    };
    messages.push(assistantMessage);

    for (const tc of result.toolCalls) {
      if (ctx.onToolCall) ctx.onToolCall(tc.name, tc.arguments);
      const startTime = Date.now();

      const toolResult = await executePlanningTool(tc.name, tc.arguments, ctx);

      if (ctx.onToolResult) {
        ctx.onToolResult(tc.name, toolResult, Date.now() - startTime);
      }

      // Check if this is the plan submission
      if (toolResult?._isPlan) {
        const activeEvents = ctx.canon.getActiveEvents({ burgId, recencyDays: 90 });
        const existingEntities = ctx.canon.listEntities({
          type: genType as EntityType,
          anchors: { burgId },
          limit: 20,
        });

        plan = {
          description: toolResult.description,
          userPrompt: prompt,
          entities: toolResult.entities,
          context: {
            burgId,
            burgName: burg.name,
            stateName: state?.name,
            activeEvents: activeEvents.map((e: CanonEntity) => e.name),
            existingEntities: existingEntities.map((e: CanonEntity) => e.name),
          },
        };
        break;
      }

      // Add tool result to messages
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        toolCallId: tc.id,
      });
    }
  }

  if (!plan) {
    // Fallback: create a simple plan based on the request
    plan = {
      description: `Generate ${genType}${kindHint ? ` (${kindHint})` : ""} per user request`,
      userPrompt: prompt,
      entities: [{
        type: genType as EntityType,
        name: `New ${kindHint || genType}`,
        kind: kindHint,
        reason: `User requested: ${prompt}`,
        connectsTo: [],
      }],
      context: {
        burgId,
        burgName: burg.name,
        stateName: state?.name,
        activeEvents: [],
        existingEntities: [],
      },
    };
  }

  return plan;
}

/**
 * Execute a generation plan, creating all entities
 */
export async function executeGeneration(
  plan: GenPlan,
  ctx: GenContext
): Promise<GenResult> {
  const genLlm = ctx.generationLlm || ctx.llm;
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const nowIso = () => new Date().toISOString();

  const createdIds: string[] = [];
  const keyToId: Record<string, string> = {};
  const summaries: string[] = [];
  const total = plan.entities.length;

  // First pass: Generate all entities in parallel
  const generateEntity = async (entityPlan: EntityPlan, index: number) => {
    const startTime = Date.now();
    ctx.onEntityStart?.(entityPlan.name, index, total);

    const systemPrompt = `You are a tabletop GM assistant. Generate a detailed ${entityPlan.type} entity for a fantasy world.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON with these fields:
{
  "name": "${entityPlan.name}",
  "summary": "One-line description",
  "details_md": "Longer markdown description with background, personality, secrets etc",
  "tags": ["tag1", "tag2"],
  "payload": { ... type-specific data ... }
}

For NPCs, payload should include: role, personality, appearance, knows (public/secret arrays), secrets, motivations
For locations, payload should include: kind, atmosphere, features
For factions, payload should include: kind, goals, methods, influence`;

    const userPrompt = JSON.stringify({
      type: entityPlan.type,
      suggestedName: entityPlan.name,
      kind: entityPlan.kind,
      reason: entityPlan.reason,
      context: {
        burgName: plan.context.burgName,
        stateName: plan.context.stateName,
        activeEvents: plan.context.activeEvents,
        userRequest: plan.userPrompt,
      },
      connections: entityPlan.connectsTo,
    });

    try {
      const { data: result, usage } = await completeJsonWithUsage(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2000,
        temperature: 0.7,
      }) as { data: any; usage?: TokenUsage };

      const elapsedMs = Date.now() - startTime;
      const tokens = usage?.totalTokens ?? 0;

      // Report token usage for status bar totals
      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      ctx.onEntityComplete?.(entityPlan.name, index, total, tokens, elapsedMs);

      return { entityPlan, result, usage, success: true as const };
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(entityPlan.name, index, total, 0, elapsedMs);
      console.error(`Failed to generate ${entityPlan.name}:`, e?.message || e);
      return { entityPlan, error: e?.message || e, success: false as const };
    }
  };

  // Run all generations in parallel
  const results = await Promise.all(
    plan.entities.map((entityPlan, index) => generateEntity(entityPlan, index))
  );

  // Process successful results sequentially (DB writes)
  for (const res of results) {
    if (!res.success) continue;
    const { entityPlan, result } = res;

    const entity = ctx.canon.addEntity({
      type: entityPlan.type,
      name: result.name || entityPlan.name,
      summary: result.summary || null,
      details_md: result.details_md || null,
      tags: result.tags || [entityPlan.kind || entityPlan.type],
      anchors: { burgId: plan.context.burgId },
      payload: result.payload || { kind: entityPlan.kind },
      provenance: {
        generated_by: "azbrowse",
        provider: genLlm.provider,
        model: genLlm.model,
        reason: entityPlan.reason,
        user_prompt: plan.userPrompt,
        approved_at: nowIso(),
      },
    });

    createdIds.push(entity.id);
    keyToId[entityPlan.name] = entity.id;
    summaries.push(`${entity.name} (${entityPlan.type})`);
  }

  // Second pass: Create relations
  for (const entityPlan of plan.entities) {
    const fromId = keyToId[entityPlan.name];
    if (!fromId) continue;

    for (const conn of entityPlan.connectsTo) {
      let toId: string | undefined;

      if (conn.isNew) {
        // Connect to another new entity
        toId = keyToId[conn.name];
      } else if (conn.isExisting) {
        // Find existing entity by name
        const existing = ctx.canon.listEntities({ text: conn.name, limit: 5 });
        const match = existing.find(e => e.name.toLowerCase() === conn.name.toLowerCase());
        toId = match?.id;
      }

      if (toId && fromId !== toId) {
        ctx.canon.addRelation({
          from_id: fromId,
          to_id: toId,
          rel_type: conn.rel,
        });
      }
    }
  }

  // Update state to navigate to first created location (if any)
  const firstLocation = plan.entities.find(e => e.type === "location");
  if (firstLocation) {
    const locationId = keyToId[firstLocation.name];
    if (locationId) {
      ctx.state.chatState.currentLocationId = locationId;
      ctx.state.chatState.currentBurgId = plan.context.burgId;
    }
  }

  return {
    entityIds: createdIds,
    summary: summaries.length > 0
      ? `Created: ${summaries.join(", ")}`
      : "No entities created",
  };
}

/**
 * Format a plan for user approval display
 */
export function formatPlanForApproval(plan: GenPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}Generation Plan${RESET}`);
  lines.push(`${DIM}${plan.userPrompt}${RESET}`);
  lines.push("");

  // Context section
  lines.push(`${BOLD}Context:${RESET}`);
  lines.push(`  Location: ${plan.context.burgName}${plan.context.stateName ? ` (${plan.context.stateName})` : ""}`);
  if (plan.context.activeEvents.length > 0) {
    lines.push(`  Active events: ${plan.context.activeEvents.slice(0, 3).join(", ")}`);
  }
  if (plan.context.existingEntities.length > 0) {
    lines.push(`  ${DIM}Similar existing: ${plan.context.existingEntities.slice(0, 5).join(", ")}${RESET}`);
  }
  lines.push("");

  // Entities to create
  lines.push(`${BOLD}Will create:${RESET}`);
  for (const entity of plan.entities) {
    const icon = entity.type === "location" ? "📍" :
                 entity.type === "npc" ? "👤" :
                 entity.type === "faction" ? "🏛️" :
                 entity.type === "event" ? "⚡" : "📄";

    lines.push(`  ${icon} ${GREEN}${entity.name}${RESET} (${entity.type}${entity.kind ? `: ${entity.kind}` : ""})`);
    lines.push(`     ${DIM}"${entity.reason}"${RESET}`);

    for (const conn of entity.connectsTo) {
      const marker = conn.isNew ? "" : conn.isExisting ? `${YELLOW}[existing]${RESET}` : "";
      lines.push(`     └─ ${conn.rel}: ${conn.name} ${marker}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Sync navigation state from chat state after generation
 */
export function syncNavigationFromChatState(ctx: GenContext): void {
  const { chatState } = ctx.state;

  if (chatState.currentLocationId) {
    const cur = currentRef(ctx.state);
    if (cur.kind !== "location" || cur.locationId !== chatState.currentLocationId) {
      const loc = ctx.canon.getEntity(chatState.currentLocationId);
      const burgId = loc?.anchors?.burgId as number | undefined;

      if (burgId !== undefined) {
        const newStack: EntityRef[] = [{ kind: "world" }];
        const burg = ctx.world.getBurg(burgId);
        if (burg?.state !== undefined) {
          newStack.push({ kind: "state", stateId: burg.state });
        }
        newStack.push({ kind: "burg", burgId });
        newStack.push({ kind: "location", locationId: chatState.currentLocationId });
        setStack(ctx.state, newStack);
      }
    }
  }
}
