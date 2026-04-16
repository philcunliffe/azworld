import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity, EntityType } from "../canon/canon";
import { initializeEventAwareness, propagateAwareness } from "../canon/awareness";
import { LLMClient, ToolDefinition, ChatMessage } from "../llm/providers";
import { CampaignSettings } from "../chat/schema";
import { formatSettingsForGeneration } from "../chat/campaign-settings";
import { BrowseState, currentRef, stackToPath } from "./state";
import { nowIso } from "../util/time";
import type { ModFieldChange } from "./gen-agent";

const WORLD_CLOCK_ENTITY_NAME = "world-clock";

export type SimulationRelationPlan = {
  relType: string;
  targetId?: string;
  targetKey?: string;
  direction?: "outgoing" | "incoming";
};

export type SimulationCreatePlan = {
  key: string;
  type: EntityType;
  name: string;
  summary?: string | null;
  details_md?: string | null;
  tags?: string[];
  anchors?: Record<string, any>;
  payload?: Record<string, any>;
  reason: string;
  relations?: SimulationRelationPlan[];
};

export type SimulationUpdatePlan = {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  reason: string;
  changes: ModFieldChange[];
};

export type WorldClock = {
  entityId?: string;
  currentDay: number;
  startedAt?: string;
  lastAdvancedAt?: string;
};

export type SimulationPlan = {
  days: number;
  currentDay: number;
  newDay: number;
  description: string;
  userPrompt: string;
  automaticEffects: string[];
  updates: SimulationUpdatePlan[];
  creates: SimulationCreatePlan[];
  context: {
    currentPath: string;
    currentRefKind: string;
  };
};

export type SimulationResult = {
  success: boolean;
  summary: string;
  createdEntities: Array<{ id: string; name: string; type: EntityType }>;
  updatedEntities: Array<{ id: string; name: string; type: EntityType }>;
  error?: string;
};

export type SimulationContext = {
  state: BrowseState;
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;
  campaignSettings?: CampaignSettings;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onTokens?: (usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) => void;
};

const AUTOMATIC_EFFECTS = [
  "Advance the persistent world clock.",
  "Increase `event.payload.daysAgo` for all canon events.",
  "Increase `rumor.payload.ageDays` for all canon rumors.",
  "Refresh event awareness propagation metadata after time advances.",
];

const SIMULATION_TOOLS: ToolDefinition[] = [
  {
    name: "get_world_clock",
    description: "Get the current in-world day counter.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "world_list_states",
    description: "List states in the world.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of states to return" },
      },
      required: [],
    },
  },
  {
    name: "world_list_burgs",
    description: "List burgs, optionally filtered to a state.",
    parameters: {
      type: "object",
      properties: {
        stateId: { type: "number", description: "Optional state id" },
        limit: { type: "number", description: "Maximum number of burgs to return" },
      },
      required: [],
    },
  },
  {
    name: "world_get_burg",
    description: "Get detailed information about one burg.",
    parameters: {
      type: "object",
      properties: {
        burgId: { type: "number", description: "Burg id" },
      },
      required: ["burgId"],
    },
  },
  {
    name: "canon_query",
    description: "Search canon entities by type, text, and optional burg/state anchor.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Entity type" },
        text: { type: "string", description: "Text search in name/summary/details" },
        burgId: { type: "number", description: "Optional burg id filter" },
        stateId: { type: "number", description: "Optional state id filter" },
        limit: { type: "number", description: "Maximum results" },
      },
      required: [],
    },
  },
  {
    name: "canon_get_entity",
    description: "Fetch one canon entity with full structured payload.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Entity id" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "canon_get_relations",
    description: "Fetch relations for one canon entity.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Entity id" },
        limit: { type: "number", description: "Maximum results" },
      },
      required: ["entityId"],
    },
  },
  {
    name: "canon_get_active_events",
    description: "Get active events affecting a burg or state.",
    parameters: {
      type: "object",
      properties: {
        burgId: { type: "number", description: "Optional burg id" },
        stateId: { type: "number", description: "Optional state id" },
        recencyDays: { type: "number", description: "Optional recency filter" },
      },
      required: [],
    },
  },
  {
    name: "submit_simulation_plan",
    description: "Submit the final simulation plan. `updates` and `creates` may be arrays or JSON strings.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "What changes and why" },
        updates: { type: "string", description: "JSON array of update objects" },
        creates: { type: "string", description: "JSON array of create objects" },
      },
      required: ["description"],
    },
  },
];

function parseFlexibleArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

function getSimulationLlm(ctx: SimulationContext): LLMClient {
  return ctx.generationLlm || ctx.llm;
}

export function getWorldClock(canon: CanonStore): WorldClock {
  const meta = canon.listEntities({ type: "meta", limit: 200 }).find((entity) => entity.name === WORLD_CLOCK_ENTITY_NAME);
  if (!meta) {
    return { currentDay: 0 };
  }

  return {
    entityId: meta.id,
    currentDay: typeof meta.payload?.currentDay === "number" ? meta.payload.currentDay : 0,
    startedAt: typeof meta.payload?.startedAt === "string" ? meta.payload.startedAt : undefined,
    lastAdvancedAt: typeof meta.payload?.lastAdvancedAt === "string" ? meta.payload.lastAdvancedAt : undefined,
  };
}

function saveWorldClock(canon: CanonStore, clock: WorldClock): void {
  const payload = {
    kind: "world-clock",
    currentDay: clock.currentDay,
    startedAt: clock.startedAt || nowIso(),
    lastAdvancedAt: clock.lastAdvancedAt || nowIso(),
  };

  if (clock.entityId) {
    canon.patchEntity(clock.entityId, { payload, meta: { updatedAt: nowIso() } });
    return;
  }

  canon.addEntity({
    type: "meta",
    name: WORLD_CLOCK_ENTITY_NAME,
    summary: "Persistent in-world day counter for simulation",
    tags: ["system", "simulation"],
    payload,
    provenance: { source: "simulation", intent: "Track world time" },
  });
}

export function formatWorldClock(clock: WorldClock): string {
  const lines = [`World day: ${clock.currentDay}`];
  if (clock.lastAdvancedAt) {
    lines.push(`Last advanced: ${clock.lastAdvancedAt}`);
  }
  return lines.join("\n");
}

