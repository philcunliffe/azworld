import { ToolRegistry, ToolContext } from "./index";
import { completeJson } from "../../llm/providers";
import { z } from "zod";
import { ReactionGenerationResultSchema, ReactionCandidateSchema } from "../schema";

// Schemas for generated content
const GeneratedEntitySchema = z.object({
  key: z.string(),
  type: z.enum(["npc", "faction", "location", "event"]),
  name: z.string(),
  summary: z.string().optional(),
  details_md: z.string().optional(),
  tags: z.array(z.string()).optional(),
  payload: z.record(z.any()).optional(),
});

const GeneratedRelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  rel_type: z.string(),
  strength: z.number().optional(),
  notes: z.string().optional(),
});

const LocationGenResultSchema = z.object({
  location: GeneratedEntitySchema,
  npcs: z.array(GeneratedEntitySchema).optional(),
  factions: z.array(GeneratedEntitySchema).optional(),
  relations: z.array(GeneratedRelationSchema).optional(),
  narration: z.string(),
});

const NpcsGenResultSchema = z.object({
  npcs: z.array(GeneratedEntitySchema),
  relations: z.array(GeneratedRelationSchema).optional(),
});

const FactionGenResultSchema = z.object({
  faction: GeneratedEntitySchema,
  relations: z.array(GeneratedRelationSchema).optional(),
});

const EventGenResultSchema = z.object({
  event: GeneratedEntitySchema,
  consequences: z.array(z.object({
    type: z.string(),
    target: z.string().optional(),
    severity: z.string().optional(),
    effect: z.string().optional(),
  })).optional(),
});

const LoreGenResultSchema = z.object({
  subject: z.string(),
  aspect: z.string(),
  content: z.string(),
  relatedTopics: z.array(z.string()).optional(),
});

// JSON schema for location generation
const LOCATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    location: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string" },
        type: { type: "string" },
        name: { type: "string" },
        summary: { type: "string" },
        details_md: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        payload: { type: "object" },
      },
      required: ["key", "type", "name"],
    },
    npcs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          type: { type: "string" },
          name: { type: "string" },
          summary: { type: "string" },
          details_md: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          payload: { type: "object" },
        },
        required: ["key", "type", "name"],
      },
    },
    factions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          type: { type: "string" },
          name: { type: "string" },
          summary: { type: "string" },
          details_md: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          payload: { type: "object" },
        },
        required: ["key", "type", "name"],
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          rel_type: { type: "string" },
          strength: { type: "number" },
          notes: { type: "string" },
        },
        required: ["from", "to", "rel_type"],
      },
    },
    narration: { type: "string" },
  },
  required: ["location", "narration"],
};

function formatEventContext(events: any[]): string {
  if (!events || !events.length) return "";
  const lines = ["ACTIVE EVENTS AFFECTING THIS LOCATION:"];
  for (const e of events) {
    const scope = e.scope || "burg";
    const daysAgo = e.daysAgo ?? "?";
    const severity = e.severity || "unknown";
    lines.push(`- ${e.name} (${scope}-level, ${daysAgo} days ago, ${severity}): ${e.summary || "No details"}`);
  }
  lines.push("", "Generated content should reflect these conditions naturally.");
  return lines.join("\n");
}

