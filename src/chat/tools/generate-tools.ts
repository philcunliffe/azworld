import { ToolRegistry, ToolContext } from "./index";
import { completeJson } from "../../llm/providers";
import { z } from "zod";
import {
  ReactionGenerationResultSchema,
  ReactionCandidateSchema,
  RumorTruthLevelEnum,
  RumorSpreadLevelEnum,
  RumorSourceTypeEnum,
  HookTypeEnum,
  HookUrgencyEnum,
  HookDifficultyEnum,
  HookRewardTypeEnum,
  DeityRankEnum,
  EventScaleEnum,
  SecrecyLevelEnum,
} from "../schema";
import { formatSettingsForGeneration } from "../campaign-settings";
import {
  prepareIdeaInjection,
  markIdeasUsedFromOutput,
  logIdeaBreadcrumb,
} from "../../canon/idea-injection";
import { listIdeas } from "../../canon/ideas";
import { levenshtein } from "../../util/fuzzy";

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
  payload: z.object({
    scale: EventScaleEnum.optional(),
    secrecy: SecrecyLevelEnum.optional(),
    audience: z.object({
      public: z.boolean().optional(),
      knownFactionIds: z.array(z.string()).optional(),
      knownNpcIds: z.array(z.string()).optional(),
      knownBurgIds: z.array(z.union([z.number(), z.string()])).optional(),
      knownStateIds: z.array(z.union([z.number(), z.string()])).optional(),
      suspectedByFactionIds: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
});

const LoreGenResultSchema = z.object({
  subject: z.string(),
  aspect: z.string(),
  content: z.string(),
  relatedTopics: z.array(z.string()).optional(),
});

const RumorGenResultSchema = z.object({
  rumor: GeneratedEntitySchema.extend({
    type: z.literal("rumor"),
  }),
  payload: z.object({
    truthLevel: RumorTruthLevelEnum,
    spreadLevel: RumorSpreadLevelEnum,
    sourceType: RumorSourceTypeEnum,
    secrecy: SecrecyLevelEnum.optional(),
    ageDays: z.number().optional(),
    actualTruth: z.string().optional(),
  }),
});

const HookGenResultSchema = z.object({
  hook: GeneratedEntitySchema.extend({
    type: z.literal("hook"),
  }),
  payload: z.object({
    hookType: HookTypeEnum,
    urgency: HookUrgencyEnum,
    difficulty: HookDifficultyEnum,
    rewardType: HookRewardTypeEnum,
    rewardDetails: z.string().optional(),
    complications: z.array(z.string()).optional(),
    failureConsequences: z.string().optional(),
  }),
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
        type: { type: "string", enum: ["location"], description: "Must be 'location'" },
        name: { type: "string" },
        summary: { type: "string" },
        details_md: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        payload: {
          type: "object",
          description: "Location-specific data including: kind (tavern, temple, etc.), briefDescription (3-5 sentences), physicalDescription (detailed sensory description), atmosphere, features",
        },
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
          type: { type: "string", enum: ["npc"], description: "Must be 'npc'" },
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
          type: { type: "string", enum: ["faction"], description: "Must be 'faction'" },
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
    const scale = e.scale ? `, ${e.scale}` : "";
    const secrecy = e.secrecy ? `, ${e.secrecy}` : "";
    lines.push(`- ${e.name} (${scope}-level, ${daysAgo} days ago, ${severity}${scale}${secrecy}): ${e.summary || "No details"}`);
  }
  lines.push("", "Generated content should reflect these conditions naturally.");
  return lines.join("\n");
}

// Helper to get the LLM client for generation (prefers generationLlm if available)
function getGenLlm(ctx: ToolContext) {
  return ctx.generationLlm ?? ctx.llm;
}

export function registerGenerateTools(registry: ToolRegistry): void {
  // generate_location - Generate a place with NPCs and persist to canon
  registry.register(
    "generate_location",
    {
      name: "generate_location",
      description:
        "Generate a location (tavern, guild hall, temple, shop, etc.) with NPCs present. Automatically persists all entities to canon and returns a compact summary.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Type of location: tavern, guild-hall, temple, market, shop, warehouse, mansion, slum, etc.",
          },
          burgId: { type: "number", description: "Burg where the location is" },
          hints: { type: "string", description: "Additional creative hints (e.g., 'criminal ties', 'upscale', 'miners guild')" },
          existingEntities: { type: "string", description: "JSON array of existing entity names to avoid duplicating" },
          reason: { type: "string", description: "Reason/prompt for why this entity is being generated (for provenance)" },
          source: { type: "string", description: "Source application generating this entity (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a specific pending idea from the pool to weave into this generation. Use ideas_lookup or ideas_list first to find IDs." },
        },
        required: ["kind", "burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      console.log("[generate_location] Starting...");
      const kind = String(args.kind || "tavern");
      const burgId = Number(args.burgId);
      console.log(`[generate_location] kind=${kind}, burgId=${burgId}`);

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }
      console.log(`[generate_location] Found burg: ${burg.name}`);

      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;
      const stateId = typeof burg.state === "number" ? burg.state : undefined;

      // Query active events affecting this location
      const activeEvents = ctx.canon.getActiveEvents({
        burgId,
        stateId,
        includeParentScopes: true,
        recencyDays: 90,
      });
      console.log(`[generate_location] Found ${activeEvents.length} active events`);

      // Parse existing entities
      let existingNames: string[] = [];
      if (args.existingEntities) {
        try {
          existingNames = JSON.parse(String(args.existingEntities));
        } catch {
          existingNames = [];
        }
      }

      const eventContext = formatEventContext(activeEvents.map((e) => ({
        name: e.name,
        summary: e.summary,
        scope: e.payload?.scope,
        daysAgo: e.payload?.daysAgo,
        severity: e.payload?.severity,
        scale: e.payload?.scale,
        secrecy: e.payload?.secrecy,
      })));
      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);

      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "location",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [kind, "burg"],
        anchor: {
          burgId,
          tags: [burg.name, state?.name, kind].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} location for a fantasy city.
Output ONLY valid JSON matching the schema.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}Constraints:
- Keep names distinct; avoid these existing names: ${existingNames.slice(0, 50).join(", ") || "(none)"}
- Use vivid but concise details
- Include a brief description (3-5 sentences for quick reference) AND a detailed physical description (rich sensory details - sights, sounds, smells, layout, lighting, notable features)
- Generate 3-6 NPCs present at the location
- Entity keys should be stable identifiers like "location_main", "npc_barkeep"
- NPCs should have varied roles appropriate to the location${ideaInjection.promptAddition}`;

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

      const genLlm = getGenLlm(ctx);
      console.log(`[generate_location] Calling LLM (provider=${genLlm.provider}, model=${genLlm.model})...`);
      const startTime = Date.now();

      try {
        const result = await completeJson(genLlm, {
          system: systemPrompt,
          messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
          jsonSchema: LOCATION_JSON_SCHEMA,
          maxTokens: 4000,
          temperature: 0.7,
        });

        const elapsed = Date.now() - startTime;
        console.log(`[generate_location] LLM returned after ${elapsed}ms`);

        const parsed = LocationGenResultSchema.safeParse(result);
        if (!parsed.success) {
          console.log(`[generate_location] Parse failed: ${parsed.error.message}`);
          return { error: "Failed to parse generation result" };
        }

        const data = parsed.data;
        console.log(`[generate_location] Persisting to canon: ${data.location?.name}`);

        // Persist location to canon
        const locationEntity = ctx.canon.addEntity({
          type: "location",
          name: data.location.name,
          summary: data.location.summary || null,
          details_md: data.location.details_md || null,
          tags: data.location.tags || [kind],
          anchors: { burgId },
          payload: data.location.payload || { kind },
          provenance: {
            generated_by: args.source || "generate_location",
            provider: genLlm.provider,
            model: genLlm.model,
            reason: args.reason || null,
            approved_at: args.reason ? new Date().toISOString() : undefined,
          },
        });

        // Persist NPCs and create relations
        const npcSummaries: Array<{ id: string; name: string; summary: string }> = [];
        const keyToId: Record<string, string> = { [data.location.key]: locationEntity.id };

        for (const npc of data.npcs || []) {
          const npcEntity = ctx.canon.addEntity({
            type: "npc",
            name: npc.name,
            summary: npc.summary || null,
            details_md: npc.details_md || null,
            tags: npc.tags || [],
            anchors: { burgId },
            payload: npc.payload || {},
            provenance: {
              generated_by: args.source || "generate_location",
              provider: genLlm.provider,
              model: genLlm.model,
              reason: args.reason ? `NPC generated as part of ${data.location.name}` : null,
              approved_at: args.reason ? new Date().toISOString() : undefined,
            },
          });
          keyToId[npc.key] = npcEntity.id;
          npcSummaries.push({ id: npcEntity.id, name: npc.name, summary: npc.summary || "" });

          // Create located_at relation
          ctx.canon.addRelation({
            from_id: npcEntity.id,
            to_id: locationEntity.id,
            rel_type: "located_at",
          });
        }

        // Persist factions
        for (const faction of data.factions || []) {
          const factionEntity = ctx.canon.addEntity({
            type: "faction",
            name: faction.name,
            summary: faction.summary || null,
            details_md: faction.details_md || null,
            tags: faction.tags || [],
            anchors: { burgId },
            payload: faction.payload || {},
            provenance: {
              generated_by: args.source || "generate_location",
              provider: genLlm.provider,
              model: genLlm.model,
              reason: args.reason ? `Faction generated as part of ${data.location.name}` : null,
              approved_at: args.reason ? new Date().toISOString() : undefined,
            },
          });
          keyToId[faction.key] = factionEntity.id;
        }

        // Create additional relations
        for (const rel of data.relations || []) {
          const fromId = keyToId[rel.from];
          const toId = keyToId[rel.to];
          if (fromId && toId && rel.rel_type !== "located_at") {
            ctx.canon.addRelation({
              from_id: fromId,
              to_id: toId,
              rel_type: rel.rel_type,
              strength: rel.strength,
              notes: rel.notes,
            });
          }
        }

        // Update session state
        ctx.state.currentLocationId = locationEntity.id;
        ctx.state.currentBurgId = burgId;

        const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, locationEntity.id, ideaInjection.candidateIds);
        logIdeaBreadcrumb("generate_location", ideaInjection.candidateIds, usedIdeas);

        console.log(`[generate_location] Persisted: 1 location, ${npcSummaries.length} NPCs`);

        // Return compact summary (not full entities)
        return {
          success: true,
          locationId: locationEntity.id,
          locationName: locationEntity.name,
          locationSummary: locationEntity.summary,
          npcs: npcSummaries,
          narration: data.narration,
          usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
        };
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        console.log(`[generate_location] ERROR after ${elapsed}ms: ${err?.message || String(err)}`);
        throw err;
      }
    }
  );

  // generate_npcs - Generate characters and persist to canon
  registry.register(
    "generate_npcs",
    {
      name: "generate_npcs",
      description: "Generate one or more NPCs for a location or burg. Automatically persists to canon with rich character details.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of NPCs to generate (default 3)" },
          burgId: { type: "number", description: "Burg where NPCs are based" },
          locationId: { type: "string", description: "Location entity ID where NPCs will be" },
          roles: { type: "string", description: "Suggested roles (e.g., 'barkeep, guard, merchant')" },
          factionIds: { type: "string", description: "JSON array of faction IDs to potentially link NPCs to" },
          reason: { type: "string", description: "Reason/prompt for why these NPCs are being generated (for provenance)" },
          source: { type: "string", description: "Source application generating these NPCs (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a specific pending idea to weave into one of these NPCs." },
        },
        required: ["burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const count = Number(args.count) || 3;
      const burgId = Number(args.burgId);
      const locationId = args.locationId ? String(args.locationId) : undefined;

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      const stateId = typeof burg.state === "number" ? burg.state : undefined;

      // Query active events affecting this location
      const activeEvents = ctx.canon.getActiveEvents({
        burgId,
        stateId,
        includeParentScopes: true,
        recencyDays: 90,
      });

      // Parse faction IDs if provided
      let availableFactions: Array<{ id: string; name: string; kind: string }> = [];
      if (args.factionIds) {
        try {
          const ids = JSON.parse(String(args.factionIds));
          for (const id of ids) {
            const faction = ctx.canon.getEntity(id);
            if (faction && faction.type === "faction") {
              availableFactions.push({
                id: faction.id,
                name: faction.name,
                kind: faction.payload?.kind || "organization",
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Also get existing factions in the burg if none specified
      if (availableFactions.length === 0) {
        const burgFactions = ctx.canon.listEntities({ type: "faction", anchors: { burgId }, limit: 10 });
        availableFactions = burgFactions.map(f => ({
          id: f.id,
          name: f.name,
          kind: f.payload?.kind || "organization",
        }));
      }

      const eventContext = formatEventContext(activeEvents.map((e) => ({
        name: e.name,
        summary: e.summary,
        scope: e.payload?.scope,
        daysAgo: e.payload?.daysAgo,
        severity: e.payload?.severity,
        scale: e.payload?.scale,
        secrecy: e.payload?.secrecy,
      })));
      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      const npcsIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "npc",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: args.roles ? String(args.roles).split(/[,\s]+/).filter(Boolean) : undefined,
        anchor: {
          burgId,
          locationId,
          tags: [burg.name].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate ${count} detailed NPCs for a fantasy city.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Each NPC should have rich character details. Output ONLY valid JSON:
{
  "npcs": [{
    "key": "unique_key",
    "type": "npc",
    "name": "Full Name",
    "summary": "One-line public description",
    "details_md": "Longer background (optional)",
    "tags": ["role", "trait"],
    "payload": {
      "role": "their job/role",
      "personality": "key personality traits",
      "appearance": "physical description",
      "background": "brief history",
      "knows": {
        "public": ["commonly known facts they share freely"],
        "secret": ["things they know but hide"],
        "intimate": ["deep secrets only shared with trusted friends"]
      },
      "secrets": ["personal secrets about themselves"],
      "motivations": ["what drives them"],
      "factionId": "optional faction ID if member"
    }
  }]
}

If linking to factions, use "factionId" in payload and add a "factionRole" (member/senior/leader) and "factionSecret" (true/false).${npcsIdeaInjection.promptAddition}`;

      const userPrompt = {
        count,
        burg: { id: burg.id, name: burg.name },
        roles: args.roles || null,
        locationId: locationId || null,
        availableFactions: availableFactions.length > 0 ? availableFactions : null,
        eventContext,
        instructions: "Create interesting NPCs with secrets and motivations. Some may be faction members.",
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 4000,
        temperature: 0.7,
      });

      const parsed = NpcsGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      // Persist NPCs to canon
      const npcSummaries: Array<{ id: string; name: string; summary: string; factions?: string[] }> = [];
      for (const npc of parsed.data.npcs) {
        const npcEntity = ctx.canon.addEntity({
          type: "npc",
          name: npc.name,
          summary: npc.summary || null,
          details_md: npc.details_md || null,
          tags: npc.tags || [],
          anchors: { burgId },
          payload: npc.payload || {},
          provenance: {
            generated_by: args.source || "generate_npcs",
            provider: genLlm.provider,
            model: genLlm.model,
            reason: args.reason || null,
            approved_at: args.reason ? new Date().toISOString() : undefined,
          },
        });

        const npcFactions: string[] = [];

        // Link to location if provided
        if (locationId) {
          ctx.canon.addRelation({
            from_id: npcEntity.id,
            to_id: locationId,
            rel_type: "located_at",
          });
        }

        // Create faction membership relation if specified
        const payload = npc.payload || {};
        if (payload.factionId && typeof payload.factionId === "string") {
          const faction = ctx.canon.getEntity(payload.factionId);
          if (faction && faction.type === "faction") {
            const role = payload.factionRole === "leader" ? "leads" :
                        payload.factionRole === "senior" ? "member_of" : "member_of";
            const strength = payload.factionRole === "leader" ? 1.0 :
                            payload.factionRole === "senior" ? 0.8 : 0.5;
            const notes = payload.factionSecret ? "secret" : undefined;

            ctx.canon.addRelation({
              from_id: npcEntity.id,
              to_id: faction.id,
              rel_type: role,
              strength,
              notes,
            });
            npcFactions.push(faction.name + (payload.factionSecret ? " (secret)" : ""));
          }
        }

        npcSummaries.push({
          id: npcEntity.id,
          name: npc.name,
          summary: npc.summary || "",
          factions: npcFactions.length > 0 ? npcFactions : undefined,
        });
      }

      const firstNpcId = npcSummaries[0]?.id;
      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, firstNpcId, npcsIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_npcs", npcsIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        count: npcSummaries.length,
        npcs: npcSummaries,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_faction - Generate an organization and persist to canon
  registry.register(
    "generate_faction",
    {
      name: "generate_faction",
      description: "Generate a faction/organization (guild, criminal ring, religious order, etc.). Automatically persists to canon.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Type: thieves-guild, merchant-guild, religious-order, criminal-syndicate, noble-house, etc.",
          },
          burgId: { type: "number", description: "Burg where faction is based" },
          hints: { type: "string", description: "Additional hints about the faction" },
          reason: { type: "string", description: "Reason/prompt for why this faction is being generated (for provenance)" },
          source: { type: "string", description: "Source application generating this faction (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this faction." },
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

      const stateId = typeof burg.state === "number" ? burg.state : undefined;

      // Query active events affecting this location
      const activeEvents = ctx.canon.getActiveEvents({
        burgId,
        stateId,
        includeParentScopes: true,
        recencyDays: 90,
      });

      const eventContext = formatEventContext(activeEvents.map((e) => ({
        name: e.name,
        summary: e.summary,
        scope: e.payload?.scope,
        daysAgo: e.payload?.daysAgo,
        severity: e.payload?.severity,
        scale: e.payload?.scale,
        secrecy: e.payload?.secrecy,
      })));
      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      const factionIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "faction",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [kind],
        anchor: { burgId, tags: [burg.name, kind].filter((s): s is string => !!s) },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} faction.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}Output ONLY valid JSON with a "faction" object.