async function executeSimulationTool(
  name: string,
  args: Record<string, any>,
  ctx: SimulationContext
): Promise<any> {
  switch (name) {
    case "get_world_clock":
      return getWorldClock(ctx.canon);

    case "world_list_states": {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      return ctx.world.listStates().slice(0, limit).map((state) => ({
        id: state.id,
        name: state.name,
        form: state.formName ?? state.form,
        population: state.population,
      }));
    }

    case "world_list_burgs": {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const stateId = Number.isFinite(Number(args.stateId)) ? Number(args.stateId) : undefined;
      const burgs = ctx.world.listBurgs().filter((burg) => stateId === undefined || burg.state === stateId);
      return burgs.slice(0, limit).map((burg) => ({
        id: burg.id,
        name: burg.name,
        stateId: burg.state,
        population: burg.population ?? burg.pop,
        capital: burg.capital,
        port: burg.port,
      }));
    }

    case "world_get_burg": {
      const burgId = Number(args.burgId);
      const burg = ctx.world.getBurg(burgId);
      if (!burg) return { error: `Burg ${burgId} not found` };
      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;
      return {
        id: burg.id,
        name: burg.name,
        population: burg.population ?? burg.pop,
        capital: burg.capital,
        port: burg.port,
        x: burg.x,
        y: burg.y,
        state: state
          ? { id: state.id, name: state.name, form: state.formName ?? state.form }
          : null,
      };
    }

    case "canon_query": {
      const anchors: Record<string, any> = {};
      if (Number.isFinite(Number(args.burgId))) anchors.burgId = Number(args.burgId);
      if (Number.isFinite(Number(args.stateId))) anchors.stateId = Number(args.stateId);
      const entities = ctx.canon.listEntities({
        type: args.type as EntityType | undefined,
        text: typeof args.text === "string" ? args.text : undefined,
        anchors: Object.keys(anchors).length ? anchors : undefined,
        limit: Math.max(1, Math.min(100, Number(args.limit) || 20)),
      });
      return entities.map((entity) => ({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        summary: entity.summary,
        tags: entity.tags,
        anchors: entity.anchors,
        payload: entity.payload,
      }));
    }

    case "canon_get_entity": {
      const entity = ctx.canon.getEntity(String(args.entityId));
      if (!entity) return { error: `Entity ${String(args.entityId)} not found` };
      return entity;
    }

    case "canon_get_relations": {
      const entityId = String(args.entityId);
      const relations = ctx.canon.listRelations({ entity_id: entityId, limit: Math.max(1, Math.min(100, Number(args.limit) || 20)) });
      return relations.map((relation) => {
        const otherId = relation.from_id === entityId ? relation.to_id : relation.from_id;
        const other = ctx.canon.getEntity(otherId);
        return {
          ...relation,
          otherEntity: other ? { id: other.id, type: other.type, name: other.name } : null,
        };
      });
    }

    case "canon_get_active_events": {
      const burgId = Number.isFinite(Number(args.burgId)) ? Number(args.burgId) : undefined;
      const stateId = Number.isFinite(Number(args.stateId)) ? Number(args.stateId) : undefined;
      const recencyDays = Math.max(1, Math.min(3650, Number(args.recencyDays) || 120));
      const events = ctx.canon.getActiveEvents({ burgId, stateId, recencyDays });
      return events.map((event) => ({
        id: event.id,
        name: event.name,
        summary: event.summary,
        anchors: event.anchors,
        payload: event.payload,
      }));
    }

    case "submit_simulation_plan":
      return {
        _isSimulationPlan: true,
        description: typeof args.description === "string" ? args.description : "Advance the world state",
        updates: parseFlexibleArray<SimulationUpdatePlan>(args.updates),
        creates: parseFlexibleArray<SimulationCreatePlan>(args.creates),
      };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export async function planSimulation(
  days: number,
  prompt: string,
  ctx: SimulationContext
): Promise<SimulationPlan> {
  const llm = getSimulationLlm(ctx);
  const clock = getWorldClock(ctx.canon);
  const path = stackToPath(ctx.state, ctx.world, ctx.canon);
  const ref = currentRef(ctx.state);
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      `Advance the setting by ${days} in-world day(s).`,
      prompt ? `User focus: ${prompt}` : "User focus: general world progression.",
      `Current in-world day: ${clock.currentDay}.`,
      `Current browse path: ${path}.`,
      "",
      "Automatic system effects are handled outside your plan:",
      ...AUTOMATIC_EFFECTS.map((line) => `- ${line}`),
      "",
      "Your job is to propose the narrative consequences that should happen because time passed.",
      "Prefer changes driven by faction goals, rumors maturing, and events escalating or cooling off.",
      "When factions have long-term goals, update goalProgress instead of resolving everything in one jump unless the evidence supports it.",
      "Keep the plan coherent and modest unless the context strongly justifies more.",
    ].join("\n"),
  }];

  const systemPrompt = `You are a world simulation planner for a fantasy tabletop setting.

Use the available tools to inspect the world and canon before proposing changes.
Your output must be grounded in the existing world state.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Rules:
- The map layer is immutable. Only propose canon changes.
- Automatic bookkeeping is already handled separately, so do not include blanket day counter updates for every event or rumor.
- Favor 0-4 entity updates and 0-4 new entities.
- Updates must contain exact field changes with reasons.
- New entities must be complete enough to persist immediately.
- Faction goal state lives in payload.goals and payload.goalProgress. Prefer partial progress over abrupt completion for long-term schemes.
- If you create events, include structured payload fields: kind, scope, severity, scale, secrecy, audience, daysAgo, ongoing.
- If you create rumors, include structured payload fields: truthLevel, spreadLevel, sourceType, secrecy, ageDays, actualTruth.
- Use relations when they add meaning, especially faction -> event and rumor -> event.

You MUST finish by calling submit_simulation_plan.`;

  let plan: SimulationPlan | null = null;
  let iterations = 0;

  while (!plan && iterations < 8) {
    iterations++;

    const result = await llm.complete({
      system: systemPrompt,
      messages,
      tools: SIMULATION_TOOLS,
      toolChoice: iterations === 8 ? "required" : "auto",
      maxTokens: 2500,
      temperature: 0.5,
    });

    if (result.usage && ctx.onTokens) {
      ctx.onTokens(result.usage);
    }

    if (!result.toolCalls?.length) {
      if (result.text) {
        messages.push({ role: "assistant", content: result.text });
      }
      continue;
    }

    messages.push({
      role: "assistant",
      content: result.text || "",
      toolCalls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      ctx.onToolCall?.(toolCall.name, toolCall.arguments);
      const startedAt = Date.now();
      const toolResult = await executeSimulationTool(toolCall.name, toolCall.arguments, ctx);
      ctx.onToolResult?.(toolCall.name, toolResult, Date.now() - startedAt);

      if (toolResult?._isSimulationPlan) {
        plan = {
          days,
          currentDay: clock.currentDay,
          newDay: clock.currentDay + days,
          description: toolResult.description,
          userPrompt: prompt,
          automaticEffects: [...AUTOMATIC_EFFECTS],
          updates: Array.isArray(toolResult.updates) ? toolResult.updates : [],
          creates: Array.isArray(toolResult.creates) ? toolResult.creates : [],
          context: {
            currentPath: path,
            currentRefKind: ref.kind,
          },
        };
        break;
      }

      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        toolCallId: toolCall.id,
      });
    }
  }

  if (!plan) {
    throw new Error("Failed to create a simulation plan");
  }

  return plan;
}