export function registerGenerateTools(registry: ToolRegistry): void {
  // generate_location - Generate a place with NPCs
  registry.register(
    "generate_location",
    {
      name: "generate_location",
      description:
        "Generate a location (tavern, guild hall, temple, shop, etc.) with NPCs present. Returns generated content that must be persisted with canon.upsert.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Type of location: tavern, guild-hall, temple, market, shop, warehouse, mansion, slum, etc.",
          },
          burgId: { type: "number", description: "Burg where the location is" },
          hints: { type: "string", description: "Additional creative hints (e.g., 'criminal ties', 'upscale', 'miners guild')" },
          activeEvents: { type: "string", description: "JSON array of active events to incorporate" },
          existingEntities: { type: "string", description: "JSON array of existing entity names to avoid duplicating" },
        },
        required: ["kind", "burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const kind = String(args.kind || "tavern");
      const burgId = Number(args.burgId);

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;

      // Parse active events
      let activeEvents: any[] = [];
      if (args.activeEvents) {
        try {
          activeEvents = JSON.parse(String(args.activeEvents));
        } catch {
          activeEvents = [];
        }
      }

      // Parse existing entities
      let existingNames: string[] = [];
      if (args.existingEntities) {
        try {
          existingNames = JSON.parse(String(args.existingEntities));
        } catch {
          existingNames = [];
        }
      }

      const eventContext = formatEventContext(activeEvents);

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} location for a fantasy city.
Output ONLY valid JSON matching the schema.
Constraints:
- Keep names distinct; avoid these existing names: ${existingNames.slice(0, 50).join(", ") || "(none)"}
- Use vivid but concise details
- Generate 3-6 NPCs present at the location
- Entity keys should be stable identifiers like "location_main", "npc_barkeep"
- NPCs should have varied roles appropriate to the location`;

      const userPrompt = {
        request: { kind, hints: args.hints || null },
        burg: {
          id: burg.id,
          name: burg.name,
          population: burg.population ?? burg.pop,
          stateId: burg.state,
          capital: burg.capital,
          port: burg.port,
        },
        state: state ? { id: state.id, name: state.name, form: state.formName ?? state.form } : null,
        eventContext,
        instructions:
          "Generate a location with NPCs. Include relations like 'npc_X located_at location_main'. " +
          "Narration should be a short GM-facing opening description.",
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        jsonSchema: LOCATION_JSON_SCHEMA,
        maxTokens: 1500,
        temperature: 0.7,
      });

      const parsed = LocationGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result", raw: result };
      }

      return {
        generated: true,
        ...parsed.data,
        anchors: { burgId },
      };
    }
  );

  // generate_npcs - Generate characters
  registry.register(
    "generate_npcs",
    {
      name: "generate_npcs",
      description: "Generate one or more NPCs for a location or burg.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of NPCs to generate (default 3)" },
          burgId: { type: "number", description: "Burg where NPCs are based" },
          locationId: { type: "string", description: "Location entity ID where NPCs will be" },
          roles: { type: "string", description: "Suggested roles (e.g., 'barkeep, guard, merchant')" },
          activeEvents: { type: "string", description: "JSON array of active events to incorporate" },
        },
        required: ["burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const count = Number(args.count) || 3;
      const burgId = Number(args.burgId);

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      let activeEvents: any[] = [];
      if (args.activeEvents) {
        try {
          activeEvents = JSON.parse(String(args.activeEvents));
        } catch {
          activeEvents = [];
        }
      }

      const eventContext = formatEventContext(activeEvents);

      const systemPrompt = `You are a tabletop GM assistant. Generate ${count} NPCs for a fantasy city.
Output ONLY valid JSON with an "npcs" array.`;

      const userPrompt = {
        count,
        burg: { id: burg.id, name: burg.name },
        roles: args.roles || null,
        locationId: args.locationId || null,
        eventContext,
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 1000,
        temperature: 0.7,
      });

      const parsed = NpcsGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result", raw: result };
      }

      return {
        generated: true,
        ...parsed.data,
        anchors: { burgId },
      };
    }
  );

  // generate_faction - Generate an organization
  registry.register(
    "generate_faction",
    {
      name: "generate_faction",
      description: "Generate a faction/organization (guild, criminal ring, religious order, etc.).",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Type: thieves-guild, merchant-guild, religious-order, criminal-syndicate, noble-house, etc.",
          },
          burgId: { type: "number", description: "Burg where faction is based" },
          hints: { type: "string", description: "Additional hints about the faction" },
          activeEvents: { type: "string", description: "JSON array of active events to incorporate" },
        },
        required: ["kind", "burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const kind = String(args.kind);
      const burgId = Number(args.burgId);

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      let activeEvents: any[] = [];
      if (args.activeEvents) {
        try {
          activeEvents = JSON.parse(String(args.activeEvents));
        } catch {
          activeEvents = [];
        }
      }

      const eventContext = formatEventContext(activeEvents);

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} faction.
Output ONLY valid JSON with a "faction" object.`;

      const userPrompt = {
        kind,
        hints: args.hints || null,
        burg: { id: burg.id, name: burg.name },
        eventContext,
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 800,
        temperature: 0.7,
      });

      const parsed = FactionGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result", raw: result };
      }

      return {
        generated: true,
        ...parsed.data,
        anchors: { burgId },
      };
    }
  );

  // generate_event - Generate an event with consequences
  registry.register(
    "generate_event",
    {
      name: "generate_event",
      description: "Generate a world event (disaster, political change, festival, etc.) with scope and consequences.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Event type: earthquake, assassination, festival, plague, war, coronation, etc.",
          },
          scope: {
            type: "string",
            description: "Geographic scope: neighborhood, burg, state, region, world",
            enum: ["neighborhood", "burg", "state", "region", "world"],
          },
          severity: {
            type: "string",
            description: "Severity: minor, moderate, major, catastrophic",
            enum: ["minor", "moderate", "major", "catastrophic"],
          },
          burgId: { type: "number", description: "Burg where event is centered (if applicable)" },
          stateId: { type: "number", description: "State where event is centered (if applicable)" },
          daysAgo: { type: "number", description: "How many days ago the event occurred (0 for ongoing)" },
          hints: { type: "string", description: "Additional creative hints" },
        },
        required: ["kind", "scope", "severity"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const kind = String(args.kind);
      const scope = String(args.scope);
      const severity = String(args.severity);
      const daysAgo = typeof args.daysAgo === "number" ? args.daysAgo : 0;

      let context = "";
      if (args.burgId) {
        const burg = ctx.world.getBurg(Number(args.burgId));
        if (burg) context += `Centered on ${burg.name} (burg ${burg.id}). `;
      }
      if (args.stateId) {
        const state = ctx.world.getState(Number(args.stateId));
        if (state) context += `In the state of ${state.name}. `;
      }

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} event.
Output ONLY valid JSON with an "event" object and "consequences" array.`;

      const userPrompt = {
        kind,
        scope,
        severity,
        daysAgo,
        context,
        hints: args.hints || null,
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 600,
        temperature: 0.7,
      });

      const parsed = EventGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result", raw: result };
      }

      // Add event payload fields
      const event = parsed.data.event;
      event.payload = {
        ...event.payload,
        kind,
        scope,
        severity,
        daysAgo,
        ongoing: daysAgo === 0,
        consequences: parsed.data.consequences || [],
      };

      return {
        generated: true,
        event,
        consequences: parsed.data.consequences,
        anchors: {
          burgId: args.burgId ? Number(args.burgId) : undefined,
          stateId: args.stateId ? Number(args.stateId) : undefined,
        },
      };
    }
  );

  // generate_lore - Generate world-building details
  registry.register(
    "generate_lore",
    {
      name: "generate_lore",
      description: "Generate world-building lore (holidays, customs, history, legends).",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Subject to generate lore about" },
          aspect: {
            type: "string",
            description: "Aspect: history, customs, holidays, legends, religion, etc.",
          },
          context: { type: "string", description: "Context (burg name, state, culture)" },
        },
        required: ["subject", "aspect"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const subject = String(args.subject);
      const aspect = String(args.aspect);

      const systemPrompt = `You are a tabletop GM assistant. Generate ${aspect} lore about ${subject}.
