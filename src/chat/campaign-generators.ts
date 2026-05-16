import { z } from "zod";
import type { LLMClient } from "../llm/providers";
import { completeJson } from "../llm/providers";
import type { CanonStore } from "../canon/canon";
import type {
  CampaignGenerators,
  CandidateDraft,
  GenerateArgs,
  GeneratorFn,
} from "../campaign/tools";
import type { AnySlotKind } from "../campaign/canon-mapping";

const CandidateSchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  payload: z.record(z.any()).optional(),
});

const CandidatesEnvelope = z.object({
  candidates: z.array(CandidateSchema).min(1),
});

const CANDIDATES_JSON_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          payload: { type: "object" },
        },
        required: ["name", "summary"],
      },
    },
  },
  required: ["candidates"],
};

const SLOT_PROMPTS: Record<AnySlotKind, { role: string; payloadHint: string }> = {
  region: {
    role: "geographic region (biome, climate, dominant culture, terrain)",
    payloadHint:
      "{ biome: string, climate: string, terrain: string, culture: string, dangerLevel: 'safe'|'frontier'|'hostile' }",
  },
  location: {
    role: "specific place (settlement, landmark, structure) within the region",
    payloadHint:
      "{ kind: string, scale: 'tiny'|'small'|'medium'|'large'|'massive', notableFeatures: string[] }",
  },
  event: {
    role: "happening or situation affecting the area",
    payloadHint:
      "{ scope: 'neighborhood'|'burg'|'state'|'region'|'world', severity: 'minor'|'moderate'|'major'|'catastrophic', daysAgo: number, ongoing: boolean }",
  },
  faction: {
    role: "organization, group, or power structure",
    payloadHint:
      "{ size: 'small'|'medium'|'large', alignment: string, goals: string[], methods: string[] }",
  },
  npcs: {
    role: "named NPC inhabitant or visitor",
    payloadHint:
      "{ role: string, demeanor: string, hooks: string[] }",
  },
  lore: {
    role: "piece of world lore (legend, history, secret)",
    payloadHint:
      "{ kind: 'legend'|'history'|'prophecy'|'secret'|'rumor', age: 'recent'|'old'|'ancient' }",
  },
  hooks: {
    role: "adventure hook or quest prompt",
    payloadHint:
      "{ kind: 'mystery'|'rescue'|'heist'|'investigation'|'escort'|'combat', stakes: string, complications: string[] }",
  },
};

function buildSystemPrompt(slot: AnySlotKind): string {
  const spec = SLOT_PROMPTS[slot];
  return `You are a campaign builder generating candidate drafts for the "${slot}" slot of a tabletop RPG campaign.

Each candidate must be a ${spec.role}.

Output ONLY valid JSON of the form:
{ "candidates": [ { "name": "...", "summary": "one or two sentences", "payload": ${spec.payloadHint} }, ... ] }

Rules:
- Distinct names, no near-duplicates.
- Summaries are concise (1-2 sentences) but evocative.
- payload follows the hinted shape above; omit any field you don't know.
- No commentary, no markdown, no backticks — just the JSON object.`;
}

function summariseAnchor(
  canon: CanonStore,
  entityId: string | undefined
): { name: string; summary: string } | undefined {
  if (!entityId) return undefined;
  const e = canon.getEntity(entityId);
  if (!e) return undefined;
  return { name: e.name, summary: e.summary ?? "" };
}

function buildUserPrompt(
  slot: AnySlotKind,
  args: GenerateArgs,
  canon: CanonStore
): string {
  const region = summariseAnchor(canon, args.anchors?.regionEntityId);
  const location = summariseAnchor(canon, args.anchors?.locationEntityId);

  const ctx: Record<string, unknown> = {
    slot,
    count: args.count,
  };
  if (args.notes) ctx.steeringNotes = args.notes;
  if (region) ctx.region = region;
  if (location) ctx.location = location;
  if (args.seed) ctx.reviseFrom = args.seed;

  return JSON.stringify(ctx, null, 0);
}

function makeGenerator(
  slot: AnySlotKind,
  llm: LLMClient,
  canon: CanonStore
): GeneratorFn {
  return async (args: GenerateArgs): Promise<CandidateDraft[]> => {
    const system = buildSystemPrompt(slot);
    const user = buildUserPrompt(slot, args, canon);

    let result: unknown;
    try {
      result = await completeJson(llm, {
        system,
        messages: [{ role: "user", content: user }],
        jsonSchema: CANDIDATES_JSON_SCHEMA,
        maxTokens: 2000,
        temperature: 0.85,
      });
    } catch (e) {
      throw new Error(`LLM generation failed for slot ${slot}: ${(e as Error)?.message ?? String(e)}`);
    }

    const parsed = CandidatesEnvelope.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        `Generator for slot ${slot} returned unexpected shape: ${parsed.error.message}`
      );
    }

    const limited = parsed.data.candidates.slice(0, Math.max(1, args.count));
    return limited.map((c) => ({
      name: c.name,
      summary: c.summary,
      payload: c.payload ?? {},
    }));
  };
}

export interface BuildGeneratorsOpts {
  llm: LLMClient;
  canon: CanonStore;
}

export function buildCampaignGenerators(opts: BuildGeneratorsOpts): CampaignGenerators {
  const { llm, canon } = opts;
  return {
    region: makeGenerator("region", llm, canon),
    location: makeGenerator("location", llm, canon),
    event: makeGenerator("event", llm, canon),
    faction: makeGenerator("faction", llm, canon),
    npcs: makeGenerator("npcs", llm, canon),
    lore: makeGenerator("lore", llm, canon),
    hooks: makeGenerator("hooks", llm, canon),
  };
}