function ageWorldState(canon: CanonStore, world: AzgaarWorld, days: number, newDay: number): void {
  const events = canon.listEntities({ type: "event", limit: 5000 });
  for (const event of events) {
    const currentDaysAgo = typeof event.payload?.daysAgo === "number" ? event.payload.daysAgo : 0;
    const updated = canon.patchEntity(event.id, {
      payload: {
        daysAgo: currentDaysAgo + days,
        lastSimulatedDay: newDay,
      },
      meta: {
        lastSimulatedAt: nowIso(),
      },
    });

    if (updated) {
      propagateAwareness({
        event: updated,
        world,
        canon,
        currentDay: newDay,
      });
    }
  }

  const rumors = canon.listEntities({ type: "rumor", limit: 5000 });
  for (const rumor of rumors) {
    const currentAge = typeof rumor.payload?.ageDays === "number" ? rumor.payload.ageDays : 0;
    canon.patchEntity(rumor.id, {
      payload: {
        ageDays: currentAge + days,
        lastSimulatedDay: newDay,
      },
      meta: {
        lastSimulatedAt: nowIso(),
      },
    });
  }
}

export async function executeSimulationPlan(
  plan: SimulationPlan,
  ctx: SimulationContext
): Promise<SimulationResult> {
  const createdEntities: Array<{ id: string; name: string; type: EntityType }> = [];
  const updatedEntities: Array<{ id: string; name: string; type: EntityType }> = [];
  const createdByKey = new Map<string, CanonEntity>();

  try {
    ageWorldState(ctx.canon, ctx.world, plan.days, plan.newDay);

    const clock = getWorldClock(ctx.canon);
    saveWorldClock(ctx.canon, {
      entityId: clock.entityId,
      currentDay: plan.newDay,
      startedAt: clock.startedAt || nowIso(),
      lastAdvancedAt: nowIso(),
    });

    for (const update of plan.updates) {
      const entity = ctx.canon.getEntity(update.entityId);
      if (!entity) continue;

      const patch: Record<string, any> = {};
      for (const change of update.changes) {
        if (change.field === "payload") {
          patch.payload = { ...entity.payload, ...(change.newValue || {}) };
        } else {
          patch[change.field] = change.newValue;
        }
      }
      patch.meta = {
        ...(patch.meta || {}),
        lastSimulatedAt: nowIso(),
        lastSimulatedDay: plan.newDay,
      };

      const updated = ctx.canon.patchEntity(update.entityId, patch);
      if (updated) {
        updatedEntities.push({ id: updated.id, name: updated.name, type: updated.type });
      }
    }

    for (const create of plan.creates) {
      const entity = ctx.canon.addEntity({
        type: create.type,
        name: create.name,
        summary: create.summary ?? null,
        details_md: create.details_md ?? null,
        tags: create.tags || [],
        anchors: create.anchors || {},
        payload: create.payload || {},
        meta: {
          lastSimulatedAt: nowIso(),
          lastSimulatedDay: plan.newDay,
        },
        provenance: {
          generated_by: "azbrowse-simulation",
          provider: getSimulationLlm(ctx).provider,
          model: getSimulationLlm(ctx).model,
          reason: create.reason,
          simulation_days: plan.days,
          approved_at: nowIso(),
        },
      });
      createdByKey.set(create.key, entity);
      createdEntities.push({ id: entity.id, name: entity.name, type: entity.type });

      if (entity.type === "event") {
        initializeEventAwareness({ event: entity, canon: ctx.canon });
        propagateAwareness({
          event: entity,
          world: ctx.world,
          canon: ctx.canon,
          currentDay: plan.newDay,
        });
      }
    }

    for (const create of plan.creates) {
      const source = createdByKey.get(create.key);
      if (!source || !create.relations?.length) continue;

      for (const relation of create.relations) {
        const target = relation.targetId
          ? ctx.canon.getEntity(relation.targetId)
          : relation.targetKey
            ? createdByKey.get(relation.targetKey)
            : undefined;
        if (!target) continue;

        const direction = relation.direction || "outgoing";
        ctx.canon.addRelation({
          from_id: direction === "incoming" ? target.id : source.id,
          to_id: direction === "incoming" ? source.id : target.id,
          rel_type: relation.relType,
        });
      }
    }

    const parts = [
      `Advanced world time by ${plan.days} day(s), from day ${plan.currentDay} to day ${plan.newDay}.`,
      `${updatedEntities.length} existing entit${updatedEntities.length === 1 ? "y" : "ies"} updated.`,
      `${createdEntities.length} new entit${createdEntities.length === 1 ? "y" : "ies"} created.`,
    ];

    return {
      success: true,
      summary: parts.join(" "),
      createdEntities,
      updatedEntities,
    };
  } catch (error: any) {
    return {
      success: false,
      summary: "Simulation failed",
      createdEntities,
      updatedEntities,
      error: error?.message || String(error),
    };
  }
}

