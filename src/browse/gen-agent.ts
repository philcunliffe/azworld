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

// Field configurations for each entity type
export const ENTITY_FIELD_CONFIGS: Record<string, { core: string[]; payload: string[] }> = {
  npc: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["role", "background", "personality", "appearance", "hooks", "knows", "secrets", "motivations"],
  },
  location: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["kind", "briefDescription", "physicalDescription", "atmosphere", "features"],
  },
  faction: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["kind", "goals", "methods", "influence"],
  },
  event: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["scope", "severity", "daysAgo"],
  },
  rumor: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["truthLevel", "spreadLevel", "sourceType", "actualTruth"],
  },
  hook: {
    core: ["name", "summary", "details_md", "tags"],
    payload: ["hookType", "urgency", "difficulty", "rewardType", "rewardDetails", "complications", "failureConsequences"],
  },
  meta: {
    core: ["summary", "details_md"],
    // Combined fields for both state and burg descriptions
    payload: ["atmosphere", "politicalClimate", "notableFeatures", "history", "currentAffairs", "notableLandmarks", "dailyLife", "localCustoms", "reputation"],
  },
};

// Field configurations for description meta entities (state/burg descriptions)
export const STATE_DESCRIPTION_FIELDS = {
  core: ["summary", "details_md"],
  payload: ["atmosphere", "politicalClimate", "notableFeatures", "history", "currentAffairs"],
};

export const BURG_DESCRIPTION_FIELDS = {
  core: ["summary", "details_md"],
  payload: ["atmosphere", "notableLandmarks", "dailyLife", "localCustoms", "reputation"],
};