Faction payload should include goals and may include goalProgress objects for long-term schemes.${factionIdeaInjection.promptAddition}`;

      const userPrompt = {
        kind,
        hints: args.hints || null,
        burg: { id: burg.id, name: burg.name },
        eventContext,
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      const parsed = FactionGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const faction = parsed.data.faction;
      const factionEntity = ctx.canon.addEntity({
        type: "faction",
        name: faction.name,
        summary: faction.summary || null,
        details_md: faction.details_md || null,
        tags: faction.tags || [kind],
        anchors: { burgId },
        payload: faction.payload || { kind },
        provenance: {
          generated_by: args.source || "generate_faction",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
          approved_at: args.reason ? new Date().toISOString() : undefined,
        },
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, factionEntity.id, factionIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_faction", factionIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        factionId: factionEntity.id,
        factionName: factionEntity.name,
        factionSummary: factionEntity.summary,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_event - Generate an event with consequences and persist to canon
  registry.register(
    "generate_event",
    {
      name: "generate_event",
      description: "Generate a world event (disaster, political change, festival, etc.) with scope and consequences. Automatically persists to canon.",
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
          historical: { type: "boolean", description: "Mark this as a historical event instead of a current/live event" },
          eraId: { type: "string", description: "Anchor the event to an existing era entity ID" },
          eraLabel: { type: "string", description: "Display label for a fuzzy era if no era ID is known yet" },
          recencyBand: {
            type: "string",
            description: "Fuzzy historical distance: mythic, ancient, old, recent, living-memory",
            enum: ["mythic", "ancient", "old", "recent", "living-memory"],
          },
          relativeOrder: { type: "number", description: "Order within a local timeline. Lower numbers happen earlier." },
          sequenceHint: { type: "string", description: "Narrative ordering hint like 'before the current dynasty'" },
          hints: { type: "string", description: "Additional creative hints" },
          reason: { type: "string", description: "Reason/prompt for why this event is being generated (for provenance)" },
          source: { type: "string", description: "Source application generating this event (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this event." },
        },
        required: ["kind", "scope", "severity"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const kind = String(args.kind);
      const scope = String(args.scope);
      const severity = String(args.severity);
      const daysAgo = typeof args.daysAgo === "number" ? args.daysAgo : 0;
      const burgId = args.burgId ? Number(args.burgId) : undefined;
      const stateId = args.stateId ? Number(args.stateId) : undefined;
      const historical = args.historical === true;
      const eraId = args.eraId ? String(args.eraId) : undefined;
      const eraLabel = args.eraLabel ? String(args.eraLabel) : undefined;
      const recencyBand = args.recencyBand ? String(args.recencyBand) : undefined;
      const relativeOrder = typeof args.relativeOrder === "number" ? args.relativeOrder : undefined;
      const sequenceHint = args.sequenceHint ? String(args.sequenceHint) : undefined;

      let context = "";
      if (burgId) {
        const burg = ctx.world.getBurg(burgId);
        if (burg) context += `Centered on ${burg.name} (burg ${burg.id}). `;
      }
      if (stateId) {
        const state = ctx.world.getState(stateId);
        if (state) context += `In the state of ${state.name}. `;
      }

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);
      const eventIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "event",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [kind, scope, severity],
        anchor: {
          burgId,
          stateId,
          tags: [kind, scope].filter(Boolean) as string[],
        },
      });
      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} event.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}Output ONLY valid JSON with an "event" object, optional "payload" object, and "consequences" array.
Use payload.scale for operational size, payload.secrecy for who knows, and payload.audience for initially informed actors.${eventIdeaInjection.promptAddition}`;

      const userPrompt = {
        kind,
        scope,
        severity,
        daysAgo: historical ? null : daysAgo,
        historical,
        eraId,
        eraLabel,
        recencyBand,
        relativeOrder,
        sequenceHint,
        context,
        hints: args.hints || null,
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      const parsed = EventGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const event = parsed.data.event;
      const eventEntity = ctx.canon.addEntity({
        type: "event",
        name: event.name,
        summary: event.summary || null,
        details_md: event.details_md || null,
        tags: event.tags || [kind, scope],
        anchors: { burgId, stateId, eraId },
        payload: {
          ...event.payload,
          ...parsed.data.payload,
          kind,
          scope,
          severity,
          historical,
          eraId,
          eraLabel,
          recencyBand,
          relativeOrder,
          sequenceHint,
          daysAgo: historical ? undefined : daysAgo,
          ongoing: historical ? false : daysAgo === 0,
          consequences: parsed.data.consequences || [],
        },
        provenance: {
          generated_by: args.source || "generate_event",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
          approved_at: args.reason ? new Date().toISOString() : undefined,
        },
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, eventEntity.id, eventIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_event", eventIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        eventId: eventEntity.id,
        eventName: eventEntity.name,
        eventSummary: eventEntity.summary,
        scope,
        severity,
        daysAgo: historical ? null : daysAgo,
        historical,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_rumor - Generate a rumor with truth/spread levels and persist to canon
  registry.register(
    "generate_rumor",
    {
      name: "generate_rumor",
      description:
        "Generate a rumor circulating in a location. Rumors have truth levels (how accurate), spread levels (how widely known), and may link to events or NPCs. Automatically persists to canon.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "What the rumor is about (e.g., 'the missing merchant', 'strange lights in the forest')",
          },
          truthLevel: {
            type: "string",
            description: "How accurate: false, distorted, mostly-true, true",
            enum: ["false", "distorted", "mostly-true", "true"],
          },
          spreadLevel: {
            type: "string",
            description: "How widely known: whisper (few know), local (burg), regional (state), widespread (world)",
            enum: ["whisper", "local", "regional", "widespread"],
          },
          sourceType: {
            type: "string",
            description: "Origin: gossip, observation, leak, planted, unknown",
            enum: ["gossip", "observation", "leak", "planted", "unknown"],
          },
          burgId: { type: "number", description: "Burg where rumor is circulating" },
          linkedEventId: { type: "string", description: "Event ID this rumor relates to (if any)" },
          linkedNpcId: { type: "string", description: "NPC ID who spreads or knows about this rumor (if any)" },
          hints: { type: "string", description: "Additional creative hints" },
          reason: { type: "string", description: "Reason/prompt for generation (for provenance)" },
          source: { type: "string", description: "Source application (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this rumor." },
        },
        required: ["topic", "burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const topic = String(args.topic);
      const burgId = Number(args.burgId);
      const truthLevel = args.truthLevel || "distorted";
      const spreadLevel = args.spreadLevel || "local";
      const sourceType = args.sourceType || "gossip";

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      // Get linked entities for context
      let linkedEventContext = "";
      if (args.linkedEventId) {
        const event = ctx.canon.getEntity(String(args.linkedEventId));
        if (event && event.type === "event") {
          linkedEventContext = `Related to event: ${event.name} - ${event.summary || "no summary"}`;
        }
      }

      let linkedNpcContext = "";
      if (args.linkedNpcId) {
        const npc = ctx.canon.getEntity(String(args.linkedNpcId));
        if (npc && npc.type === "npc") {
          linkedNpcContext = `Spread by/about NPC: ${npc.name} - ${npc.summary || "no summary"}`;
        }
      }

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      const rumorIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "rumor",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [String(truthLevel), String(spreadLevel), String(sourceType)],
        anchor: { burgId, tags: [burg.name, topic].filter((s): s is string => !!s) },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate a rumor for a fantasy city.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
A rumor is something people are saying - it may be true, distorted, or completely false.
The "actualTruth" field is GM-only information about what's really going on.

Output ONLY valid JSON with:
- rumor: { key, type: "rumor", name (the rumor as people say it), summary (1-2 sentences of what people claim), details_md (fuller version with variations), tags }
- payload: { truthLevel, spreadLevel, sourceType, secrecy, ageDays, actualTruth (GM-only: what's really true) }${rumorIdeaInjection.promptAddition}`;

      const userPrompt = {
        topic,
        truthLevel,
        spreadLevel,
        sourceType,
        burg: { id: burg.id, name: burg.name },
        linkedEventContext: linkedEventContext || null,
        linkedNpcContext: linkedNpcContext || null,
        hints: args.hints || null,
        instructions:
          "Create a compelling rumor. The name should be what people say (e.g., 'They say the baron poisoned his wife'). " +
          "Summary is what most people have heard. Details_md includes variations and where you might hear it. " +
          "actualTruth reveals the GM-only reality behind the rumor.",
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 1500,
        temperature: 0.8,
      });

      const parsed = RumorGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const rumor = parsed.data.rumor;
      const payload = parsed.data.payload;

      const rumorEntity = ctx.canon.addEntity({
        type: "rumor",
        name: rumor.name,
        summary: rumor.summary || null,
        details_md: rumor.details_md || null,
        tags: rumor.tags || [sourceType, spreadLevel],
        anchors: { burgId, linkedEventId: args.linkedEventId, linkedNpcId: args.linkedNpcId },
        payload: {
          ...payload,
          truthLevel,
          spreadLevel,
          sourceType,
          ageDays: payload.ageDays ?? 0,
        },
        provenance: {
          generated_by: args.source || "generate_rumor",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
          approved_at: args.reason ? new Date().toISOString() : undefined,
        },
      });

      // Create relations to linked entities
      if (args.linkedEventId) {
        ctx.canon.addRelation({
          from_id: rumorEntity.id,
          to_id: String(args.linkedEventId),
          rel_type: "about",
        });
      }
      if (args.linkedNpcId) {
        ctx.canon.addRelation({
          from_id: rumorEntity.id,
          to_id: String(args.linkedNpcId),
          rel_type: "spread_by",
        });
      }

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, rumorEntity.id, rumorIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_rumor", rumorIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        rumorId: rumorEntity.id,
        rumorName: rumorEntity.name,
        rumorSummary: rumorEntity.summary,
        truthLevel,
        spreadLevel,
        sourceType,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_hook - Generate an adventure/quest hook and persist to canon
  registry.register(
    "generate_hook",
    {
      name: "generate_hook",
      description:
        "Generate an adventure hook (quest, mission, job) for players. Hooks have type, urgency, difficulty, and rewards. Automatically persists to canon.",
      parameters: {
        type: "object",
        properties: {
          hookType: {
            type: "string",
            description: "Type: investigation, rescue, exploration, negotiation, combat, heist, escort, delivery, mystery, social",
            enum: ["investigation", "rescue", "exploration", "negotiation", "combat", "heist", "escort", "delivery", "mystery", "social"],
          },
          urgency: {
            type: "string",
            description: "Time sensitivity: background (no rush), whenever, soon, urgent, critical",
            enum: ["background", "whenever", "soon", "urgent", "critical"],
          },
          difficulty: {
            type: "string",
            description: "Estimated difficulty: trivial, easy, moderate, hard, deadly",
            enum: ["trivial", "easy", "moderate", "hard", "deadly"],
          },
          rewardType: {
            type: "string",
            description: "Primary reward: gold, information, favor, item, reputation, mixed",
            enum: ["gold", "information", "favor", "item", "reputation", "mixed"],
          },
          burgId: { type: "number", description: "Burg where hook is offered/relevant" },
          linkedEventId: { type: "string", description: "Event ID this hook relates to (if any)" },
          linkedNpcId: { type: "string", description: "NPC ID offering or involved in this hook (if any)" },
          linkedFactionId: { type: "string", description: "Faction ID involved in this hook (if any)" },
          hints: { type: "string", description: "Additional creative hints" },
          reason: { type: "string", description: "Reason/prompt for generation (for provenance)" },
          source: { type: "string", description: "Source application (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this hook." },
        },
        required: ["hookType", "burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const hookType = String(args.hookType);
      const burgId = Number(args.burgId);
      const urgency = args.urgency || "whenever";
      const difficulty = args.difficulty || "moderate";
      const rewardType = args.rewardType || "mixed";

      if (!Number.isFinite(burgId)) {
        return { error: "burgId must be a number" };
      }

      const burg = ctx.world.getBurg(burgId);
      if (!burg) {
        return { error: `Burg ${burgId} not found` };
      }

      // Get linked entities for context
      let linkedContext: string[] = [];
      if (args.linkedEventId) {
        const event = ctx.canon.getEntity(String(args.linkedEventId));
        if (event && event.type === "event") {
          linkedContext.push(`Related to event: ${event.name} - ${event.summary || "no summary"}`);
        }
      }
      if (args.linkedNpcId) {
        const npc = ctx.canon.getEntity(String(args.linkedNpcId));
        if (npc && npc.type === "npc") {
          linkedContext.push(`Quest giver/involved NPC: ${npc.name} - ${npc.summary || "no summary"}`);
        }
      }
      if (args.linkedFactionId) {
        const faction = ctx.canon.getEntity(String(args.linkedFactionId));
        if (faction && faction.type === "faction") {
          linkedContext.push(`Faction involved: ${faction.name} - ${faction.summary || "no summary"}`);
        }
      }

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      const hookIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "hook",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [hookType, String(urgency), String(difficulty), String(rewardType)],
        anchor: { burgId, tags: [burg.name].filter((s): s is string => !!s) },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate an adventure hook for a fantasy TTRPG.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
A hook is a potential quest, job, or adventure that players might pursue.

Output ONLY valid JSON with:
- hook: { key, type: "hook", name (catchy title), summary (1-2 sentence pitch to players), details_md (full setup, what's really going on), tags }
- payload: { hookType, urgency, difficulty, rewardType, rewardDetails, complications (2-3 potential twists), failureConsequences }${hookIdeaInjection.promptAddition}`;

      const userPrompt = {
        hookType,
        urgency,
        difficulty,
        rewardType,
        burg: { id: burg.id, name: burg.name },
        linkedContext: linkedContext.length > 0 ? linkedContext : null,
        hints: args.hints || null,
        instructions:
          "Create an engaging adventure hook. Name should be intriguing (e.g., 'The Merchant's Missing Daughter'). " +
          "Summary is the player-facing pitch. Details_md contains GM info about what's really happening. " +
          "Complications should be 2-3 potential twists that could make things interesting. " +
          "failureConsequences describes what happens if players ignore or fail the hook.",
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.8,
      });

      const parsed = HookGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const hook = parsed.data.hook;
      const payload = parsed.data.payload;

      const hookEntity = ctx.canon.addEntity({
        type: "hook",
        name: hook.name,
        summary: hook.summary || null,
        details_md: hook.details_md || null,
        tags: hook.tags || [hookType, urgency],
        anchors: {
          burgId,
          linkedEventId: args.linkedEventId,
          linkedNpcId: args.linkedNpcId,
          linkedFactionId: args.linkedFactionId,
        },
        payload: {
          ...payload,
          hookType,
          urgency,
          difficulty,
          rewardType,
        },
        provenance: {
          generated_by: args.source || "generate_hook",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
          approved_at: args.reason ? new Date().toISOString() : undefined,
        },
      });

      // Create relations to linked entities
      if (args.linkedEventId) {
        ctx.canon.addRelation({
          from_id: hookEntity.id,
          to_id: String(args.linkedEventId),
          rel_type: "caused_by",
        });
      }
      if (args.linkedNpcId) {
        ctx.canon.addRelation({
          from_id: hookEntity.id,
          to_id: String(args.linkedNpcId),
          rel_type: "offered_by",
        });
      }
      if (args.linkedFactionId) {
        ctx.canon.addRelation({
          from_id: hookEntity.id,
          to_id: String(args.linkedFactionId),
          rel_type: "involves",
        });
      }

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, hookEntity.id, hookIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_hook", hookIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        hookId: hookEntity.id,
        hookName: hookEntity.name,
        hookSummary: hookEntity.summary,
        hookType,
        urgency,
        difficulty,
        rewardType,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_lore - Generate world-building details and persist to canon
  registry.register(
    "generate_lore",
    {
      name: "generate_lore",
      description: "Generate world-building lore (holidays, customs, history, legends). Automatically persists to canon as a meta entity.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Subject to generate lore about" },
          aspect: {
            type: "string",
            description: "Aspect: history, customs, holidays, legends, religion, etc.",
          },
          context: { type: "string", description: "Context (burg name, state, culture)" },
          reason: { type: "string", description: "Reason/prompt for why this lore is being generated (for provenance)" },
          source: { type: "string", description: "Source application generating this lore (e.g., 'azbrowse', 'azchat')" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this lore." },
        },
        required: ["subject", "aspect"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const subject = String(args.subject);
      const aspect = String(args.aspect);

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);
      const loreIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "lore",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: ["meta", "lore", aspect],
        anchor: { tags: [subject, aspect, args.context].filter((s) => typeof s === "string" && !!s) as string[] },
      });
      const systemPrompt = `You are a tabletop GM assistant. Generate ${aspect} lore about ${subject}.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}Output JSON with: subject, aspect, content (markdown), relatedTopics (array of strings).${loreIdeaInjection.promptAddition}`;

      const userPrompt = {
        subject,
        aspect,
        context: args.context || null,
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      const parsed = LoreGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      // Persist as meta entity
      const loreEntity = ctx.canon.addEntity({
        type: "meta",
        name: `${subject} - ${aspect}`,
        summary: parsed.data.content.slice(0, 200),
        details_md: parsed.data.content,
        tags: ["lore", aspect],
        anchors: {},
        payload: { subject, aspect, relatedTopics: parsed.data.relatedTopics },
        provenance: {
          generated_by: args.source || "generate_lore",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
          approved_at: args.reason ? new Date().toISOString() : undefined,
        },
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, loreEntity.id, loreIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_lore", loreIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        loreId: loreEntity.id,
        subject,
        aspect,
        contentPreview: parsed.data.content.slice(0, 150) + "...",
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
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
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into the reaction." },
        },
        required: ["actorType", "actorId", "eventId", "awarenessLevel"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const actorType = String(args.actorType);
      const actorId = String(args.actorId);
      const eventId = String(args.eventId);
      const awarenessLevel = String(args.awarenessLevel);
      const forceUseIdeaIdReaction = args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined;

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

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const reactionIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "reaction",
        forceUseIdeaId: forceUseIdeaIdReaction,
        additionalLabels: [actorType, awarenessLevel],
        anchor: { tags: [actorName, event.name].filter((s): s is string => !!s) },
      });
      const systemPrompt = `You are a tabletop GM assistant generating NPC/faction reactions to world events.
Generate 3-5 diverse, plausible reactions the actor might have to the event.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}Output JSON with: actorName, eventName, candidates (array of reaction objects).

Each candidate should have:
- description: what the actor does
- category: "political", "economic", "social", or "factional"
- intensity: "subtle", "moderate", or "dramatic"
- publiclyVisible: boolean
- creates: array of outcomes (optional) - each with type ("relation", "rumor", "event"), description, and optional targetType/targetId/relationType${reactionIdeaInjection.promptAddition}`;

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

      const result = await completeJson(getGenLlm(ctx), {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.8,
      });

      const parsed = ReactionGenerationResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, undefined, reactionIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_reaction", reactionIdeaInjection.candidateIds, usedIdeas);

      // Return compact summary - just names/descriptions, not full creates arrays
      return {
        success: true,
        actorName: parsed.data.actorName,
        eventName: parsed.data.eventName,
        candidates: parsed.data.candidates.map((c) => ({
          description: c.description,
          category: c.category,
          intensity: c.intensity,
          publiclyVisible: c.publiclyVisible,
        })),
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // --- Pantheon generation schemas ---
  const PantheonDeitySchema = z.object({
    key: z.string(),
    name: z.string(),
    summary: z.string(),
    details_md: z.string(),
    tags: z.array(z.string()),
    payload: z.object({
      rank: DeityRankEnum,
      domains: z.array(z.string()),
      alignment: z.string(),
      symbols: z.array(z.string()),
      titles: z.array(z.string()),
      sacredAnimal: z.string().optional(),
      sacredElement: z.string().optional(),
      festivals: z.array(z.string()).optional(),
      appearance: z.string().optional(),
      mythology: z.string().optional(),
      worshipStyle: z.string().optional(),
    }),
  });

  const PantheonGenResultSchema = z.object({
    deities: z.array(PantheonDeitySchema),
    relations: z.array(z.object({
      from: z.string(),
      to: z.string(),
      rel_type: z.string(),
      notes: z.string().optional(),
    })).optional(),
  });

  // Form-to-deity count mapping
  const FORM_DEITY_COUNTS: Record<string, { min: number; max: number; guidance: string }> = {
    "Monotheism": { min: 1, max: 1, guidance: "Generate exactly ONE all-encompassing deity. This deity may have multiple aspects or manifestations, but is a single divine being." },
    "Dualism": { min: 2, max: 2, guidance: "Generate exactly TWO opposing deities representing complementary/opposing forces (light/dark, creation/destruction, order/chaos)." },
    "Polytheism": { min: 5, max: 12, guidance: "Generate a pantheon with a hierarchy: 1 supreme deity, 2-3 greater deities, and the rest as lesser deities. Each should have distinct domains." },
    "Shamanism": { min: 3, max: 8, guidance: "Generate nature spirits rather than traditional gods. Focus on elemental forces, animal spirits, and ancestral spirits. Use rank 'spirit' for all." },
    "Folk": { min: 2, max: 6, guidance: "Generate local/ancestral deities tied to everyday life - harvest, hearth, craft, luck. These are approachable, familiar figures, not distant cosmic beings." },
  };

  // generate_pantheon - Generate deities for a religion
  registry.register(
    "generate_pantheon",
    {
      name: "generate_pantheon",
      description: "Generate a pantheon of deities for a religion. Creates deity entities based on the religion's form (monotheism, polytheism, etc.). Automatically persists to canon.",
      parameters: {
        type: "object",
        properties: {
          azgaarReligionId: {
            type: "number",
            description: "Azgaar religion ID to generate pantheon for",
          },
          hints: {
            type: "string",
            description: "Optional hints about the desired pantheon style, themes, or specific deities",
          },
          reason: {
            type: "string",
            description: "Reason for generating this pantheon (for provenance)",
          },
          source: {
            type: "string",
            description: "Source application (e.g., 'azbrowse', 'azchat')",
          },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into one of the deities." },
        },
        required: ["azgaarReligionId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const azgaarReligionId = Number(args.azgaarReligionId);

      if (!Number.isFinite(azgaarReligionId)) {
        return { error: "azgaarReligionId must be a number" };
      }

      const religionCtx = ctx.world.getReligionContext(azgaarReligionId);
      if (!religionCtx) {
        return { error: `Religion ${azgaarReligionId} not found` };
      }

      // Check for existing deities
      const existingDeities = ctx.canon.listEntities({ type: "deity", limit: 100 })
        .filter(e => e.anchors?.azgaarReligionId === azgaarReligionId);
      if (existingDeities.length > 0) {
        return {
          error: `Religion "${religionCtx.name}" already has ${existingDeities.length} deities. Delete existing deities first to regenerate.`,
          existing: existingDeities.map(d => ({ id: d.id, name: d.name })),
        };
      }

      // Find canon religion entity for context
      const religionEntities = ctx.canon.listEntities({ type: "religion", limit: 100 })
        .filter(e => e.anchors?.azgaarReligionId === azgaarReligionId);
      const religionEntity = religionEntities[0];

      // Determine deity count from religion form
      const form = religionCtx.form || "Polytheism";
      const formConfig = FORM_DEITY_COUNTS[form] || FORM_DEITY_COUNTS["Polytheism"];

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      // Build context about the religion
      const religionInfo: string[] = [
        `Religion: ${religionCtx.name}`,
        `Type: ${religionCtx.type || "unknown"}`,
        `Form: ${form}`,
      ];
      if (religionCtx.deity) religionInfo.push(`Known deity name: ${religionCtx.deity}`);
      if (religionCtx.originCulture) religionInfo.push(`Origin culture: ${religionCtx.originCulture.name}`);

      if (religionEntity) {
        if (religionEntity.summary) religionInfo.push(`Summary: ${religionEntity.summary}`);
        const beliefs = religionEntity.payload?.beliefs as string[] | undefined;
        if (beliefs?.length) religionInfo.push(`Core beliefs: ${beliefs.join("; ")}`);
        const practices = religionEntity.payload?.practices as string[] | undefined;
        if (practices?.length) religionInfo.push(`Practices: ${practices.join("; ")}`);
      }

      const pantheonIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "deity",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: ["pantheon", "religion", form].filter(Boolean) as string[],
        anchor: {
          azgaarReligionId,
          tags: [religionCtx.name, religionCtx.originCulture?.name].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a fantasy worldbuilding assistant creating a pantheon for a religion.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
${formConfig.guidance}

Generate between ${formConfig.min} and ${formConfig.max} deities. Each deity needs:
- key: unique identifier string (e.g., "storm_god", "harvest_mother")
- name: the deity's proper name
- summary: 1-2 sentence description
- details_md: 2-3 paragraph rich description covering their role, personality, and significance
- tags: relevant tags (e.g., "war", "nature", "trickster")
- payload with: rank (supreme/greater/lesser/demigod/spirit), domains (array of 2-4 domain strings), alignment, symbols (2-3 sacred symbols), titles (2-3 epithets/titles)
- Optional payload: sacredAnimal, sacredElement, festivals (1-2 named festivals), appearance, mythology (key myth), worshipStyle

Also generate relations between deities (parent_of, sibling_of, consort_of, rival_of, aspect_of) using their keys.

The deities should feel like they belong to the SAME religion and form a coherent mythology.
Output ONLY valid JSON matching the schema. If you wove in any of the optional design hints, list their IDs in a top-level "usedIdeaIds" string array.${pantheonIdeaInjection.promptAddition}`;

      const userPrompt = {
        religion: religionInfo.join("\n"),
        hints: args.hints || null,
      };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 4000,
        temperature: 0.8,
      });

      const parsed = PantheonGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse pantheon generation result", details: parsed.error.message };
      }

      // Persist deities
      const keyToId = new Map<string, string>();
      const createdDeities: Array<{ id: string; name: string; rank: string }> = [];

      for (const deity of parsed.data.deities) {
        const entity = ctx.canon.addEntity({
          type: "deity",
          name: deity.name,
          summary: deity.summary,
          details_md: deity.details_md,
          tags: deity.tags,
          anchors: {
            azgaarReligionId,
            ...(religionEntity ? { religionEntityId: religionEntity.id } : {}),
          },
          payload: deity.payload,
          provenance: {
            generated_by: args.source || "generate_pantheon",
            provider: genLlm.provider,
            model: genLlm.model,
            reason: args.reason || null,
          },
        });
        keyToId.set(deity.key, entity.id);
        createdDeities.push({ id: entity.id, name: entity.name, rank: deity.payload.rank });

        // Create belongs_to relation to religion entity
        if (religionEntity) {
          ctx.canon.addRelation({ from_id: entity.id, to_id: religionEntity.id, rel_type: "belongs_to" });
        }
      }

      // Create inter-deity relations
      let relationsCreated = 0;
      if (parsed.data.relations) {
        for (const rel of parsed.data.relations) {
          const fromId = keyToId.get(rel.from);
          const toId = keyToId.get(rel.to);
          if (fromId && toId) {
            ctx.canon.addRelation({
              from_id: fromId,
              to_id: toId,
              rel_type: rel.rel_type,
              notes: rel.notes,
            });
            relationsCreated++;
          }
        }
      }

      const firstDeityId = createdDeities[0]?.id;
      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, firstDeityId, pantheonIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_pantheon", pantheonIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        religionName: religionCtx.name,
        form,
        deitiesCreated: createdDeities.length,
        relationsCreated,
        deities: createdDeities,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // generate_marker - Generate a wilderness/map marker (ruin, tower, dungeon, etc.)
  const MarkerGenResultSchema = z.object({
    marker: z.object({
      name: z.string(),
      summary: z.string().optional(),
      details_md: z.string().optional(),
      tags: z.array(z.string()).optional(),
      payload: z.record(z.any()).optional(),
    }),
    narration: z.string().optional(),
  });

  registry.register(
    "generate_marker",
    {
      name: "generate_marker",
      description: "Generate a wilderness marker - a point of interest outside of any city/burg. Ruins, wizard towers, dungeons, ancient shrines, monster lairs, abandoned mines, etc. Persists to canon with map coordinates.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Type: ruin, tower, dungeon, shrine, cave, camp, monument, grove, mine, bridge, battlefield, portal, lair, oasis, lighthouse, shipwreck, other",
          },
          nearBurgId: { type: "number", description: "Burg to place this marker near (picks a wilderness cell nearby)" },
          stateId: { type: "number", description: "State to place this marker in (alternative to nearBurgId)" },
          hints: { type: "string", description: "Creative hints (e.g., 'abandoned dwarven', 'cursed', 'hidden by illusion')" },
          reason: { type: "string", description: "Reason for generation (provenance)" },
          source: { type: "string", description: "Source application" },
          forceUseIdeaId: { type: "string", description: "Optional: ID of a pending idea to weave into this marker." },
        },
        required: ["kind"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const kind = String(args.kind || "ruin");
      const nearBurgId = args.nearBurgId ? Number(args.nearBurgId) : undefined;
      const stateId = args.stateId ? Number(args.stateId) : undefined;

      // Find a wilderness cell to place the marker
      let cellId: number | undefined;
      let cellX: number | undefined;
      let cellY: number | undefined;
      let nearBurg: any;
      let nearState: any;

      if (nearBurgId) {
        nearBurg = ctx.world.getBurg(nearBurgId);
        if (!nearBurg) return { error: `Burg ${nearBurgId} not found` };
        nearState = typeof nearBurg.state === "number" ? ctx.world.getState(nearBurg.state) : undefined;

        // Find a wilderness cell near this burg (no burg assigned, has land)
        const cells = ctx.world.pack?.cells;
        if (cells) {
          const bx = nearBurg.x ?? 0;
          const by = nearBurg.y ?? 0;
          const candidates: Array<{ id: number; dist: number; x: number; y: number }> = [];
          const isObjKeyed = !Array.isArray(cells) && typeof cells === "object";
          const count = isObjKeyed ? Object.keys(cells).length : (Array.isArray(cells) ? cells.length : 0);

          for (let i = 0; i < count; i++) {
            const cell = isObjKeyed ? cells[String(i)] : cells[i];
            if (!cell || !cell.p) continue;
            if (cell.burg > 0) continue;       // Skip cells with burgs
            if (cell.h < 20) continue;          // Skip water
            const dx = cell.p[0] - bx;
            const dy = cell.p[1] - by;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 15 && dist < 80) {       // Not too close, not too far
              candidates.push({ id: i, dist, x: cell.p[0], y: cell.p[1] });
            }
          }

          if (candidates.length > 0) {
            // Pick a random-ish candidate (use kind hash for determinism)
            const hash = kind.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
            const pick = candidates[hash % candidates.length];
            cellId = pick.id;
            cellX = pick.x;
            cellY = pick.y;
          }
        }
      } else if (stateId) {
        nearState = ctx.world.getState(stateId);
      }

      const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
      const genLlm = getGenLlm(ctx);

      // Get geographic context for the cell
      let geoContext = "";
      if (cellId !== undefined) {
        const cellData = ctx.world.getCell(cellId);
        if (cellData) {
          const biomeName = ctx.world.getBiomeName(cellData.biomeId ?? 0);
          geoContext = `Terrain: ${biomeName}. Elevation: ${cellData.elevation ?? "unknown"}.`;
          if (cellData.stateName) geoContext += ` In ${cellData.stateName}.`;
          if (cellData.riverName) geoContext += ` Near the ${cellData.riverName} river.`;
        }
      }

      const markerIdeaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "marker",
        forceUseIdeaId: args.forceUseIdeaId ? String(args.forceUseIdeaId) : undefined,
        additionalLabels: [kind, "wilderness"],
        anchor: {
          burgId: nearBurgId,
          stateId,
          cellId,
          tags: [nearBurg?.name, nearState?.name, kind].filter((s) => typeof s === "string" && !!s) as string[],
        },
      });

      const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} wilderness marker - a point of interest in the wilderness, far from any city.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
This should feel like a discovery - something adventurers might stumble upon while traveling.

Output ONLY valid JSON with a "marker" object containing:
- name: evocative name for this place
- summary: 1-2 sentence description
- details_md: detailed markdown description (atmosphere, history, what's here now)
- tags: relevant tags
- payload: object with kind, condition (intact/ruined/hidden/overgrown/active), dangerLevel (safe/cautious/dangerous/deadly), discoverable (boolean), physicalDescription, atmosphere, features (array), inhabitants (who/what is here), history (brief lore)

Also include a "narration" field with a brief atmospheric description.${markerIdeaInjection.promptAddition}`;

      const userPrompt: any = {
        kind,
        hints: args.hints || null,
        geography: geoContext || null,
      };
      if (nearBurg) userPrompt.nearBurg = { name: nearBurg.name, id: nearBurg.id ?? nearBurg.i };
      if (nearState) userPrompt.inState = { name: nearState.name };

      const result = await completeJson(genLlm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      const parsed = MarkerGenResultSchema.safeParse(result);
      if (!parsed.success) {
        return { error: "Failed to parse generation result" };
      }

      const marker = parsed.data.marker;
      const anchors: Record<string, any> = {};
      if (cellId !== undefined) anchors.cellId = cellId;
      if (nearBurgId) anchors.nearBurgId = nearBurgId;
      if (stateId) anchors.stateId = stateId;
      else if (nearBurg && typeof nearBurg.state === "number") anchors.stateId = nearBurg.state;

      const payload: Record<string, any> = {
        kind,
        ...(marker.payload || {}),
      };
      if (cellX !== undefined) payload.x = cellX;
      if (cellY !== undefined) payload.y = cellY;
      if (cellId !== undefined) payload.cellId = cellId;

      const markerEntity = ctx.canon.addEntity({
        type: "marker",
        name: marker.name,
        summary: marker.summary || null,
        details_md: marker.details_md || null,
        tags: marker.tags || [kind, "wilderness"],
        anchors,
        payload,
        provenance: {
          generated_by: args.source || "generate_marker",
          provider: genLlm.provider,
          model: genLlm.model,
          reason: args.reason || null,
        },
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, parsed.data, markerEntity.id, markerIdeaInjection.candidateIds);
      logIdeaBreadcrumb("generate_marker", markerIdeaInjection.candidateIds, usedIdeas);

      return {
        success: true,
        markerId: markerEntity.id,
        markerName: markerEntity.name,
        markerSummary: markerEntity.summary,
        kind,
        coordinates: cellX !== undefined ? { x: cellX, y: cellY, cellId } : null,
        narration: parsed.data.narration,
        usedIdeaIds: usedIdeas.length > 0 ? usedIdeas : undefined,
      };
    }
  );

  // ideas_lookup - Fuzzy search ideas in the pool by query
  registry.register(
    "ideas_lookup",
    {
      name: "ideas_lookup",
      description:
        "Fuzzy-search pending and used ideas in the world's ideas pool by free-text query. Returns top 5 matches with id, text, labels, and status. Use this to resolve user references like 'use the mistlands idea' before calling a generate_* tool with forceUseIdeaId.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query (matches idea text and labels)" },
          status: { type: "string", description: "Filter status: pending (default), used, all", enum: ["pending", "used", "all"] },
          limit: { type: "number", description: "Max matches to return (default 5)" },
        },
        required: ["query"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const query = String(args.query || "").trim();
      if (!query) return { error: "query is required" };
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const status = (args.status === "used" || args.status === "all") ? args.status : "pending";

      const ideas = listIdeas(ctx.canon, { status, limit: 500 });
      if (ideas.length === 0) return { matches: [], message: "No ideas in pool" };

      const q = query.toLowerCase();
      const scored = ideas.map((idea) => {
        const text = (idea.details_md || idea.summary || idea.name || "").toLowerCase();
        const labels: string[] = Array.isArray(idea.payload?.labels) ? idea.payload.labels : [];
        const labelText = labels.join(" ").toLowerCase();
        const hay = `${text} ${labelText}`;
        const maxLen = Math.max(q.length, hay.length, 1);
        const dist = levenshtein(q, hay.slice(0, Math.min(hay.length, q.length * 4)));
        const sub = hay.includes(q) ? 0.9 : 0;
        const fuzz = 1 - dist / maxLen;
        const score = Math.max(sub, fuzz);
        return { idea, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit).filter((s) => s.score > 0.15);

      return {
        matches: top.map((s) => ({
          id: s.idea.id,
          text: s.idea.details_md || s.idea.summary || s.idea.name,
          labels: Array.isArray(s.idea.payload?.labels) ? s.idea.payload.labels : [],
          status: s.idea.payload?.status || "pending",
          score: Number(s.score.toFixed(3)),
        })),
      };
    }
  );

  // ideas_list - List ideas with optional filters
  registry.register(
    "ideas_list",
    {
      name: "ideas_list",
      description:
        "List ideas in the world's ideas pool with optional status/label filters. Use for browsing or quick reference; use ideas_lookup for free-text resolution.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "pending (default), used, or all", enum: ["pending", "used", "all"] },
          label: { type: "string", description: "Restrict to ideas tagged with this label (case-insensitive)" },
          limit: { type: "number", description: "Max ideas to return (default 20)" },
        },
        required: [],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const status = (args.status === "used" || args.status === "all") ? args.status : "pending";
      const label = args.label ? String(args.label).trim().toLowerCase() : undefined;
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));

      const ideas = listIdeas(ctx.canon, { status, label, limit });
      return {
        count: ideas.length,
        ideas: ideas.map((idea) => ({
          id: idea.id,
          text: idea.details_md || idea.summary || idea.name,
          labels: Array.isArray(idea.payload?.labels) ? idea.payload.labels : [],
          status: idea.payload?.status || "pending",
          usedByEntityId: idea.payload?.usedByEntityId,
        })),
      };
    }
  );
}