export function formatSimulationPlanForApproval(plan: SimulationPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RED = useColors ? "\x1b[31m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];
  lines.push(`${BOLD}${CYAN}Simulation Plan${RESET}`);
  lines.push(`${DIM}Advance ${plan.days} day(s) from day ${plan.currentDay} to day ${plan.newDay}${RESET}`);
  if (plan.userPrompt) {
    lines.push(`${DIM}Focus: ${plan.userPrompt}${RESET}`);
  }
  lines.push("");
  lines.push(`${BOLD}Summary:${RESET} ${plan.description}`);
  lines.push(`${DIM}Context: ${plan.context.currentPath}${RESET}`);
  lines.push("");

  lines.push(`${BOLD}Automatic Effects:${RESET}`);
  for (const effect of plan.automaticEffects) {
    lines.push(`  ${YELLOW}•${RESET} ${effect}`);
  }
  lines.push("");

  lines.push(`${BOLD}Entity Updates:${RESET}`);
  if (plan.updates.length === 0) {
    lines.push(`  ${DIM}(none)${RESET}`);
  } else {
    for (const update of plan.updates) {
      lines.push(`  ${GREEN}${update.entityName}${RESET} (${update.entityType})`);
      lines.push(`    ${DIM}${update.reason}${RESET}`);
      for (const change of update.changes) {
        lines.push(`    ${YELLOW}${change.field}${RESET}`);
        lines.push(`      ${RED}- ${truncateValue(change.oldValue, 72)}${RESET}`);
        lines.push(`      ${GREEN}+ ${truncateValue(change.newValue, 72)}${RESET}`);
      }
      lines.push("");
    }
  }

  lines.push(`${BOLD}New Entities:${RESET}`);
  if (plan.creates.length === 0) {
    lines.push(`  ${DIM}(none)${RESET}`);
  } else {
    for (const create of plan.creates) {
      lines.push(`  ${GREEN}${create.name}${RESET} (${create.type})`);
      lines.push(`    ${DIM}${create.reason}${RESET}`);
      if (create.summary) {
        lines.push(`    Summary: ${truncateValue(create.summary, 84)}`);
      }
      if (create.tags?.length) {
        lines.push(`    Tags: ${create.tags.join(", ")}`);
      }
      if (create.relations?.length) {
        const relationSummary = create.relations.map((relation) => {
          const target = relation.targetId || relation.targetKey || "?";
          return `${relation.relType} -> ${target}`;
        });
        lines.push(`    Relations: ${relationSummary.join("; ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function truncateValue(value: any, maxLen: number): string {
  if (value === null || value === undefined) return "(empty)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
