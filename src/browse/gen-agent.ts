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
import { debugLLMCall, debugLog, isDebugEnabled } from "../chat/debug-log";
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
  failures?: Array<{ name: string; type: string; error: string }>;
};

// Types for modification planning
export type ModFieldChange = {
  field: "name" | "summary" | "details_md" | "tags" | "payload";
  oldValue: any;
  newValue: any;
  reason: string;
};

export type ModPlan = {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  description: string;
  userPrompt: string;
  changes: ModFieldChange[];
  context: {
    burgId?: number;
    burgName?: string;
    relatedEntities: string[];
  };
};

export type ModResult = {
  success: boolean;
  entityId: string;
  summary: string;
  appliedChanges: string[];
  error?: string;
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
  onEntityComplete?: (entity: { id: string; name: string; type: string }, index: number, total: number, tokens: number, elapsedMs: number) => void;
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
    description: "Submit the generation plan. Call this when you have gathered enough context. IMPORTANT: Entity names must NOT contain quotes or special characters that would break JSON parsing.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Brief description of what will be generated" },
        entities: {
          type: "string",
          description: "JSON array of entities to create. Each entity has: type (location/npc/faction/event), name (NO quotes in names!), kind (optional subtype), reason (why creating), connectsTo (array of {name, rel, isNew?, isExisting?}). Example: [{\"type\":\"location\",\"name\":\"The Red Dragon Inn\",\"kind\":\"tavern\",\"reason\":\"User requested tavern\",\"connectsTo\":[]}]",
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

      // Debug: log the raw input
      const entitiesType = typeof args.entities;
      const isArray = Array.isArray(args.entities);
      // Check for String object (typeof returns "object" for new String())
      const isStringObject = args.entities instanceof String;

      debugLog(`[submit_plan] args.entities type: ${entitiesType}, isArray: ${isArray}, isStringObject: ${isStringObject}`);
      debugLog(`[submit_plan] args.entities constructor: ${args.entities?.constructor?.name}`);

      // Handle entities as array (new format) or string (legacy format)
      if (isArray) {
        entities = args.entities;
        debugLog(`[submit_plan] Using array directly, length: ${entities.length}`);
      } else if ((entitiesType === "string" || isStringObject) && args.entities) {
        // Convert String object to primitive if needed
        const entitiesStr = String(args.entities);
        debugLog(`[submit_plan] Parsing string, length: ${entitiesStr.length}`);
        debugLog(`[submit_plan] First 100 chars: ${entitiesStr.slice(0, 100)}`);
        try {
          const parsed = JSON.parse(entitiesStr);
          if (Array.isArray(parsed)) {
            entities = parsed;
            debugLog(`[submit_plan] Parsed successfully, got ${entities.length} entities`);
          } else {
            debugLog(`[submit_plan] ERROR: Parsed entities is not an array: ${typeof parsed}`);
          }
        } catch (e: any) {
          debugLog(`[submit_plan] ERROR: Failed to parse entities JSON: ${e?.message || e}`);
          debugLog(`[submit_plan] First 20 char codes: ${[...entitiesStr.slice(0, 20)].map(c => c.charCodeAt(0)).join(',')}`);
        }
      } else if (args.entities && entitiesType === "object") {
        // Sometimes the LLM sends it as an object that got parsed by the provider
        // But NOT a String object (handled above), so this is a real object/array-like
        debugLog(`[submit_plan] entities is object, checking if array-like`);
        if (typeof args.entities.length === "number" && args.entities.length > 0) {
          // Make sure we're not just getting string characters
          const firstItem = args.entities[0];
          if (typeof firstItem === "object" && firstItem !== null) {
            entities = Array.from(args.entities);
            debugLog(`[submit_plan] Converted array-like object, length: ${entities.length}`);
          } else {
            debugLog(`[submit_plan] ERROR: array-like but first item is not object: ${typeof firstItem}`);
          }
        } else {
          debugLog(`[submit_plan] ERROR: entities is object but not valid array-like: ${JSON.stringify(args.entities).slice(0, 200)}`);
        }
      } else {
        debugLog(`[submit_plan] WARNING: No entities provided or unhandled type`);
      }

      if (entities.length === 0 && args.entities) {
        debugLog(`[submit_plan] WARNING: No entities parsed but args.entities exists`);
        debugLog(`[submit_plan] args.entities preview: ${String(args.entities).slice(0, 300)}`);
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
  const failures: Array<{ name: string; type: string; error: string }> = [];
  const total = plan.entities.length;

  // First pass: Generate all entities in parallel (LLM calls only)
  const generateEntity = async (entityPlan: EntityPlan, index: number) => {
    const startTime = Date.now();
    ctx.onEntityStart?.(entityPlan.name, index, total);

    const systemPrompt = `You are a tabletop GM assistant. Generate a detailed ${entityPlan.type} entity for a fantasy world.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON with these fields:
{
  "name": "${entityPlan.name}",
  "summary": "One-line description (brief tagline)",
  "details_md": "Only for additional notes that don't fit structured fields - usually empty or minimal",
  "tags": ["tag1", "tag2"],
  "payload": { ... type-specific data ... }
}

For NPCs, payload MUST include ALL of these structured fields:
- role: string (job/position like "Tavernkeeper", "Guard Captain", "Merchant")
- background: string (brief backstory, 2-3 sentences - origin, history, how they got here)
- personality: string (key traits and mannerisms, 2-3 sentences)
- appearance: string (physical description, 1-2 sentences)
- hooks: string[] (2-4 GM-facing story hooks/adventure seeds involving this NPC)
- knows: { public: string[], secret: string[] } (what this NPC knows - public facts anyone can learn, secret facts only revealed through roleplay)
- secrets: string[] (personal secrets ABOUT this NPC - things they hide)
- motivations: string[] (what drives them, their goals)

IMPORTANT for NPCs: Put ALL descriptive content in the payload fields above. The "details_md" field should be empty or minimal - do NOT duplicate background/personality/appearance there.

For locations, payload should include: kind, briefDescription (3-5 sentences for quick reference), physicalDescription (detailed sensory description - sights, sounds, smells, layout, lighting, notable features), atmosphere, features
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

      return { entityPlan, result, usage, elapsedMs, tokens, index, success: true as const };
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      const errorMsg = e?.message || String(e);
      console.error(`Failed to generate ${entityPlan.name}:`, errorMsg);
      if (isDebugEnabled()) {
        debugLLMCall(`Generation FAILED: ${entityPlan.name}`, { type: entityPlan.type, error: errorMsg });
      }
      return { entityPlan, error: errorMsg, elapsedMs, tokens: 0, index, success: false as const };
    }
  };

  // Run all generations in parallel
  const results = await Promise.all(
    plan.entities.map((entityPlan, index) => generateEntity(entityPlan, index))
  );

  // Process results sequentially (DB writes) and fire callbacks with entity IDs
  for (const res of results) {
    if (!res.success) {
      // Record the failure
      failures.push({
        name: res.entityPlan.name,
        type: res.entityPlan.type,
        error: res.error || "Unknown error",
      });
      // Fire callback for failed entities (no ID)
      ctx.onEntityComplete?.(
        { id: "", name: res.entityPlan.name, type: res.entityPlan.type },
        res.index,
        total,
        res.tokens,
        res.elapsedMs
      );
      continue;
    }
    const { entityPlan, result, elapsedMs, tokens, index } = res;

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

    // Fire callback with actual entity info (including ID)
    ctx.onEntityComplete?.(
      { id: entity.id, name: entity.name, type: entity.type },
      index,
      total,
      tokens,
      elapsedMs
    );
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

  // Build summary including both successes and failures
  const summaryParts: string[] = [];
  if (summaries.length > 0) {
    summaryParts.push(`Created: ${summaries.join(", ")}`);
  }
  if (failures.length > 0) {
    const failedNames = failures.map(f => `${f.name} (${f.type})`).join(", ");
    summaryParts.push(`Failed: ${failedNames}`);
  }

  return {
    entityIds: createdIds,
    summary: summaryParts.length > 0
      ? summaryParts.join("\n")
      : "No entities created",
    failures: failures.length > 0 ? failures : undefined,
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

// Modification planning tools for the sub-agent
const MOD_PLANNING_TOOLS: ToolDefinition[] = [
  {
    name: "get_entity_full",
    description: "Get complete entity details including all fields",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Entity ID to retrieve" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "get_entity_relations",
    description: "Get all relations involving this entity",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Entity ID to get relations for" },
      },
      required: ["entityId"],
    },
  },
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
    name: "submit_mod_plan",
    description: "Submit the modification plan with specific changes. Call this when you have analyzed the entity and determined what changes to make.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Brief description of the modification" },
        changes: {
          type: "string",
          description: "JSON array of changes. Each change has: field (name/summary/details_md/tags/payload), oldValue, newValue, reason. Example: [{\"field\":\"summary\",\"oldValue\":\"A tired bartender\",\"newValue\":\"A tired bartender who secretly works for the crown\",\"reason\":\"Adding spy background per user request\"}]",
        },
      },
      required: ["description", "changes"],
    },
  },
];

// Execute modification planning tools
async function executeModPlanningTool(
  name: string,
  args: Record<string, any>,
  ctx: GenContext,
  targetEntity: CanonEntity
): Promise<any> {
  switch (name) {
    case "get_entity_full": {
      const id = args.entityId as string;
      const entity = ctx.canon.getEntity(id);
      if (!entity) return { error: `Entity ${id} not found` };
      return {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        summary: entity.summary,
        details_md: entity.details_md,
        tags: entity.tags,
        payload: entity.payload,
        anchors: entity.anchors,
        _note: "Now analyze this entity and call submit_mod_plan with your proposed changes.",
      };
    }

    case "get_entity_relations": {
      const id = args.entityId as string;
      const rels = ctx.canon.listRelations({ entity_id: id, limit: 50 });
      return rels.map(r => {
        const fromEntity = ctx.canon.getEntity(r.from_id);
        const toEntity = ctx.canon.getEntity(r.to_id);
        return {
          id: r.id,
          from: { id: r.from_id, name: fromEntity?.name, type: fromEntity?.type },
          to: { id: r.to_id, name: toEntity?.name, type: toEntity?.type },
          rel_type: r.rel_type,
          notes: r.notes,
        };
      });
    }

    case "canon_query": {
      const type = args.type as EntityType | undefined;
      const text = args.text as string | undefined;
      const burgId = args.burgId ? Number(args.burgId) : undefined;
      const limit = args.limit ? Number(args.limit) : 10;

      const entities = ctx.canon.listEntities({
        type,
        text,
        anchors: burgId !== undefined ? { burgId } : undefined,
        limit,
      });

      return entities.map(e => ({ id: e.id, name: e.name, type: e.type, kind: e.payload?.kind }));
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

    case "submit_mod_plan": {
      // Parse changes
      let changes: ModFieldChange[] = [];
      if (Array.isArray(args.changes)) {
        changes = args.changes;
      } else if (typeof args.changes === "string") {
        try {
          changes = JSON.parse(args.changes);
        } catch (e) {
          console.error("[submit_mod_plan] Failed to parse changes JSON:", e);
          changes = [];
        }
      }

      return {
        _isModPlan: true,
        description: args.description,
        changes,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Plan modification using a sub-agent with tools
 */
export async function planModification(
  entityId: string,
  prompt: string,
  ctx: GenContext
): Promise<ModPlan> {
  const entity = ctx.canon.getEntity(entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const burgId = entity.anchors?.burgId as number | undefined;
  const burg = burgId !== undefined ? ctx.world.getBurg(burgId) : undefined;
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);

  const systemPrompt = `You are a world-building modification assistant. Your job is to plan specific changes to an existing entity.

Given an entity and modification request, you should:
1. FIRST call get_entity_full to understand the current state
2. Then call submit_mod_plan with your proposed changes

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
IMPORTANT GUIDELINES:
- Preserve existing content unless explicitly changing it
- For each change, provide a clear reason
- Be specific about what's being changed (old value vs new value)
- For payload changes, you can modify specific payload fields

CRITICAL: You MUST call submit_mod_plan to complete this task. Without calling submit_mod_plan, no changes will be made.`;

  const userMessage = `Modify entity: ${entity.name} (${entity.type})
Modification request: "${prompt}"

Entity ID: ${entityId}

Instructions:
1. Call get_entity_full with entityId "${entityId}" to see current state
2. Call submit_mod_plan with the specific field changes needed to implement the modification request

You MUST call submit_mod_plan to complete this task.`;

  const llm = ctx.llm;
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  // Run the planning agent loop
  let plan: ModPlan | null = null;
  let iterations = 0;
  const maxIterations = 5;

  while (!plan && iterations < maxIterations) {
    iterations++;

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: MOD_PLANNING_TOOLS,
      toolChoice: iterations === maxIterations ? "required" : "auto",
      maxTokens: 2000,
      temperature: 0.3,
    });

    // Report token usage
    if (result.usage && ctx.onTokens) {
      ctx.onTokens(result.usage);
    }

    // If no tool calls, the agent is done
    if (!result.toolCalls?.length) {
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

      const toolResult = await executeModPlanningTool(tc.name, tc.arguments, ctx, entity);

      if (ctx.onToolResult) {
        ctx.onToolResult(tc.name, toolResult, Date.now() - startTime);
      }

      // Check if this is the plan submission
      if (toolResult?._isModPlan) {
        const rels = ctx.canon.listRelations({ entity_id: entityId, limit: 20 });
        const relatedEntities = rels.map(r => {
          const otherId = r.from_id === entityId ? r.to_id : r.from_id;
          const other = ctx.canon.getEntity(otherId);
          return other?.name || otherId;
        });

        plan = {
          entityId,
          entityName: entity.name,
          entityType: entity.type,
          description: toolResult.description,
          userPrompt: prompt,
          changes: toolResult.changes,
          context: {
            burgId,
            burgName: burg?.name,
            relatedEntities,
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
    // Check if we have any text response from the LLM that might explain what happened
    const lastAssistantMsg = messages.filter(m => m.role === "assistant").pop();
    const assistantText = lastAssistantMsg?.content;
    if (assistantText && typeof assistantText === "string" && assistantText.length > 0) {
      throw new Error(`Modification planning failed. The assistant responded with text instead of calling submit_mod_plan: "${assistantText.slice(0, 200)}..."`);
    }
    throw new Error("Failed to create modification plan - agent did not call submit_mod_plan");
  }

  return plan;
}

/**
 * Execute a modification plan, applying all changes
 */
export function executeModification(plan: ModPlan, ctx: GenContext): ModResult {
  const entity = ctx.canon.getEntity(plan.entityId);
  if (!entity) {
    return {
      success: false,
      entityId: plan.entityId,
      summary: `Entity not found: ${plan.entityId}`,
      appliedChanges: [],
      error: `Entity not found: ${plan.entityId}`,
    };
  }

  const patch: Record<string, any> = {};
  const appliedChanges: string[] = [];

  for (const change of plan.changes) {
    if (change.field === "payload") {
      // Merge payload rather than replace
      patch.payload = { ...entity.payload, ...change.newValue };
    } else {
      patch[change.field] = change.newValue;
    }
    appliedChanges.push(`${change.field}: ${change.reason}`);
  }

  const updated = ctx.canon.patchEntity(plan.entityId, patch);
  if (!updated) {
    return {
      success: false,
      entityId: plan.entityId,
      summary: "Failed to update entity",
      appliedChanges: [],
      error: "Failed to update entity",
    };
  }

  return {
    success: true,
    entityId: plan.entityId,
    summary: `Updated: ${updated.name}`,
    appliedChanges,
  };
}

/**
 * Format a modification plan for user approval display
 */
export function formatModPlanForApproval(plan: ModPlan, entity: CanonEntity, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const RED = useColors ? "\x1b[31m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}Modification Plan${RESET}`);
  lines.push(`${DIM}${plan.userPrompt}${RESET}`);
  lines.push("");

  // Entity info
  lines.push(`${BOLD}Entity:${RESET} ${entity.name} (${entity.type})`);
  if (plan.context.burgName) {
    lines.push(`${DIM}Location: ${plan.context.burgName}${RESET}`);
  }
  if (plan.context.relatedEntities.length > 0) {
    lines.push(`${DIM}Related: ${plan.context.relatedEntities.slice(0, 5).join(", ")}${RESET}`);
  }
  lines.push("");

  // Changes
  lines.push(`${BOLD}Proposed Changes:${RESET}`);
  for (const change of plan.changes) {
    lines.push(`  ${YELLOW}${change.field}${RESET}`);
    lines.push(`    ${RED}- ${truncateValue(change.oldValue, 60)}${RESET}`);
    lines.push(`    ${GREEN}+ ${truncateValue(change.newValue, 60)}${RESET}`);
    lines.push(`    ${DIM}"${change.reason}"${RESET}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Helper to truncate long values for display
 */
function truncateValue(value: any, maxLen: number): string {
  if (value === null || value === undefined) return "(empty)";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
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