// Types for generation planning
export type EntityPlan = {
  type: EntityType;
  name: string;
  kind?: string;
  reason: string;  // LLM-generated reason for THIS entity
  customPrompt?: string;  // Additional user instructions for this entity's generation
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

// Types for field-specific regeneration
export type FieldRegenPlan = {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  description: string;
  userPrompt: string;
  selectedFields: string[];  // Fields to regenerate (from both core and payload)
  context: {
    burgId?: number;
    burgName?: string;
    existingEntity: Partial<CanonEntity>;  // Current entity state for context
  };
};

export type FieldRegenResult = {
  success: boolean;
  entityId: string;
  summary: string;
  regeneratedFields: string[];
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
    description: "Submit the generation plan. Call this when you have gathered enough context. CRITICAL: Output must be valid JSON. To include quotes in text, use backslash-quote (\\\"word\\\"), NOT double-quotes (\"\"word\"\").",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Brief description of what will be generated" },
        entities: {
          type: "string",
          description: "JSON array of entities to create. Each entity has: type (location/npc/faction/event), name (NO quotes in names!), kind (optional subtype), reason (why creating - use apostrophes instead of quotes if needed), connectsTo (array of {name, rel, isNew?, isExisting?}). Example: [{\"type\":\"location\",\"name\":\"The Red Dragon Inn\",\"kind\":\"tavern\",\"reason\":\"User requested tavern\",\"connectsTo\":[]}]",
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
      let parseError: string | null = null;

      // Debug: log the raw input
      const entitiesType = typeof args.entities;
      const isArray = Array.isArray(args.entities);
      // Check for String object (typeof returns "object" for new String())
      const isStringObject = args.entities instanceof String;

      debugLog(`[submit_plan] args.entities type: ${entitiesType}, isArray: ${isArray}, isStringObject: ${isStringObject}`);
      debugLog(`[submit_plan] args.entities constructor: ${args.entities?.constructor?.name}`);

      // Helper to sanitize common LLM JSON mistakes
      const sanitizeJson = (str: string): string => {
        // Fix double-double quotes: "" -> \" (common Word-style quote escaping)
        // But only within string values, not at string boundaries
        // Pattern: look for "" that isn't at the start/end of a string value
        let sanitized = str;

        // Replace "" with \" when it appears to be an attempt to escape quotes
        // This handles cases like: "passed as ""confessions"" in a booth"
        sanitized = sanitized.replace(/([^\\])""/g, '$1\\"');
        // Handle at start of value too
        sanitized = sanitized.replace(/^""/g, '\\"');

        return sanitized;
      };

      // Handle entities as array (new format) or string (legacy format)
      if (isArray) {
        entities = args.entities;
        debugLog(`[submit_plan] Using array directly, length: ${entities.length}`);
      } else if ((entitiesType === "string" || isStringObject) && args.entities) {
        // Convert String object to primitive if needed
        let entitiesStr = String(args.entities);
        debugLog(`[submit_plan] Parsing string, length: ${entitiesStr.length}`);
        debugLog(`[submit_plan] First 100 chars: ${entitiesStr.slice(0, 100)}`);

        // Try parsing, and if it fails, try sanitized version
        try {
          const parsed = JSON.parse(entitiesStr);
          if (Array.isArray(parsed)) {
            entities = parsed;
            debugLog(`[submit_plan] Parsed successfully, got ${entities.length} entities`);
          } else {
            parseError = `Parsed entities is not an array: ${typeof parsed}`;
            debugLog(`[submit_plan] ERROR: ${parseError}`);
          }
        } catch (e: any) {
          debugLog(`[submit_plan] Initial parse failed: ${e?.message || e}`);

          // Try sanitizing the JSON
          const sanitized = sanitizeJson(entitiesStr);
          if (sanitized !== entitiesStr) {
            debugLog(`[submit_plan] Attempting sanitized parse...`);
            try {
              const parsed = JSON.parse(sanitized);
              if (Array.isArray(parsed)) {
                entities = parsed;
                debugLog(`[submit_plan] Sanitized parse successful, got ${entities.length} entities`);
              } else {
                parseError = `Sanitized entities is not an array: ${typeof parsed}`;
                debugLog(`[submit_plan] ERROR: ${parseError}`);
              }
            } catch (e2: any) {
              parseError = `Failed to parse entities JSON (even after sanitization): ${e?.message || e}`;
              debugLog(`[submit_plan] ERROR: ${parseError}`);
              debugLog(`[submit_plan] First 20 char codes: ${[...entitiesStr.slice(0, 20)].map(c => c.charCodeAt(0)).join(',')}`);
            }
          } else {
            parseError = `Failed to parse entities JSON: ${e?.message || e}`;
            debugLog(`[submit_plan] ERROR: ${parseError}`);
            debugLog(`[submit_plan] First 20 char codes: ${[...entitiesStr.slice(0, 20)].map(c => c.charCodeAt(0)).join(',')}`);
          }
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
            parseError = `array-like but first item is not object: ${typeof firstItem}`;
            debugLog(`[submit_plan] ERROR: ${parseError}`);
          }
        } else {
          parseError = `entities is object but not valid array-like: ${JSON.stringify(args.entities).slice(0, 200)}`;
          debugLog(`[submit_plan] ERROR: ${parseError}`);
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
        parseError,  // Include parse error so caller can surface it
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
        // Check for parse errors - if entities are empty and there was a parse error, surface it
        if (toolResult.entities.length === 0 && toolResult.parseError) {
          throw new Error(`LLM produced invalid JSON in plan: ${toolResult.parseError}`);
        }

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
For factions, payload should include: kind, goals, methods, influence
For rumors, payload should include: truthLevel (false/distorted/mostly-true/true), spreadLevel (whisper/local/regional/widespread), sourceType (gossip/observation/leak/planted/unknown), actualTruth (GM-only information)
For hooks, payload should include: hookType (investigation/rescue/exploration/negotiation/combat/heist/escort/delivery/mystery/social), urgency (background/whenever/soon/urgent/critical), difficulty (trivial/easy/moderate/hard/deadly), rewardType (gold/information/favor/item/reputation/mixed), rewardDetails, complications (array), failureConsequences
For events, payload should include: scope (local/city/regional), severity (minor/moderate/major/critical), daysAgo (how many days ago it happened, 0 for ongoing)`;

    const userPrompt = JSON.stringify({
      type: entityPlan.type,
      suggestedName: entityPlan.name,
      kind: entityPlan.kind,
      reason: entityPlan.reason,
      customInstructions: entityPlan.customPrompt,  // Additional user instructions for this entity
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
 * Plan field-specific regeneration for an existing entity
 */
export function planFieldRegeneration(
  entityId: string,
  selectedFields: string[],
  hint: string,
  ctx: GenContext
): FieldRegenPlan {
  const entity = ctx.canon.getEntity(entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const burgId = entity.anchors?.burgId as number | undefined;
  const burg = burgId !== undefined ? ctx.world.getBurg(burgId) : undefined;

  return {
    entityId,
    entityName: entity.name,
    entityType: entity.type,
    description: hint ? `Regenerate fields with hint: "${hint}"` : `Regenerate selected fields`,
    userPrompt: hint || `Regenerate the following fields: ${selectedFields.join(", ")}`,
    selectedFields,
    context: {
      burgId,
      burgName: burg?.name,
      existingEntity: {
        name: entity.name,
        summary: entity.summary,
        details_md: entity.details_md,
        tags: entity.tags,
        payload: entity.payload,
      },
    },
  };
}

/**
 * Execute field-specific regeneration
 */
export async function executeFieldRegeneration(
  plan: FieldRegenPlan,
  ctx: GenContext
): Promise<FieldRegenResult> {
  const entity = ctx.canon.getEntity(plan.entityId);
  if (!entity) {
    return {
      success: false,
      entityId: plan.entityId,
      summary: `Entity not found: ${plan.entityId}`,
      regeneratedFields: [],
      error: `Entity not found: ${plan.entityId}`,
    };
  }

  const genLlm = ctx.generationLlm || ctx.llm;
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const fieldConfig = ENTITY_FIELD_CONFIGS[entity.type] || { core: [], payload: [] };

  // Separate core and payload fields
  const coreFields = plan.selectedFields.filter(f => fieldConfig.core.includes(f));
  const payloadFields = plan.selectedFields.filter(f => fieldConfig.payload.includes(f));

  // Build the system prompt based on entity type
  const systemPrompt = `You are a tabletop GM assistant. You are regenerating specific fields for an existing ${entity.type} entity.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
IMPORTANT:
- You are ONLY regenerating the specified fields
- Maintain consistency with the existing entity data where not regenerating
- The user's hint should guide the regeneration style/content

Output ONLY valid JSON with the regenerated field values.
For core fields (name, summary, details_md, tags), include them at the top level.
For payload fields, include them inside a "payload" object.`;

  const userPrompt = JSON.stringify({
    existingEntity: plan.context.existingEntity,
    fieldsToRegenerate: {
      core: coreFields,
      payload: payloadFields,
    },
    hint: plan.userPrompt,
    context: {
      burgName: plan.context.burgName,
    },
  });

  try {
    ctx.onEntityStart?.(entity.name, 0, 1);
    const startTime = Date.now();

    const { data: result, usage } = await completeJsonWithUsage(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 2000,
      temperature: 0.7,
    }) as { data: any; usage?: TokenUsage };

    const elapsedMs = Date.now() - startTime;

    if (usage && ctx.onTokens) {
      ctx.onTokens(usage);
    }

    // Build the patch from the result
    const patch: Record<string, any> = {};
    const regeneratedFields: string[] = [];

    // Apply core field changes
    for (const field of coreFields) {
      if (result[field] !== undefined) {
        patch[field] = result[field];
        regeneratedFields.push(field);
      }
    }

    // Apply payload field changes
    if (payloadFields.length > 0 && result.payload) {
      const newPayload = { ...entity.payload };
      for (const field of payloadFields) {
        if (result.payload[field] !== undefined) {
          newPayload[field] = result.payload[field];
          regeneratedFields.push(`payload.${field}`);
        }
      }
      patch.payload = newPayload;
    }

    // Apply the patch
    if (Object.keys(patch).length > 0) {
      ctx.canon.patchEntity(plan.entityId, patch);
    }

    ctx.onEntityComplete?.(
      { id: entity.id, name: entity.name, type: entity.type },
      0,
      1,
      usage?.totalTokens ?? 0,
      elapsedMs
    );

    return {
      success: true,
      entityId: plan.entityId,
      summary: `Regenerated ${regeneratedFields.length} field(s) on ${entity.name}`,
      regeneratedFields,
    };
  } catch (e: any) {
    return {
      success: false,
      entityId: plan.entityId,
      summary: `Failed to regenerate fields: ${e?.message || String(e)}`,
      regeneratedFields: [],
      error: e?.message || String(e),
    };
  }
}

/**
 * Format a field regeneration plan for user approval display
 */
export function formatFieldRegenPlanForApproval(plan: FieldRegenPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}Field Regeneration Plan${RESET}`);
  lines.push(`${DIM}${plan.userPrompt}${RESET}`);
  lines.push("");

  // Entity info
  lines.push(`${BOLD}Entity:${RESET} ${plan.entityName} (${plan.entityType})`);
  if (plan.context.burgName) {
    lines.push(`${DIM}Location: ${plan.context.burgName}${RESET}`);
  }
  lines.push("");

  // Fields to regenerate
  lines.push(`${BOLD}Fields to regenerate:${RESET}`);
  for (const field of plan.selectedFields) {
    lines.push(`  ${YELLOW}•${RESET} ${field}`);
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

// --- Description Generation for States and Burgs ---

export type DescriptionTarget =
  | { stateId: number }
  | { burgId: number };

export type DescriptionPlan = {
  target: DescriptionTarget;
  targetName: string;
  targetType: "state" | "burg";
  description: string;  // What will be generated
  userHints: string;    // User-provided hints
  context: {
    geographic?: string;
    culture?: { name: string; summary?: string; traits?: string[]; values?: string[] };
    religion?: { name: string; summary?: string; deity?: string; beliefs?: string[] };
    stateInfo?: { name: string; form: string; population: number };
    burgInfo?: { name: string; population: number; traits: string[] };
  };
};

export type DescriptionResult = {
  success: boolean;
  entityId?: string;
  summary: string;
  error?: string;
};

/**
 * Check if a description meta entity exists for a state or burg
 */
export function getExistingDescription(
  canon: CanonStore,
  target: DescriptionTarget
): CanonEntity | undefined {
  const anchors = "stateId" in target
    ? { stateId: target.stateId }
    : { burgId: target.burgId };

  const descriptions = canon.listEntities({
    type: "meta",
    anchors,
    limit: 10,
  }).filter(e => e.payload?.kind === "description");

  return descriptions[0];
}

/**
 * Plan description generation for a state or burg
 */
export function planDescriptionGeneration(
  hints: string,
  target: DescriptionTarget,
  ctx: GenContext
): DescriptionPlan {
  const isState = "stateId" in target;

  if (isState) {
    const stateId = target.stateId;
    const state = ctx.world.getState(stateId);
    if (!state) {
      throw new Error(`State ${stateId} not found`);
    }

    const stateContext = ctx.world.getStateContext(stateId);

    // Get culture details if generated
    let cultureDetails: DescriptionPlan["context"]["culture"] | undefined;
    if (stateContext?.culture?.id !== undefined) {
      const cultureEntities = ctx.canon.listEntities({
        type: "culture",
        anchors: { cultureId: stateContext.culture.id },
        limit: 1,
      });
      if (cultureEntities.length > 0) {
        const ce = cultureEntities[0];
        cultureDetails = {
          name: ce.name,
          summary: ce.summary || undefined,
          traits: ce.payload?.traits as string[] | undefined,
          values: ce.payload?.values as string[] | undefined,
        };
      } else if (stateContext.culture.name) {
        cultureDetails = { name: stateContext.culture.name };
      }
    }

    // Get religion details if generated
    let religionDetails: DescriptionPlan["context"]["religion"] | undefined;
    const dominantReligion = ctx.world.getStateDominantReligion(stateId);
    if (dominantReligion) {
      const religionEntities = ctx.canon.listEntities({
        type: "religion",
        limit: 100,
      }).filter(e => e.anchors?.azgaarReligionId === dominantReligion.id);
      if (religionEntities.length > 0) {
        const re = religionEntities[0];
        religionDetails = {
          name: re.name,
          summary: re.summary || undefined,
          deity: re.payload?.deity as string | undefined,
          beliefs: (re.payload?.beliefs as string[] | undefined)?.slice(0, 3),
        };
      } else {
        religionDetails = { name: dominantReligion.name };
      }
    }

    const burgs = ctx.world.listBurgs().filter(b => b.state === stateId);
    const totalPop = burgs.reduce((sum, b) => sum + (b.population ?? b.pop ?? 0), 0);

    return {
      target,
      targetName: state.name,
      targetType: "state",
      description: `Generate atmospheric description for ${state.name}`,
      userHints: hints,
      context: {
        stateInfo: {
          name: state.name,
          form: stateContext?.formName || stateContext?.form || "unknown",
          population: totalPop,
        },
        culture: cultureDetails,
        religion: religionDetails,
      },
    };
  } else {
    const burgId = target.burgId;
    const burg = ctx.world.getBurg(burgId);
    if (!burg) {
      throw new Error(`Burg ${burgId} not found`);
    }

    // Always get geographic context for burgs
    const geoContext = ctx.world.getBurgGeographicContext(burgId);

    // Get culture details if generated
    let cultureDetails: DescriptionPlan["context"]["culture"] | undefined;
    if (typeof burg.culture === "number") {
      const cultureEntities = ctx.canon.listEntities({
        type: "culture",
        anchors: { cultureId: burg.culture },
        limit: 1,
      });
      if (cultureEntities.length > 0) {
        const ce = cultureEntities[0];
        cultureDetails = {
          name: ce.name,
          summary: ce.summary || undefined,
          traits: ce.payload?.traits as string[] | undefined,
          values: ce.payload?.values as string[] | undefined,
        };
      } else {
        const culture = ctx.world.getCulture(burg.culture);
        if (culture) {
          cultureDetails = { name: culture.name };
        }
      }
    }

    // Get religion details from cell
    let religionDetails: DescriptionPlan["context"]["religion"] | undefined;
    const cell = typeof burg.cell === "number" ? ctx.world.getCell(burg.cell) : undefined;
    if (cell?.religionId !== undefined) {
      const religionEntities = ctx.canon.listEntities({
        type: "religion",
        limit: 100,
      }).filter(e => e.anchors?.azgaarReligionId === cell.religionId);
      if (religionEntities.length > 0) {
        const re = religionEntities[0];
        religionDetails = {
          name: re.name,
          summary: re.summary || undefined,
          deity: re.payload?.deity as string | undefined,
          beliefs: (re.payload?.beliefs as string[] | undefined)?.slice(0, 3),
        };
      } else {
        const religion = ctx.world.getReligion(cell.religionId);
        if (religion) {
          religionDetails = { name: religion.name };
        }
      }
    }

    const traits: string[] = [];
    if (burg.capital) traits.push("Capital");
    if (burg.port) traits.push("Port");

    return {
      target,
      targetName: burg.name,
      targetType: "burg",
      description: `Generate atmospheric description for ${burg.name}`,
      userHints: hints,
      context: {
        geographic: geoContext || undefined,
        burgInfo: {
          name: burg.name,
          population: burg.population ?? burg.pop ?? 0,
          traits,
        },
        culture: cultureDetails,
        religion: religionDetails,
      },
    };
  }
}

/**
 * Execute description generation and store as meta entity
 */
export async function executeDescriptionGeneration(
  plan: DescriptionPlan,
  ctx: GenContext
): Promise<DescriptionResult> {
  const genLlm = ctx.generationLlm || ctx.llm;
  const isState = plan.targetType === "state";
  const nowIso = () => new Date().toISOString();

  // Build the prompt based on target type
  let systemPrompt: string;
  let userPrompt: string;

  if (isState) {
    systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate an evocative, atmospheric description for a state/kingdom that can be used for GM reference.

Output ONLY valid JSON:
{
  "summary": "One-line atmospheric tagline (max 100 chars)",
  "details_md": "2-3 paragraphs of rich descriptive text covering the land, its people, and character",
  "payload": {
    "atmosphere": "Overall mood and feel (1-2 sentences)",
    "politicalClimate": "Current political situation and tensions",
    "notableFeatures": ["3-5 distinctive characteristics"],
    "history": "Brief historical note that shapes current identity",
    "currentAffairs": "What's happening now that visitors would notice"
  }
}

IMPORTANT:
- Focus on evocative, sensory details a GM can use
- Consider how the culture and religion shape daily life
- Include hooks for adventure or intrigue
- Keep the summary punchy and memorable`;

    userPrompt = JSON.stringify({
      state: plan.context.stateInfo,
      culture: plan.context.culture,
      religion: plan.context.religion,
      userHints: plan.userHints || null,
    });
  } else {
    systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate an evocative, atmospheric description for a town/city that can be used for GM reference.

Output ONLY valid JSON:
{
  "summary": "One-line atmospheric tagline (max 100 chars)",
  "details_md": "2-3 paragraphs of rich descriptive text covering the settlement's character",
  "payload": {
    "atmosphere": "Overall mood and feel (1-2 sentences)",
    "notableLandmarks": ["3-5 distinctive features or buildings"],
    "dailyLife": "What daily life looks like for residents",
    "localCustoms": "Unique local customs or traditions",
    "reputation": "What the settlement is known for to outsiders"
  }
}

IMPORTANT:
- Focus on evocative, sensory details a GM can use
- Consider the geographic context, culture, and religion
- Include hooks for adventure or intrigue
- Keep the summary punchy and memorable`;

    userPrompt = JSON.stringify({
      burg: plan.context.burgInfo,
      geographic: plan.context.geographic,
      culture: plan.context.culture,
      religion: plan.context.religion,
      userHints: plan.userHints || null,
    });
  }

  try {
    ctx.onEntityStart?.(plan.targetName, 0, 1);
    const startTime = Date.now();

    const { data: result, usage } = await completeJsonWithUsage(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 2000,
      temperature: 0.7,
    }) as { data: any; usage?: TokenUsage };

    const elapsedMs = Date.now() - startTime;

    if (usage && ctx.onTokens) {
      ctx.onTokens(usage);
    }

    // Build anchors based on target type
    const anchors = "stateId" in plan.target
      ? { stateId: plan.target.stateId }
      : { burgId: plan.target.burgId };

    // Create the meta entity
    const entity = ctx.canon.addEntity({
      type: "meta",
      name: `${plan.targetName} Description`,
      summary: result.summary || null,
      details_md: result.details_md || null,
      tags: ["description", plan.targetType],
      anchors,
      payload: {
        kind: "description",
        descriptionType: plan.targetType,
        ...result.payload,
      },
      provenance: {
        generated_by: "azbrowse",
        provider: genLlm.provider,
        model: genLlm.model,
        reason: `User requested ${plan.targetType} description`,
        user_prompt: plan.userHints || undefined,
        approved_at: nowIso(),
      },
    });

    ctx.onEntityComplete?.(
      { id: entity.id, name: entity.name, type: entity.type },
      0,
      1,
      usage?.totalTokens ?? 0,
      elapsedMs
    );

    return {
      success: true,
      entityId: entity.id,
      summary: `Created description for ${plan.targetName}`,
    };
  } catch (e: any) {
    return {
      success: false,
      summary: `Failed to generate description: ${e?.message || String(e)}`,
      error: e?.message || String(e),
    };
  }
}

/**
 * Format a description plan for user approval display
 */
export function formatDescriptionPlanForApproval(plan: DescriptionPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}Description Generation Plan${RESET}`);
  if (plan.userHints) {
    lines.push(`${DIM}Hints: ${plan.userHints}${RESET}`);
  }
  lines.push("");

  // Target info
  const icon = plan.targetType === "state" ? "🏛️" : "🏘️";
  lines.push(`${BOLD}Target:${RESET} ${icon} ${GREEN}${plan.targetName}${RESET} (${plan.targetType})`);
  lines.push("");

  // Context
  lines.push(`${BOLD}Context:${RESET}`);
  if (plan.context.stateInfo) {
    lines.push(`  Government: ${plan.context.stateInfo.form}`);
    lines.push(`  Population: ${plan.context.stateInfo.population.toLocaleString()}`);
  }
  if (plan.context.burgInfo) {
    lines.push(`  Population: ${plan.context.burgInfo.population.toLocaleString()}`);
    if (plan.context.burgInfo.traits.length > 0) {
      lines.push(`  Traits: ${plan.context.burgInfo.traits.join(", ")}`);
    }
  }
  if (plan.context.geographic) {
    lines.push(`  ${DIM}Geography: ${plan.context.geographic.slice(0, 80)}...${RESET}`);
  }
  if (plan.context.culture) {
    lines.push(`  Culture: ${YELLOW}${plan.context.culture.name}${RESET}`);
  }
  if (plan.context.religion) {
    lines.push(`  Religion: ${YELLOW}${plan.context.religion.name}${RESET}`);
  }
  lines.push("");

  // Fields to generate
  const fields = plan.targetType === "state"
    ? STATE_DESCRIPTION_FIELDS
    : BURG_DESCRIPTION_FIELDS;
  lines.push(`${BOLD}Will generate:${RESET}`);
  lines.push(`  Core: ${fields.core.join(", ")}`);
  lines.push(`  Details: ${fields.payload.join(", ")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Plan field regeneration for an existing description entity
 */
export function planDescriptionFieldRegeneration(
  entityId: string,
  selectedFields: string[],
  hint: string,
  ctx: GenContext
): FieldRegenPlan {
  const entity = ctx.canon.getEntity(entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  // Determine if this is a state or burg description
  const descType = entity.payload?.descriptionType as "state" | "burg" | undefined;
  const fieldConfig = descType === "state" ? STATE_DESCRIPTION_FIELDS : BURG_DESCRIPTION_FIELDS;

  // Get context based on type
  let burgName: string | undefined;
  if (entity.anchors?.burgId !== undefined) {
    const burg = ctx.world.getBurg(entity.anchors.burgId);
    burgName = burg?.name;
  } else if (entity.anchors?.stateId !== undefined) {
    const state = ctx.world.getState(entity.anchors.stateId);
    burgName = state?.name; // Use state name as "location" for display
  }

  return {
    entityId,
    entityName: entity.name,
    entityType: entity.type,
    description: hint ? `Regenerate fields with hint: "${hint}"` : `Regenerate selected fields`,
    userPrompt: hint || `Regenerate the following fields: ${selectedFields.join(", ")}`,
    selectedFields,
    context: {
      burgId: entity.anchors?.burgId as number | undefined,
      burgName,
      existingEntity: {
        name: entity.name,
        summary: entity.summary,
        details_md: entity.details_md,
        tags: entity.tags,
        payload: entity.payload,
      },
    },
  };
}

// =============================================================================
// RUMOR GENERATION
// =============================================================================

export type RumorPlan = {
  topic: string;
  truthLevel: "false" | "distorted" | "mostly-true" | "true";
  spreadLevel: "whisper" | "local" | "regional" | "widespread";
  sourceType: "gossip" | "observation" | "leak" | "planted" | "unknown";
  burgId: number;
  burgName: string;
  linkedEventId?: string;
  linkedEventName?: string;
  linkedNpcId?: string;
  linkedNpcName?: string;
  hints?: string;
};

/**
 * Plan rumor generation based on context
 */
export function planRumorGeneration(
  topic: string,
  hints: string,
  ctx: GenContext
): RumorPlan {
  const burgId = currentBurgId(ctx.state);
  if (burgId === undefined) {
    throw new Error("Navigate to a burg first to generate rumors");
  }

  const burg = ctx.world.getBurg(burgId);
  if (!burg) {
    throw new Error(`Burg ${burgId} not found`);
  }

  // Parse hints for truth/spread/source
  const hintsLower = hints.toLowerCase();
  let truthLevel: RumorPlan["truthLevel"] = "distorted";
  let spreadLevel: RumorPlan["spreadLevel"] = "local";
  let sourceType: RumorPlan["sourceType"] = "gossip";

  if (hintsLower.includes("true") || hintsLower.includes("accurate")) truthLevel = "true";
  else if (hintsLower.includes("mostly true")) truthLevel = "mostly-true";
  else if (hintsLower.includes("false") || hintsLower.includes("lie")) truthLevel = "false";

  if (hintsLower.includes("widespread") || hintsLower.includes("everywhere")) spreadLevel = "widespread";
  else if (hintsLower.includes("regional") || hintsLower.includes("state")) spreadLevel = "regional";
  else if (hintsLower.includes("whisper") || hintsLower.includes("secret")) spreadLevel = "whisper";

  if (hintsLower.includes("planted") || hintsLower.includes("deliberate")) sourceType = "planted";
  else if (hintsLower.includes("leak")) sourceType = "leak";
  else if (hintsLower.includes("observation") || hintsLower.includes("witness")) sourceType = "observation";

  return {
    topic: topic || "local gossip",
    truthLevel,
    spreadLevel,
    sourceType,
    burgId,
    burgName: burg.name,
    hints: hints || undefined,
  };
}

/**
 * Execute rumor generation
 */
export async function executeRumorGeneration(
  plan: RumorPlan,
  ctx: GenContext
): Promise<{ success: boolean; rumorId?: string; rumorName?: string; summary: string; error?: string }> {
  const genLlm = ctx.generationLlm || ctx.llm;
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const nowIso = () => new Date().toISOString();

  const systemPrompt = `You are a tabletop GM assistant. Generate a rumor for a fantasy city.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
A rumor is something people are saying - it may be true, distorted, or completely false.
The "actualTruth" field is GM-only information about what's really going on.

Output ONLY valid JSON with:
{
  "name": "The rumor as people say it (e.g., 'They say the baron poisoned his wife')",
  "summary": "1-2 sentences of what people claim",
  "details_md": "Fuller version with variations and where you might hear it",
  "tags": ["relevant", "tags"],
  "actualTruth": "GM-only: what's really true behind this rumor"
}`;

  const userPrompt = JSON.stringify({
    topic: plan.topic,
    truthLevel: plan.truthLevel,
    spreadLevel: plan.spreadLevel,
    sourceType: plan.sourceType,
    burg: { id: plan.burgId, name: plan.burgName },
    linkedEvent: plan.linkedEventName ? { id: plan.linkedEventId, name: plan.linkedEventName } : null,
    linkedNpc: plan.linkedNpcName ? { id: plan.linkedNpcId, name: plan.linkedNpcName } : null,
    hints: plan.hints || null,
  });

  try {
    ctx.onEntityStart?.("Rumor", 0, 1);
    const startTime = Date.now();

    const { data: result, usage } = await completeJsonWithUsage(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 1500,
      temperature: 0.8,
    }) as { data: any; usage?: TokenUsage };

    const elapsedMs = Date.now() - startTime;

    if (usage && ctx.onTokens) {
      ctx.onTokens(usage);
    }

    const rumorEntity = ctx.canon.addEntity({
      type: "rumor",
      name: result.name || `Rumor about ${plan.topic}`,
      summary: result.summary || null,
      details_md: result.details_md || null,
      tags: result.tags || [plan.sourceType, plan.spreadLevel],
      anchors: {
        burgId: plan.burgId,
        linkedEventId: plan.linkedEventId,
        linkedNpcId: plan.linkedNpcId,
      },
      payload: {
        truthLevel: plan.truthLevel,
        spreadLevel: plan.spreadLevel,
        sourceType: plan.sourceType,
        actualTruth: result.actualTruth,
      },
      provenance: {
        generated_by: "azbrowse",
        provider: genLlm.provider,
        model: genLlm.model,
        reason: `User requested rumor about: ${plan.topic}`,
        user_prompt: plan.hints || undefined,
        approved_at: nowIso(),
      },
    });

    // Create relations to linked entities
    if (plan.linkedEventId) {
      ctx.canon.addRelation({
        from_id: rumorEntity.id,
        to_id: plan.linkedEventId,
        rel_type: "about",
      });
    }
    if (plan.linkedNpcId) {
      ctx.canon.addRelation({
        from_id: rumorEntity.id,
        to_id: plan.linkedNpcId,
        rel_type: "spread_by",
      });
    }

    const tokens = (usage?.promptTokens || 0) + (usage?.completionTokens || 0);
    ctx.onEntityComplete?.(
      { id: rumorEntity.id, name: rumorEntity.name, type: "rumor" },
      0, 1, tokens, elapsedMs
    );

    return {
      success: true,
      rumorId: rumorEntity.id,
      rumorName: rumorEntity.name,
      summary: `Created rumor: ${rumorEntity.name}`,
    };
  } catch (e: any) {
    return {
      success: false,
      summary: `Failed to generate rumor: ${e?.message || String(e)}`,
      error: e?.message || String(e),
    };
  }
}

/**
 * Format a rumor plan for user approval display
 */
export function formatRumorPlanForApproval(plan: RumorPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  lines.push(`${BOLD}${CYAN}Rumor Generation Plan${RESET}`);
  lines.push("");
  lines.push(`${BOLD}Topic:${RESET} ${GREEN}${plan.topic}${RESET}`);
  lines.push(`${BOLD}Location:${RESET} ${plan.burgName}`);
  lines.push("");
  lines.push(`${BOLD}Properties:${RESET}`);
  lines.push(`  Truth Level: ${YELLOW}${plan.truthLevel}${RESET}`);
  lines.push(`  Spread: ${YELLOW}${plan.spreadLevel}${RESET}`);
  lines.push(`  Source: ${YELLOW}${plan.sourceType}${RESET}`);

  if (plan.linkedEventName) {
    lines.push(`  Linked Event: ${plan.linkedEventName}`);
  }
  if (plan.linkedNpcName) {
    lines.push(`  Linked NPC: ${plan.linkedNpcName}`);
  }
  if (plan.hints) {
    lines.push("");
    lines.push(`${DIM}Hints: ${plan.hints}${RESET}`);
  }
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// HOOK GENERATION
// =============================================================================

export type HookPlan = {
  concept: string;
  hookType: "investigation" | "rescue" | "exploration" | "negotiation" | "combat" | "heist" | "escort" | "delivery" | "mystery" | "social";
  urgency: "background" | "whenever" | "soon" | "urgent" | "critical";
  difficulty: "trivial" | "easy" | "moderate" | "hard" | "deadly";
  rewardType: "gold" | "information" | "favor" | "item" | "reputation" | "mixed";
  burgId: number;
  burgName: string;
  linkedEventId?: string;
  linkedEventName?: string;
  linkedNpcId?: string;
  linkedNpcName?: string;
  linkedFactionId?: string;
  linkedFactionName?: string;
  hints?: string;
};

/**
 * Plan hook generation based on context
 */
export function planHookGeneration(
  concept: string,
  hints: string,
  ctx: GenContext
): HookPlan {
  const burgId = currentBurgId(ctx.state);
  if (burgId === undefined) {
    throw new Error("Navigate to a burg first to generate hooks");
  }

  const burg = ctx.world.getBurg(burgId);
  if (!burg) {
    throw new Error(`Burg ${burgId} not found`);
  }

  // Parse hints for type/urgency/difficulty/reward
  const hintsLower = hints.toLowerCase();
  let hookType: HookPlan["hookType"] = "mystery";
  let urgency: HookPlan["urgency"] = "whenever";
  let difficulty: HookPlan["difficulty"] = "moderate";
  let rewardType: HookPlan["rewardType"] = "mixed";

  // Hook type detection
  if (hintsLower.includes("investigate") || hintsLower.includes("investigation")) hookType = "investigation";
  else if (hintsLower.includes("rescue") || hintsLower.includes("save")) hookType = "rescue";
  else if (hintsLower.includes("explore") || hintsLower.includes("exploration")) hookType = "exploration";
  else if (hintsLower.includes("negotiate") || hintsLower.includes("diplomacy")) hookType = "negotiation";
  else if (hintsLower.includes("combat") || hintsLower.includes("fight") || hintsLower.includes("kill")) hookType = "combat";
  else if (hintsLower.includes("heist") || hintsLower.includes("steal") || hintsLower.includes("theft")) hookType = "heist";
  else if (hintsLower.includes("escort") || hintsLower.includes("protect")) hookType = "escort";
  else if (hintsLower.includes("deliver") || hintsLower.includes("delivery")) hookType = "delivery";
  else if (hintsLower.includes("social") || hintsLower.includes("party") || hintsLower.includes("gala")) hookType = "social";

  // Urgency detection
  if (hintsLower.includes("critical") || hintsLower.includes("emergency")) urgency = "critical";
  else if (hintsLower.includes("urgent") || hintsLower.includes("hurry")) urgency = "urgent";
  else if (hintsLower.includes("soon")) urgency = "soon";
  else if (hintsLower.includes("background") || hintsLower.includes("no rush")) urgency = "background";

  // Difficulty detection
  if (hintsLower.includes("deadly") || hintsLower.includes("impossible")) difficulty = "deadly";
  else if (hintsLower.includes("hard") || hintsLower.includes("difficult")) difficulty = "hard";
  else if (hintsLower.includes("easy") || hintsLower.includes("simple")) difficulty = "easy";
  else if (hintsLower.includes("trivial")) difficulty = "trivial";

  // Reward detection
  if (hintsLower.includes("gold") || hintsLower.includes("money") || hintsLower.includes("pay")) rewardType = "gold";
  else if (hintsLower.includes("information") || hintsLower.includes("secret") || hintsLower.includes("knowledge")) rewardType = "information";
  else if (hintsLower.includes("favor") || hintsLower.includes("alliance")) rewardType = "favor";
  else if (hintsLower.includes("item") || hintsLower.includes("artifact") || hintsLower.includes("weapon")) rewardType = "item";
  else if (hintsLower.includes("reputation") || hintsLower.includes("fame")) rewardType = "reputation";

  return {
    concept: concept || "adventure opportunity",
    hookType,
    urgency,
    difficulty,
    rewardType,
    burgId,
    burgName: burg.name,
    hints: hints || undefined,
  };
}

/**
 * Execute hook generation
 */
export async function executeHookGeneration(
  plan: HookPlan,
  ctx: GenContext
): Promise<{ success: boolean; hookId?: string; hookName?: string; summary: string; error?: string }> {
  const genLlm = ctx.generationLlm || ctx.llm;
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const nowIso = () => new Date().toISOString();

  const systemPrompt = `You are a tabletop GM assistant. Generate an adventure hook for a fantasy TTRPG.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
A hook is a potential quest, job, or adventure that players might pursue.

Output ONLY valid JSON with:
{
  "name": "Catchy hook title (e.g., 'The Merchant's Missing Daughter')",
  "summary": "1-2 sentence player-facing pitch",
  "details_md": "Full GM setup - what's really going on, key NPCs, locations involved",
  "tags": ["relevant", "tags"],
  "rewardDetails": "Specific reward details if applicable",
  "complications": ["2-3 potential twists or complications"],
  "failureConsequences": "What happens if players ignore or fail this hook"
}`;

  const userPrompt = JSON.stringify({
    concept: plan.concept,
    hookType: plan.hookType,
    urgency: plan.urgency,
    difficulty: plan.difficulty,
    rewardType: plan.rewardType,
    burg: { id: plan.burgId, name: plan.burgName },
    linkedEvent: plan.linkedEventName ? { id: plan.linkedEventId, name: plan.linkedEventName } : null,
    linkedNpc: plan.linkedNpcName ? { id: plan.linkedNpcId, name: plan.linkedNpcName } : null,
    linkedFaction: plan.linkedFactionName ? { id: plan.linkedFactionId, name: plan.linkedFactionName } : null,
    hints: plan.hints || null,
  });

  try {
    ctx.onEntityStart?.("Hook", 0, 1);
    const startTime = Date.now();

    const { data: result, usage } = await completeJsonWithUsage(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 2000,
      temperature: 0.8,
    }) as { data: any; usage?: TokenUsage };

    const elapsedMs = Date.now() - startTime;

    if (usage && ctx.onTokens) {
      ctx.onTokens(usage);
    }

    const hookEntity = ctx.canon.addEntity({
      type: "hook",
      name: result.name || `Hook: ${plan.concept}`,
      summary: result.summary || null,
      details_md: result.details_md || null,
      tags: result.tags || [plan.hookType, plan.urgency],
      anchors: {
        burgId: plan.burgId,
        linkedEventId: plan.linkedEventId,
        linkedNpcId: plan.linkedNpcId,
        linkedFactionId: plan.linkedFactionId,
      },
      payload: {
        hookType: plan.hookType,
        urgency: plan.urgency,
        difficulty: plan.difficulty,
        rewardType: plan.rewardType,
        rewardDetails: result.rewardDetails,
        complications: result.complications,
        failureConsequences: result.failureConsequences,
      },
      provenance: {
        generated_by: "azbrowse",
        provider: genLlm.provider,
        model: genLlm.model,
        reason: `User requested hook: ${plan.concept}`,
        user_prompt: plan.hints || undefined,
        approved_at: nowIso(),
      },
    });

    // Create relations to linked entities
    if (plan.linkedEventId) {
      ctx.canon.addRelation({
        from_id: hookEntity.id,
        to_id: plan.linkedEventId,
        rel_type: "caused_by",
      });
    }
    if (plan.linkedNpcId) {
      ctx.canon.addRelation({
        from_id: hookEntity.id,
        to_id: plan.linkedNpcId,
        rel_type: "offered_by",
      });
    }
    if (plan.linkedFactionId) {
      ctx.canon.addRelation({
        from_id: hookEntity.id,
        to_id: plan.linkedFactionId,
        rel_type: "involves",
      });
    }

    const tokens = (usage?.promptTokens || 0) + (usage?.completionTokens || 0);
    ctx.onEntityComplete?.(
      { id: hookEntity.id, name: hookEntity.name, type: "hook" },
      0, 1, tokens, elapsedMs
    );

    return {
      success: true,
      hookId: hookEntity.id,
      hookName: hookEntity.name,
      summary: `Created hook: ${hookEntity.name}`,
    };
  } catch (e: any) {
    return {
      success: false,
      summary: `Failed to generate hook: ${e?.message || String(e)}`,
      error: e?.message || String(e),
    };
  }
}

/**
 * Format a hook plan for user approval display
 */
export function formatHookPlanForApproval(plan: HookPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  lines.push(`${BOLD}${CYAN}Hook Generation Plan${RESET}`);
  lines.push("");
  lines.push(`${BOLD}Concept:${RESET} ${GREEN}${plan.concept}${RESET}`);
  lines.push(`${BOLD}Location:${RESET} ${plan.burgName}`);
  lines.push("");
  lines.push(`${BOLD}Properties:${RESET}`);
  lines.push(`  Type: ${YELLOW}${plan.hookType}${RESET}`);
  lines.push(`  Urgency: ${YELLOW}${plan.urgency}${RESET}`);
  lines.push(`  Difficulty: ${YELLOW}${plan.difficulty}${RESET}`);
  lines.push(`  Reward: ${YELLOW}${plan.rewardType}${RESET}`);

  if (plan.linkedEventName) {
    lines.push(`  Linked Event: ${plan.linkedEventName}`);
  }
  if (plan.linkedNpcName) {
    lines.push(`  Quest Giver: ${plan.linkedNpcName}`);
  }
  if (plan.linkedFactionName) {
    lines.push(`  Faction: ${plan.linkedFactionName}`);
  }
  if (plan.hints) {
    lines.push("");
    lines.push(`${DIM}Hints: ${plan.hints}${RESET}`);
  }
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// COMPREHENSIVE BURG GENERATION
// =============================================================================

/**
 * Plan comprehensive generation for a burg based on a user hint/theme.
 * Creates interconnected factions, locations, NPCs, rumors, hooks, and events.
 */
export async function planBurgGeneration(
  prompt: string,
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
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);

  // Get culture details if generated
  let cultureDetails: { name: string; summary?: string; traits?: string[]; values?: string[] } | undefined;
  if (typeof burg.culture === "number") {
    const cultureEntities = ctx.canon.listEntities({
      type: "culture",
      anchors: { cultureId: burg.culture },
      limit: 1,
    });
    if (cultureEntities.length > 0) {
      const ce = cultureEntities[0];
      cultureDetails = {
        name: ce.name,
        summary: ce.summary || undefined,
        traits: ce.payload?.traits as string[] | undefined,
        values: ce.payload?.values as string[] | undefined,
      };
    } else {
      const culture = ctx.world.getCulture(burg.culture);
      if (culture) {
        cultureDetails = { name: culture.name };
      }
    }
  }

  // Get religion details from cell
  let religionDetails: { name: string; summary?: string; deity?: string; beliefs?: string[] } | undefined;
  const cell = typeof burg.cell === "number" ? ctx.world.getCell(burg.cell) : undefined;
  if (cell?.religionId !== undefined) {
    const religionEntities = ctx.canon.listEntities({
      type: "religion",
      limit: 100,
    }).filter(e => e.anchors?.azgaarReligionId === cell.religionId);
    if (religionEntities.length > 0) {
      const re = religionEntities[0];
      religionDetails = {
        name: re.name,
        summary: re.summary || undefined,
        deity: re.payload?.deity as string | undefined,
        beliefs: (re.payload?.beliefs as string[] | undefined)?.slice(0, 3),
      };
    } else {
      const religion = ctx.world.getReligion(cell.religionId);
      if (religion) {
        religionDetails = { name: religion.name };
      }
    }
  }

  // Build burg traits
  const burgTraits: string[] = [];
  if (burg.capital) burgTraits.push("Capital");
  if (burg.port) burgTraits.push("Port");

  // Build culture/religion context strings
  let cultureContext = "";
  if (cultureDetails) {
    cultureContext = `\nCULTURE: ${cultureDetails.name}`;
    if (cultureDetails.summary) cultureContext += `\n  Summary: ${cultureDetails.summary}`;
    if (cultureDetails.traits?.length) cultureContext += `\n  Traits: ${cultureDetails.traits.join(", ")}`;
    if (cultureDetails.values?.length) cultureContext += `\n  Values: ${cultureDetails.values.join(", ")}`;
  }

  let religionContext = "";
  if (religionDetails) {
    religionContext = `\nRELIGION: ${religionDetails.name}`;
    if (religionDetails.summary) religionContext += `\n  Summary: ${religionDetails.summary}`;
    if (religionDetails.deity) religionContext += `\n  Deity: ${religionDetails.deity}`;
    if (religionDetails.beliefs?.length) religionContext += `\n  Beliefs: ${religionDetails.beliefs.join(", ")}`;
  }

  const systemPrompt = `You are planning comprehensive content generation for a burg (city/town) in a fantasy TTRPG world.

USER THEME/HINT: "${prompt}"

BURG CONTEXT:
- Name: ${burg.name}${state ? `, State: ${state.name}` : ""}
- Population: ${burg.population ?? burg.pop ?? "unknown"}
${burgTraits.length > 0 ? `- Traits: ${burgTraits.join(", ")}` : ""}
${cultureContext}
${religionContext}

${campaignContext ? `CAMPAIGN SETTINGS:\n${campaignContext}\n` : ""}
INSTRUCTIONS:
1. Use canon_query to find existing entities in this burg (avoid duplicates and find connection opportunities)
2. Use canon_getActiveEvents to understand current situation
3. Use world_getBurgDetails for additional burg context
4. Plan entities that weave together the user's theme/hint with the burg's character

TARGET ENTITY MIX (adjust based on theme complexity):
- Factions: 1-2 (central to the theme + optional opposing/allied faction)
- Locations: 2-4 (primary faction base + public locations with hooks)
- NPCs: 4-8 (faction members, townsfolk, allies/informants)
- Rumors: 2-4 (mix of truth levels, link to events/NPCs)
- Hooks: 1-3 (investigation, rescue, faction quests)
- Events: 0-1 (if relevant - disappearances, rituals, etc)

CONNECTION REQUIREMENTS:
- Every NPC should have a location (connectsTo with rel "located_at")
- Faction NPCs should have faction membership (connectsTo with rel "member_of" or "leads")
- Rumors should reference events or NPCs (connectsTo with rel "about")
- Hooks should involve factions/events (connectsTo with rel "involves" or "caused_by")
- New entities connecting to other new entities should have isNew: true
- Entities connecting to existing entities should have isExisting: true

ENTITY TYPES AND KINDS:
- location: tavern, temple, market, hideout, mansion, warehouse, guild hall, shrine, etc.
- npc: (no kind needed)
- faction: guild, cult, gang, order, council, family, etc.
- rumor: (kind determined by truthLevel/spreadLevel in payload)
- hook: investigation, rescue, exploration, negotiation, combat, heist, escort, delivery, mystery, social
- event: (scope: local/city/regional, severity: minor/moderate/major/critical)

Call submit_plan with all planned entities when ready.`;

  const userMessage = `Theme: ${prompt}

Current burg: ${burg.name} (ID: ${burgId})${state ? `, State: ${state.name}` : ""}

Start by querying for existing entities in this burg, then check active events, then submit your comprehensive plan.`;

  const llm = ctx.llm;
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  // Run the planning agent loop
  let plan: GenPlan | null = null;
  let iterations = 0;
  const maxIterations = 6;

  while (!plan && iterations < maxIterations) {
    iterations++;

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: PLANNING_TOOLS,
      toolChoice: iterations === maxIterations ? "required" : "auto",
      maxTokens: 4000,
      temperature: 0.4,
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

      const toolResult = await executePlanningTool(tc.name, tc.arguments, ctx);

      if (ctx.onToolResult) {
        ctx.onToolResult(tc.name, toolResult, Date.now() - startTime);
      }

      // Check if this is the plan submission
      if (toolResult?._isPlan) {
        // Check for parse errors
        if (toolResult.entities.length === 0 && toolResult.parseError) {
          throw new Error(`LLM produced invalid JSON in plan: ${toolResult.parseError}`);
        }

        const activeEvents = ctx.canon.getActiveEvents({ burgId, recencyDays: 90 });
        const existingEntities = ctx.canon.listEntities({
          anchors: { burgId },
          limit: 50,
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
            existingEntities: existingEntities.map((e: CanonEntity) => `${e.name} (${e.type})`),
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
    // Fallback: create a minimal plan
    plan = {
      description: `Generate content for ${burg.name} based on theme: ${prompt}`,
      userPrompt: prompt,
      entities: [{
        type: "location",
        name: "New Location",
        kind: "tavern",
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
 * Format a burg generation plan for user approval display.
 * Groups entities by type for clear overview.
 */
export function formatBurgPlanForApproval(plan: GenPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const MAGENTA = useColors ? "\x1b[35m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}=== Burg Generation Plan ===${RESET}`);
  lines.push(`${DIM}Theme: ${plan.userPrompt}${RESET}`);
  lines.push(`${DIM}Location: ${plan.context.burgName}${plan.context.stateName ? ` (${plan.context.stateName})` : ""}${RESET}`);
  lines.push("");

  // Group entities by type
  const byType: Record<string, EntityPlan[]> = {};
  for (const entity of plan.entities) {
    if (!byType[entity.type]) byType[entity.type] = [];
    byType[entity.type].push(entity);
  }

  // Display order and icons
  const typeOrder: Array<{ type: string; icon: string; label: string }> = [
    { type: "faction", icon: "🏛️", label: "FACTIONS" },
    { type: "location", icon: "📍", label: "LOCATIONS" },
    { type: "npc", icon: "👤", label: "NPCS" },
    { type: "event", icon: "⚡", label: "EVENTS" },
    { type: "rumor", icon: "💬", label: "RUMORS" },
    { type: "hook", icon: "🎣", label: "HOOKS" },
  ];

  for (const { type, icon, label } of typeOrder) {
    const entities = byType[type];
    if (!entities || entities.length === 0) continue;

    lines.push(`${BOLD}${label}${RESET} (${entities.length}):`);
    for (const entity of entities) {
      const kindStr = entity.kind ? `: ${entity.kind}` : "";
      lines.push(`  ${icon} ${GREEN}${entity.name}${RESET}${kindStr}`);
      lines.push(`     ${DIM}"${entity.reason}"${RESET}`);

      // Show connections
      for (const conn of entity.connectsTo) {
        const marker = conn.isNew ? `${MAGENTA}[new]${RESET}` : conn.isExisting ? `${YELLOW}[existing]${RESET}` : "";
        lines.push(`     └─ ${conn.rel}: ${conn.name} ${marker}`);
      }
    }
    lines.push("");
  }

  // Context section
  if (plan.context.activeEvents.length > 0) {
    lines.push(`${DIM}Active events: ${plan.context.activeEvents.slice(0, 3).join(", ")}${RESET}`);
  }
  if (plan.context.existingEntities.length > 0) {
    lines.push(`${DIM}Existing entities: ${plan.context.existingEntities.slice(0, 5).join(", ")}${plan.context.existingEntities.length > 5 ? "..." : ""}${RESET}`);
  }

  // Summary
  const totalEntities = plan.entities.length;
  lines.push("");
  lines.push(`${BOLD}Total: ${totalEntities} entities to create${RESET}`);
  lines.push("");

  return lines.join("\n");
}