Output JSON with: subject, aspect, content (markdown), relatedTopics (array of strings).`;

      const userPrompt = {
        subject,
        aspect,
        context: args.context || null,
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 800,
        temperature: 0.7,
      });

      const parsed = LoreGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result", raw: result };
      }

      return { generated: true, ...parsed.data };
    }
  );

  // generate_reaction - Generate faction/state responses to events
  registry.register(
    "generate_reaction",
    {
      name: "generate_reaction",
      description:
        "Generate potential reactions an actor (faction, NPC, burg, state) might have to an event. Returns 3-5 candidate reactions to choose from.",
      parameters: {
        type: "object",
        properties: {
          actorType: {
            type: "string",
            description: "Actor type: faction, npc, burg, state",
            enum: ["faction", "npc", "burg", "state"],
          },
          actorId: { type: "string", description: "Actor entity ID (for faction/npc) or numeric ID as string (for burg/state)" },
          eventId: { type: "string", description: "Event entity ID" },
          awarenessLevel: {
            type: "string",
            description: "How much the actor knows: rumor, confirmed, intimate",
            enum: ["rumor", "confirmed", "intimate"],
          },
        },
        required: ["actorType", "actorId", "eventId", "awarenessLevel"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const actorType = String(args.actorType);
      const actorId = String(args.actorId);
      const eventId = String(args.eventId);
      const awarenessLevel = String(args.awarenessLevel);

      // Get event details
      const event = ctx.canon.getEntity(eventId);
      if (!event || event.type !== "event") {
        return { error: `Event ${eventId} not found` };
      }

      // Get actor details
      let actorName = "Unknown Actor";
      let actorContext = "";

      if (actorType === "faction" || actorType === "npc") {
        const actor = ctx.canon.getEntity(actorId);
        if (!actor) {
          return { error: `${actorType} ${actorId} not found` };
        }
        actorName = actor.name;
        actorContext = `${actorType.toUpperCase()}: ${actor.name}
Summary: ${actor.summary || "No summary"}
Tags: ${(actor.tags || []).join(", ")}`;
      } else if (actorType === "burg") {
        const burg = ctx.world.getBurg(Number(actorId));
        if (!burg) {
          return { error: `Burg ${actorId} not found` };
        }
        actorName = burg.name;
        actorContext = `CITY: ${burg.name}
Population: ${burg.population || burg.pop || "unknown"}
Capital: ${burg.capital ? "yes" : "no"}
Port: ${burg.port ? "yes" : "no"}`;
      } else if (actorType === "state") {
        const state = ctx.world.getState(Number(actorId));
        if (!state) {
          return { error: `State ${actorId} not found` };
        }
        actorName = state.name;
        actorContext = `STATE: ${state.name}
Form: ${state.formName || state.form || "unknown"}`;
      }

      const eventPayload = event.payload || {};
      const eventContext = `EVENT: ${event.name}
Summary: ${event.summary || "No summary"}
Scope: ${eventPayload.scope || "unknown"}
Severity: ${eventPayload.severity || "unknown"}
Days ago: ${eventPayload.daysAgo ?? 0}
Ongoing: ${eventPayload.ongoing ? "yes" : "no"}`;

      const systemPrompt = `You are a tabletop GM assistant generating NPC/faction reactions to world events.
Generate 3-5 diverse, plausible reactions the actor might have to the event.
Output JSON with: actorName, eventName, candidates (array of reaction objects).

Each candidate should have:
- description: what the actor does
- category: "political", "economic", "social", or "factional"
- intensity: "subtle", "moderate", or "dramatic"
- publiclyVisible: boolean
- creates: array of outcomes (optional) - each with type ("relation", "rumor", "event"), description, and optional targetType/targetId/relationType`;

      const userPrompt = {
        actorContext,
        eventContext,
        awarenessLevel,
        actorType,
        instructions:
          "Generate reactions appropriate to the actor's nature and the event's severity. " +
          "If awareness is 'rumor', reactions should be cautious/uncertain. " +
          "If 'intimate', reactions can be more decisive and dramatic. " +
          "Consider what the actor wants and how the event affects their interests.",
      };

      const result = await completeJson(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 1000,
        temperature: 0.8,
      });

      const parsed = ReactionGenerationResultSchema.safeParse(result);
      if (!parsed.success) {
        // Return raw result if parsing fails
        return {
          generated: true,
          actorName,
          eventName: event.name,
          candidates: result.candidates || [],
          parseWarning: "Could not validate against schema",
        };
      }

      return {
        generated: true,
        ...parsed.data,
      };
    }
  );
}
