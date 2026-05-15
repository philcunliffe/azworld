/**
 * world-init-gen.ts - Batch generation of world content from Azgaar data
 *
 * Generates entities for states/governments, religions, and cultures
 * based on the world data from Azgaar Fantasy Map Generator.
 *
 * Two-phase generation flow:
 * 1. planWorldGeneration() - Creates a unified WorldGenPlan with themed entity names
 * 2. executeWorldGeneration() - Runs all LLM calls in parallel, then writes to DB
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, EntityType } from "../canon/canon";
import { LLMClient, completeJsonWithUsage, TokenUsage } from "../llm/providers";
import { CampaignSettings } from "../chat/schema";
import { formatSettingsForGeneration, GenerationFlags } from "../chat/campaign-settings";
import { debugLog } from "../chat/debug-log";
import {
  prepareIdeaInjection,
  markIdeasUsedFromOutput,
  logIdeaBreadcrumb,
} from "../canon/idea-injection";

// --- Helper functions to query generated content from canon DB ---

/**
 * Query previously generated religion entities from canon DB
 * These are the core theological entities (not factions that practice them)
 */
function getGeneratedReligionEntities(canon: CanonStore): Array<{
  id: string;
  name: string;
  summary: string;
  beliefs?: string[];
  deity?: string;
  azgaarReligionId?: number;
}> {
  const entities = canon.listEntities({ type: "religion" });
  return entities.map(e => ({
    id: e.id,
    name: e.name,
    summary: e.summary || "",
    beliefs: e.payload?.beliefs,
    deity: e.payload?.deity,
    azgaarReligionId: e.anchors?.azgaarReligionId,
  }));
}

/**
 * Query previously generated religions from canon DB
 * Backward compatibility - checks both new religion entities and legacy faction approach
 */
function getGeneratedReligions(canon: CanonStore): Array<{
  name: string;
  summary: string;
  beliefs?: string[];
  deity?: string;
}> {
  // First try new religion entities
  const religionEntities = canon.listEntities({ type: "religion" });
  if (religionEntities.length > 0) {
    return religionEntities.map(e => ({
      name: e.name,
      summary: e.summary || "",
      beliefs: e.payload?.beliefs,
      deity: e.payload?.deity,
    }));
  }

  // Fall back to legacy faction-based religions
  const factionEntities = canon.listEntities({ type: "faction" })
    .filter(e => e.tags?.includes("religion"));
  return factionEntities.map(e => ({
    name: e.name,
    summary: e.summary || "",
    beliefs: e.payload?.beliefs,
    deity: e.payload?.deity,
  }));
}

/**
 * Query previously generated cultures from canon DB
 */
function getGeneratedCultures(canon: CanonStore): Array<{
  name: string;
  summary: string;
  values?: string[];
  traits?: string[];
  cultureId?: number;
}> {
  const entities = canon.listEntities({ type: "culture" });
  return entities.map(e => ({
    name: e.name,
    summary: e.summary || "",
    values: e.payload?.values,
    traits: e.payload?.traits,
    cultureId: e.anchors?.cultureId,
  }));
}

/**
 * Get the specific religion and culture details for a state
 * Used by state government and ruler generation
 */
function getStateReligionAndCultureDetails(ctx: WorldGenContext, stateId: number): {
  religionDetails: { name: string; summary: string; deity?: string; beliefs?: string[] } | null;
  cultureDetails: { name: string; summary: string; traits?: string[]; values?: string[] } | null;
} {
  const sc = ctx.world.getStateContext(stateId);

  // Build religion details map
  const generatedReligionEntities = getGeneratedReligionEntities(ctx.canon);
  const religionDetailsMap = new Map<number, {
    name: string;
    summary: string;
    deity?: string;
    beliefs?: string[];
  }>();
  for (const rel of generatedReligionEntities) {
    if (rel.azgaarReligionId !== undefined) {
      religionDetailsMap.set(rel.azgaarReligionId, {
        name: rel.name,
        summary: rel.summary,
        deity: rel.deity,
        beliefs: rel.beliefs,
      });
    }
  }

  // Build culture details map
  const generatedCultures = getGeneratedCultures(ctx.canon);
  const cultureDetailsMap = new Map<number, {
    name: string;
    summary: string;
    traits?: string[];
    values?: string[];
  }>();
  for (const cul of generatedCultures) {
    if (cul.cultureId !== undefined) {
      cultureDetailsMap.set(cul.cultureId, {
        name: cul.name,
        summary: cul.summary,
        traits: cul.traits,
        values: cul.values,
      });
    }
  }

  // Get the state's dominant religion with full details
  const dominantReligion = ctx.world.getStateDominantReligion(stateId);
  let religionDetails = null;
  if (dominantReligion) {
    const generated = religionDetailsMap.get(dominantReligion.id);
    religionDetails = generated ? {
      name: generated.name,
      summary: generated.summary,
      deity: generated.deity,
      beliefs: generated.beliefs?.slice(0, 3),
    } : { name: dominantReligion.name, summary: dominantReligion.type || "" };
  }

  // Get the state's culture with full details
  let cultureDetails = null;
  if (sc?.culture?.id !== undefined) {
    const generated = cultureDetailsMap.get(sc.culture.id);
    cultureDetails = generated ? {
      name: generated.name,
      summary: generated.summary,
      traits: generated.traits?.slice(0, 3),
      values: generated.values?.slice(0, 3),
    } : { name: sc.culture.name, summary: sc.culture.type || "" };
  }

  return { religionDetails, cultureDetails };
}

/**
 * Format religions for inclusion in prompts
 */
function formatReligionsForPrompt(religions: ReturnType<typeof getGeneratedReligions>): string {
  if (religions.length === 0) return "";
  return religions.map(r => {
    let desc = `- ${r.name}: ${r.summary}`;
    if (r.deity) desc += ` (Deity: ${r.deity})`;
    if (r.beliefs?.length) desc += ` Core beliefs: ${r.beliefs.slice(0, 3).join(", ")}`;
    return desc;
  }).join("\n");
}

/**
 * Format cultures for inclusion in prompts
 */
function formatCulturesForPrompt(cultures: ReturnType<typeof getGeneratedCultures>): string {
  if (cultures.length === 0) return "";
  return cultures.map(c => {
    let desc = `- ${c.name}: ${c.summary}`;
    if (c.values?.length) desc += ` Values: ${c.values.slice(0, 3).join(", ")}`;
    if (c.traits?.length) desc += ` Traits: ${c.traits.slice(0, 3).join(", ")}`;
    return desc;
  }).join("\n");
}

export type WorldGenContext = {
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  campaignSettings?: CampaignSettings;
  stateFilter?: number[];  // Optional filter to only include religions/cultures from these states
  onProgress?: (message: string) => void;
  onPlanProgress?: (message: string) => void;
  onEntityStart?: (name: string, index: number, total: number) => void;
  onEntityComplete?: (name: string, index: number, total: number, tokens: number, elapsedMs: number) => void;
  onTokens?: (usage: Partial<TokenUsage>) => void;
};

export type WorldGenResult = {
  created: number;
  errors: string[];
};

// --- Types for World Generation Planning ---

export type WorldEntityPlan = {
  category: "state" | "religion" | "pantheon" | "culture";
  sourceId: number;           // Azgaar entity ID
  sourceName: string;         // e.g., "Kingdom of Eldara"
  entitiesToGenerate: Array<{
    type: EntityType;         // "faction" | "npc" | "culture"
    name: string;             // Planned name
    role: string;             // e.g., "government", "ruler", "high priest"
    reason: string;           // Why this entity fits the campaign
  }>;
  thematicNotes: string;      // How this fits the campaign vibe
};

export type WorldGenPlanRelationship = {
  fromCategory: "state" | "religion" | "culture";
  fromSourceId: number;
  fromRole: string;
  toCategory: "state" | "religion" | "culture";
  toSourceId: number;
  toRole: string;
  relationType: string;
};

export type WorldGenPlan = {
  description: string;        // Overall generation summary
  campaignTheme: string;      // How campaign settings inform the plan
  entities: WorldEntityPlan[];
  relationships: WorldGenPlanRelationship[];
};

/**
 * Generate government factions and ruler NPCs for each state
 */
export async function generateStateContent(ctx: WorldGenContext): Promise<WorldGenResult> {
  const states = ctx.world.listStates();
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  ctx.onProgress?.(`Generating governments for ${states.length} states...`);

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const stateContext = ctx.world.getStateContext(state.id);
    if (!stateContext) continue;

    const startTime = Date.now();
    ctx.onEntityStart?.(state.name, i, states.length);

    try {
      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "state",
        additionalLabels: ["government", "ruler"],
        anchor: {
          stateId: state.id,
          tags: [state.name, stateContext.formName, stateContext.culture?.name].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate a government faction and its ruler for a state based on the provided context.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "government": {
    "name": "The Crown of [State]",
    "summary": "One-line description of the government",
    "details_md": "Markdown description of how the government operates, its history, notable policies",
    "tags": ["government", "monarchy|republic|theocracy|etc"],
    "payload": {
      "kind": "government",
      "governmentType": "Monarchy|Republic|Theocracy|etc",
      "industries": ["major", "industries"],
      "militaryStrength": "weak|moderate|strong|dominant"
    }
  },
  "ruler": {
    "name": "Title Firstname Lastname",
    "summary": "One-line public description",
    "details_md": "Background, personality, secrets",
    "tags": ["ruler", "royalty|noble|elected|etc"],
    "payload": {
      "role": "King|Queen|President|etc",
      "personality": "key traits",
      "appearance": "physical description",
      "motivations": ["what drives them"],
      "secrets": ["personal secrets"]
    }
  }
}${ideaInjection.promptAddition}`;

      const userPrompt = JSON.stringify({
        state: {
          name: stateContext.name,
          fullName: stateContext.fullName,
          form: stateContext.form,
          formName: stateContext.formName,
        },
        capital: stateContext.capital,
        culture: stateContext.culture,
        military: stateContext.military,
        campaigns: stateContext.campaigns?.slice(0, 5),
        diplomacy: stateContext.diplomacy?.filter((d: any) => d.relation !== "Neutral").slice(0, 5),
        geographic: stateContext.geographic,
        population: {
          urban: Math.round(stateContext.urban || 0),
          rural: Math.round(stateContext.rural || 0),
          burgCount: stateContext.burgCount,
        },
      });

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2500,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create government faction
      const govEntity = ctx.canon.addEntity({
        type: "faction",
        name: data.government?.name || `Government of ${state.name}`,
        summary: data.government?.summary,
        details_md: data.government?.details_md,
        tags: data.government?.tags || ["government"],
        anchors: { stateId: state.id },
        payload: data.government?.payload || { kind: "government" },
        provenance: {
          generated_by: "world-init",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "state",
          sourceId: state.id,
        },
      });

      // Create ruler NPC
      const rulerEntity = ctx.canon.addEntity({
        type: "npc",
        name: data.ruler?.name || `Ruler of ${state.name}`,
        summary: data.ruler?.summary,
        details_md: data.ruler?.details_md,
        tags: data.ruler?.tags || ["ruler"],
        anchors: {
          stateId: state.id,
          burgId: stateContext.capital?.id,
        },
        payload: data.ruler?.payload || { role: "Ruler" },
        provenance: {
          generated_by: "world-init",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "state",
          sourceId: state.id,
        },
      });

      // Link ruler to government
      ctx.canon.addRelation({
        from_id: rulerEntity.id,
        to_id: govEntity.id,
        rel_type: "leads",
        strength: 1.0,
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, govEntity.id, ideaInjection.candidateIds);
      logIdeaBreadcrumb(`generateStateContent:${state.name}`, ideaInjection.candidateIds, usedIdeas);

      result.created += 2;
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(state.name, i, states.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(state.name, i, states.length, 0, elapsedMs);
      result.errors.push(`State ${state.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

/**
 * Generate religion entities (theological content)
 *
 * Creates one religion entity per Azgaar religion containing:
 * - Deity, beliefs, practices, holy sites, taboos, symbols, afterlife beliefs
 *
 * Religious factions and leaders can be created separately as needed,
 * linked via the religionEntityId anchor.
 */
export async function generateReligionContent(ctx: WorldGenContext): Promise<WorldGenResult> {
  const religions = ctx.world.listReligions();
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  ctx.onProgress?.(`Generating religions for ${religions.length} faiths...`);

  for (let i = 0; i < religions.length; i++) {
    const religion = religions[i];
    const religionContext = ctx.world.getReligionContext(religion.id);
    if (!religionContext) continue;

    const startTime = Date.now();
    ctx.onEntityStart?.(religion.name, i, religions.length);

    try {
      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "religion",
        additionalLabels: ["theology", religionContext.form, religionContext.type].filter((s): s is string => !!s),
        anchor: {
          azgaarReligionId: religion.id,
          tags: [religion.name, religionContext.originCulture?.name].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate detailed theological content for a religion - the FAITH ITSELF, not any organization.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "The [Religion Name]",
  "summary": "One-line description of the faith",
  "details_md": "Markdown description of theology, cosmology, sacred texts, creation myths, afterlife beliefs",
  "tags": ["theology", "type"],
  "payload": {
    "religionType": "Folk|Organized|Cult|Heresy",
    "form": "Shamanism|Polytheism|Dualism|Monotheism|etc",
    "deity": "deity name and epithet with brief description",
    "beliefs": ["core tenets of faith"],
    "practices": ["key rituals and observances"],
    "holySites": ["sacred locations with brief descriptions"],
    "taboos": ["forbidden behaviors"],
    "symbols": ["holy symbols and icons"],
    "afterlife": "beliefs about death and what comes after"
  }
}${ideaInjection.promptAddition}`;

      const userPrompt = JSON.stringify({
        religion: {
          name: religionContext.name,
          type: religionContext.type,
          form: religionContext.form,
          deity: religionContext.deity,
          code: religionContext.code,
          expansion: religionContext.expansion,
        },
        originCulture: religionContext.originCulture,
      });

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create religion entity (theological content)
      const religionEntity = ctx.canon.addEntity({
        type: "religion",
        name: data.name || religion.name,
        summary: data.summary,
        details_md: data.details_md,
        tags: data.tags || ["theology"],
        anchors: { azgaarReligionId: religion.id },
        payload: data.payload || {
          religionType: religionContext.type,
          form: religionContext.form,
          deity: religionContext.deity,
        },
        provenance: {
          generated_by: "world-init",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "religion",
          sourceId: religion.id,
        },
      });
      result.created += 1;

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, religionEntity.id, ideaInjection.candidateIds);
      logIdeaBreadcrumb(`generateReligionContent:${religion.name}`, ideaInjection.candidateIds, usedIdeas);

      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(religion.name, i, religions.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(religion.name, i, religions.length, 0, elapsedMs);
      result.errors.push(`Religion ${religion.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

/**
 * Generate deity entities for each religion based on its form.
 * Runs after religion generation so it can reference generated religion entities.
 */
export async function generatePantheonContent(ctx: WorldGenContext): Promise<WorldGenResult> {
  const religionEntities = getGeneratedReligionEntities(ctx.canon);
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  if (religionEntities.length === 0) {
    ctx.onProgress?.("No religion entities found - skipping pantheon generation");
    return result;
  }

  ctx.onProgress?.(`Generating pantheons for ${religionEntities.length} religions...`);

  // Form-to-deity count mapping
  const FORM_DEITY_COUNTS: Record<string, { min: number; max: number; guidance: string }> = {
    "Monotheism": { min: 1, max: 1, guidance: "Generate exactly ONE all-encompassing deity. This deity may have multiple aspects or manifestations, but is a single divine being." },
    "Dualism": { min: 2, max: 2, guidance: "Generate exactly TWO opposing deities representing complementary/opposing forces (light/dark, creation/destruction, order/chaos)." },
    "Polytheism": { min: 5, max: 12, guidance: "Generate a pantheon with a hierarchy: 1 supreme deity, 2-3 greater deities, and the rest as lesser deities. Each should have distinct domains." },
    "Shamanism": { min: 3, max: 8, guidance: "Generate nature spirits rather than traditional gods. Focus on elemental forces, animal spirits, and ancestral spirits. Use rank 'spirit' for all." },
    "Folk": { min: 2, max: 6, guidance: "Generate local/ancestral deities tied to everyday life - harvest, hearth, craft, luck. These are approachable, familiar figures, not distant cosmic beings." },
  };

  for (let i = 0; i < religionEntities.length; i++) {
    const relEntity = religionEntities[i];
    const azgaarReligionId = relEntity.azgaarReligionId;
    if (azgaarReligionId === undefined) continue;

    const religionContext = ctx.world.getReligionContext(azgaarReligionId);
    if (!religionContext) continue;

    // Skip if deities already exist
    const existingDeities = ctx.canon.listEntities({ type: "deity", limit: 100 })
      .filter(e => e.anchors?.azgaarReligionId === azgaarReligionId);
    if (existingDeities.length > 0) continue;

    const form = religionContext.form || "Polytheism";
    const formConfig = FORM_DEITY_COUNTS[form] || FORM_DEITY_COUNTS["Polytheism"];

    const startTime = Date.now();
    ctx.onEntityStart?.(relEntity.name, i, religionEntities.length);

    try {
      const religionInfo = [
        `Religion: ${relEntity.name}`,
        `Type: ${religionContext.type || "unknown"}`,
        `Form: ${form}`,
        religionContext.deity ? `Known deity: ${religionContext.deity}` : "",
        religionContext.originCulture ? `Origin culture: ${religionContext.originCulture.name}` : "",
        relEntity.summary ? `Summary: ${relEntity.summary}` : "",
        relEntity.beliefs?.length ? `Core beliefs: ${relEntity.beliefs.join("; ")}` : "",
      ].filter(Boolean).join("\n");

      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "deity",
        additionalLabels: ["pantheon", "religion", form].filter((s): s is string => !!s),
        anchor: {
          azgaarReligionId,
          tags: [relEntity.name, religionContext.originCulture?.name].filter((s): s is string => !!s),
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
Output ONLY valid JSON with "deities" array and optional "relations" array. If you wove in any of the optional design hints, list their IDs in a top-level "usedIdeaIds" string array.${ideaInjection.promptAddition}`;

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify({ religion: religionInfo }) }],
        maxTokens: 4000,
        temperature: 0.8,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      const deities = Array.isArray(data?.deities) ? data.deities : [];
      const relations = Array.isArray(data?.relations) ? data.relations : [];
      const keyToId = new Map<string, string>();

      for (const deity of deities) {
        const entity = ctx.canon.addEntity({
          type: "deity",
          name: deity.name || "Unknown Deity",
          summary: deity.summary,
          details_md: deity.details_md,
          tags: deity.tags || [],
          anchors: {
            azgaarReligionId,
            religionEntityId: relEntity.id,
          },
          payload: deity.payload || {},
          provenance: {
            generated_by: "world-init-pantheon",
            provider: ctx.llm.provider,
            model: ctx.llm.model,
            source: "pantheon",
            sourceReligionId: azgaarReligionId,
          },
        });
        keyToId.set(deity.key, entity.id);
        result.created += 1;

        // belongs_to relation
        ctx.canon.addRelation({
          from_id: entity.id,
          to_id: relEntity.id,
          rel_type: "belongs_to",
        });
      }

      // Inter-deity relations
      for (const rel of relations) {
        const fromId = keyToId.get(rel.from);
        const toId = keyToId.get(rel.to);
        if (fromId && toId) {
          ctx.canon.addRelation({
            from_id: fromId,
            to_id: toId,
            rel_type: rel.rel_type,
            notes: rel.notes,
          });
        }
      }

      const firstDeityId = keyToId.size > 0 ? keyToId.values().next().value : undefined;
      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, firstDeityId, ideaInjection.candidateIds);
      logIdeaBreadcrumb(`generatePantheonContent:${relEntity.name}`, ideaInjection.candidateIds, usedIdeas);

      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(relEntity.name, i, religionEntities.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(relEntity.name, i, religionEntities.length, 0, elapsedMs);
      result.errors.push(`Pantheon for ${relEntity.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

/**
 * Generate culture entities describing each culture
 */
export async function generateCultureContent(ctx: WorldGenContext): Promise<WorldGenResult> {
  const cultures = ctx.world.listCultures();
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  ctx.onProgress?.(`Generating cultures for ${cultures.length} peoples...`);

  for (let i = 0; i < cultures.length; i++) {
    const culture = cultures[i];
    const cultureContext = ctx.world.getCultureContext(culture.id);
    if (!cultureContext) continue;

    const startTime = Date.now();
    ctx.onEntityStart?.(culture.name, i, cultures.length);

    try {
      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "culture",
        anchor: {
          cultureId: culture.id,
          tags: [culture.name, cultureContext.type, ...(cultureContext.dominantBiomes || [])]
            .filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate a detailed culture description based on the provided context.
Consider how the biomes, geography, and associated religions would shape the culture.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "culture": {
    "name": "The [Culture Name]",
    "summary": "One-line description of the culture",
    "details_md": "Markdown description of history, values, social structure, art, architecture, traditions",
    "tags": ["culture-type", "key-trait"],
    "payload": {
      "dominantBiomes": ["biome names from context"],
      "traits": ["riverine", "martial", "mercantile", "scholarly", etc],
      "namingStyle": "Description of naming conventions",
      "customs": "Key customs and social norms",
      "values": ["core cultural values"],
      "aesthetics": "Art, architecture, clothing style",
      "governance": "Typical political organization",
      "relations": "How they typically relate to outsiders"
    }
  }
}${ideaInjection.promptAddition}`;

      const userPrompt = JSON.stringify({
        culture: {
          name: cultureContext.name,
          type: cultureContext.type,
          shield: cultureContext.shield,
          code: cultureContext.code,
          expansionism: cultureContext.expansionism,
        },
        dominantBiomes: cultureContext.dominantBiomes,
        states: cultureContext.states,
        religions: cultureContext.religions,
      });

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create culture entity
      const cultureEntity = ctx.canon.addEntity({
        type: "culture",
        name: data.culture?.name || culture.name,
        summary: data.culture?.summary,
        details_md: data.culture?.details_md,
        tags: data.culture?.tags || ["culture"],
        anchors: { cultureId: culture.id },
        payload: {
          ...data.culture?.payload,
          dominantBiomes: cultureContext.dominantBiomes,
        },
        provenance: {
          generated_by: "world-init",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "culture",
          sourceId: culture.id,
        },
      });
      result.created += 1;

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data.culture || data, cultureEntity.id, ideaInjection.candidateIds);
      logIdeaBreadcrumb(`generateCultureContent:${culture.name}`, ideaInjection.candidateIds, usedIdeas);

      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(culture.name, i, cultures.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(culture.name, i, cultures.length, 0, elapsedMs);
      result.errors.push(`Culture ${culture.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

// --- Planning and Parallel Execution Functions ---

/**
 * Plan world generation using LLM to create a holistic, themed plan
 * that accounts for campaign settings and relationships between entities.
 */
export async function planWorldGeneration(
  ctx: WorldGenContext,
  flags: GenerationFlags
): Promise<WorldGenPlan> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);

  // Gather context for all entities to generate
  const stateContexts: any[] = [];
  const religionContexts: any[] = [];
  const cultureContexts: any[] = [];

  if (flags.states) {
    const states = ctx.world.listStates();
    for (const state of states) {
      const sc = ctx.world.getStateContext(state.id);
      if (sc) {
        stateContexts.push({
          id: state.id,
          name: sc.name,
          fullName: sc.fullName,
          form: sc.form,
          formName: sc.formName,
          capital: sc.capital?.name,
          culture: sc.culture?.name,
          population: Math.round((sc.urban || 0) + (sc.rural || 0)),
        });
      }
    }
  }

  if (flags.religions) {
    const religions = ctx.world.listReligions();
    for (const religion of religions) {
      const rc = ctx.world.getReligionContext(religion.id);
      if (rc) {
        religionContexts.push({
          id: religion.id,
          name: rc.name,
          type: rc.type,
          form: rc.form,
          deity: rc.deity,
          originCulture: rc.originCulture?.name,
        });
      }
    }
  }

  if (flags.cultures) {
    const cultures = ctx.world.listCultures();
    for (const culture of cultures) {
      const cc = ctx.world.getCultureContext(culture.id);
      if (cc) {
        cultureContexts.push({
          id: culture.id,
          name: cc.name,
          type: cc.type,
          dominantBiomes: cc.dominantBiomes,
          states: cc.states?.map((s: any) => s.name),
          religions: cc.religions?.map((r: any) => r.name),
        });
      }
    }
  }

  // Show what we're planning for
  const stateCount = stateContexts.length;
  const religionCount = religionContexts.length;
  const cultureCount = cultureContexts.length;
  const totalEntities = stateCount * 2 + religionCount * 2 + cultureCount; // estimates

  ctx.onPlanProgress?.(`Planning for ${stateCount} states, ${religionCount} religions, ${cultureCount} cultures...`);
  ctx.onPlanProgress?.(`Estimated ~${totalEntities} entities to generate`);
  ctx.onPlanProgress?.("Calling LLM to create themed names and relationships...");

  const systemPrompt = `You are a world-building planning assistant for a tabletop RPG campaign.
Your job is to create a HOLISTIC generation plan that:
1. Assigns thematically appropriate names to all entities
2. Considers how states, religions, and cultures interrelate
3. Ensures consistency with the campaign tone and vibe
4. Creates interesting tensions and connections between groups

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON with this structure:
{
  "description": "Brief overview of what will be generated",
  "campaignTheme": "How the campaign settings influenced this plan",
  "entities": [
    {
      "category": "state|religion|culture",
      "sourceId": 123,
      "sourceName": "Original Azgaar name",
      "thematicNotes": "How this fits the campaign vibe",
      "entitiesToGenerate": [
        {
          "type": "faction|npc|culture",
          "name": "Themed name for this entity",
          "role": "government|ruler|religious-faction|high-priest|culture-description",
          "reason": "Why this name/approach fits"
        }
      ]
    }
  ],
  "relationships": [
    {
      "fromCategory": "state",
      "fromSourceId": 1,
      "fromRole": "ruler",
      "toCategory": "religion",
      "toSourceId": 2,
      "toRole": "religious-faction",
      "relationType": "patron_of|ally|rival|secret_member"
    }
  ]
}

IMPORTANT GUIDELINES:
- For each STATE: create a government faction and a ruler NPC
- For each RELIGION: create a religious faction and 1-2 religious figures (high priest, prophet, etc.)
- For each CULTURE: create a culture entity describing the people
- Names should be evocative and fit the campaign tone
- Consider cross-category relationships (e.g., a ruler who secretly follows a different religion)
- Keep the total reasonable - don't over-complicate`;

  const userPrompt = JSON.stringify({
    states: stateContexts,
    religions: religionContexts,
    cultures: cultureContexts,
  });

  debugLog("[planWorldGeneration] Calling completeJsonWithUsage...");
  const { data, usage } = await completeJsonWithUsage(ctx.llm, {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4000,
    temperature: 0.7,
  });
  debugLog(`[planWorldGeneration] API returned, data keys: ${Object.keys(data || {}).join(", ")}`);

  if (usage && ctx.onTokens) {
    debugLog("[planWorldGeneration] Reporting token usage...");
    ctx.onTokens(usage);
  }

  // Validate and normalize the plan
  debugLog(`[planWorldGeneration] Normalizing plan, entities count: ${(data.entities || []).length}`);
  const plan: WorldGenPlan = {
    description: data.description || "World generation plan",
    campaignTheme: data.campaignTheme || "",
    entities: (data.entities || []).map((e: any) => ({
      category: e.category,
      sourceId: e.sourceId,
      sourceName: e.sourceName || "",
      thematicNotes: e.thematicNotes || "",
      entitiesToGenerate: (e.entitiesToGenerate || []).map((g: any) => ({
        type: g.type as EntityType,
        name: g.name,
        role: g.role,
        reason: g.reason || "",
      })),
    })),
    relationships: (data.relationships || []).map((r: any) => ({
      fromCategory: r.fromCategory,
      fromSourceId: r.fromSourceId,
      fromRole: r.fromRole,
      toCategory: r.toCategory,
      toSourceId: r.toSourceId,
      toRole: r.toRole,
      relationType: r.relationType,
    })),
  };

  debugLog(`[planWorldGeneration] Returning plan with ${plan.entities.length} entity plans and ${plan.relationships.length} relationships`);
  return plan;
}

/**
 * Format a WorldGenPlan for display/approval
 */
export function formatWorldGenPlan(plan: WorldGenPlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];

  lines.push(`${BOLD}${CYAN}World Generation Plan${RESET}`);
  lines.push(`${DIM}${plan.description}${RESET}`);
  if (plan.campaignTheme) {
    lines.push(`${DIM}Theme: ${plan.campaignTheme}${RESET}`);
  }
  lines.push("");

  // Count entities by category
  const counts: Record<string, number> = { state: 0, religion: 0, pantheon: 0, culture: 0, total: 0 };
  for (const entity of plan.entities) {
    counts[entity.category] += entity.entitiesToGenerate.length;
    counts.total += entity.entitiesToGenerate.length;
  }

  lines.push(`${BOLD}Summary:${RESET}`);
  lines.push(`  ${counts.state} state entities (governments + rulers)`);
  lines.push(`  ${counts.religion} religion entities (factions + figures)`);
  lines.push(`  ${counts.culture} culture entities`);
  lines.push(`  ${counts.total} total entities`);
  if (plan.relationships.length > 0) {
    lines.push(`  ${plan.relationships.length} cross-category relationships`);
  }
  lines.push("");

  // Group by category
  const byCategory: Record<string, WorldEntityPlan[]> = {
    state: [],
    religion: [],
    culture: [],
  };
  for (const entity of plan.entities) {
    byCategory[entity.category].push(entity);
  }

  // Display states
  if (byCategory.state.length > 0) {
    lines.push(`${BOLD}States:${RESET}`);
    for (const entity of byCategory.state) {
      lines.push(`  ${GREEN}${entity.sourceName}${RESET}`);
      for (const e of entity.entitiesToGenerate) {
        const icon = e.type === "faction" ? "🏛️" : e.type === "npc" ? "👤" : "📄";
        lines.push(`    ${icon} ${e.name} ${DIM}(${e.role})${RESET}`);
      }
    }
    lines.push("");
  }

  // Display religions
  if (byCategory.religion.length > 0) {
    lines.push(`${BOLD}Religions:${RESET}`);
    for (const entity of byCategory.religion) {
      lines.push(`  ${YELLOW}${entity.sourceName}${RESET}`);
      for (const e of entity.entitiesToGenerate) {
        const icon = e.type === "faction" ? "⛪" : e.type === "npc" ? "👤" : "📄";
        lines.push(`    ${icon} ${e.name} ${DIM}(${e.role})${RESET}`);
      }
    }
    lines.push("");
  }

  // Display cultures
  if (byCategory.culture.length > 0) {
    lines.push(`${BOLD}Cultures:${RESET}`);
    for (const entity of byCategory.culture) {
      lines.push(`  ${CYAN}${entity.sourceName}${RESET}`);
      for (const e of entity.entitiesToGenerate) {
        lines.push(`    📜 ${e.name} ${DIM}(${e.role})${RESET}`);
      }
    }
    lines.push("");
  }

  // Display relationships if any
  if (plan.relationships.length > 0) {
    lines.push(`${BOLD}Relationships:${RESET}`);
    for (const rel of plan.relationships.slice(0, 5)) {
      lines.push(`  ${DIM}${rel.fromRole} → ${rel.toRole}: ${rel.relationType}${RESET}`);
    }
    if (plan.relationships.length > 5) {
      lines.push(`  ${DIM}... and ${plan.relationships.length - 5} more${RESET}`);
    }
  }

  return lines.join("\n");
}

type GeneratedEntity = {
  plan: WorldEntityPlan;
  subEntity: WorldEntityPlan["entitiesToGenerate"][0];
  result: any;
  usage?: TokenUsage;
  elapsedMs: number;
  error?: string;
  candidateIdeaIds?: string[];
};

/**
 * Execute a WorldGenPlan, running all LLM calls in parallel
 * then writing to DB sequentially.
 */
export async function executeWorldGeneration(
  ctx: WorldGenContext,
  plan: WorldGenPlan
): Promise<WorldGenResult> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  // Flatten all entities to generate
  const allEntities: Array<{
    plan: WorldEntityPlan;
    subEntity: WorldEntityPlan["entitiesToGenerate"][0];
  }> = [];

  for (const entityPlan of plan.entities) {
    for (const subEntity of entityPlan.entitiesToGenerate) {
      allEntities.push({ plan: entityPlan, subEntity });
    }
  }

  if (allEntities.length === 0) {
    return result;
  }

  ctx.onProgress?.(`Generating ${allEntities.length} entities in parallel...`);

  // Generate a single entity
  const generateOne = async (
    entityPlan: WorldEntityPlan,
    subEntity: typeof allEntities[0]["subEntity"],
    index: number
  ): Promise<GeneratedEntity> => {
    const startTime = Date.now();
    ctx.onEntityStart?.(subEntity.name, index, allEntities.length);

    const anchorBase: any = { tags: [entityPlan.sourceName, subEntity.role].filter(Boolean) };
    if (entityPlan.category === "state") anchorBase.stateId = entityPlan.sourceId;
    else if (entityPlan.category === "religion") anchorBase.azgaarReligionId = entityPlan.sourceId;
    else if (entityPlan.category === "culture") anchorBase.cultureId = entityPlan.sourceId;
    const ideaInjection = prepareIdeaInjection({
      canon: ctx.canon,
      entityType: subEntity.type,
      additionalLabels: [entityPlan.category, subEntity.role].filter(Boolean) as string[],
      anchor: anchorBase,
    });

    try {
      let systemPrompt = "";
      let userPrompt = "";

      if (subEntity.type === "faction" && entityPlan.category === "state") {
        // Government faction
        systemPrompt = `You are a world-building assistant. Generate a detailed government faction.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${subEntity.name}",
  "summary": "One-line description",
  "details_md": "Markdown description of how the government operates",
  "tags": ["government", "type"],
  "payload": {
    "kind": "government",
    "governmentType": "Monarchy|Republic|Theocracy|etc",
    "industries": ["major", "industries"],
    "militaryStrength": "weak|moderate|strong|dominant"
  }
}`;
        const stateContext = ctx.world.getStateContext(entityPlan.sourceId);
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          state: stateContext ? {
            name: stateContext.name,
            fullName: stateContext.fullName,
            form: stateContext.form,
            formName: stateContext.formName,
          } : { name: entityPlan.sourceName },
        });
      } else if (subEntity.type === "npc" && entityPlan.category === "state") {
        // Ruler NPC
        systemPrompt = `You are a world-building assistant. Generate a detailed ruler NPC.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${subEntity.name}",
  "summary": "One-line public description",
  "details_md": "Background, personality, secrets",
  "tags": ["ruler", "royalty|noble|elected"],
  "payload": {
    "role": "King|Queen|President|etc",
    "personality": "key traits",
    "appearance": "physical description",
    "motivations": ["what drives them"],
    "secrets": ["personal secrets"]
  }
}`;
        const stateContext = ctx.world.getStateContext(entityPlan.sourceId);
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          state: stateContext ? {
            name: stateContext.name,
            fullName: stateContext.fullName,
            form: stateContext.formName,
          } : { name: entityPlan.sourceName },
        });
      } else if (subEntity.type === "faction" && entityPlan.category === "religion") {
        // Religious faction
        systemPrompt = `You are a world-building assistant. Generate a detailed religious faction.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${subEntity.name}",
  "summary": "One-line description",
  "details_md": "Markdown description of beliefs, practices, holy sites",
  "tags": ["religion", "type"],
  "payload": {
    "kind": "religion",
    "religionType": "Folk|Organized|Cult|Heresy",
    "form": "Shamanism|Polytheism|Dualism|etc",
    "deity": "deity name and epithet",
    "practices": ["key rituals"],
    "holySites": ["notable locations"],
    "beliefs": ["core tenets"]
  }
}`;
        const religionContext = ctx.world.getReligionContext(entityPlan.sourceId);
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          religion: religionContext ? {
            name: religionContext.name,
            type: religionContext.type,
            form: religionContext.form,
            deity: religionContext.deity,
          } : { name: entityPlan.sourceName },
        });
      } else if (subEntity.type === "npc" && entityPlan.category === "religion") {
        // Religious figure
        systemPrompt = `You are a world-building assistant. Generate a detailed religious figure NPC.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${subEntity.name}",
  "summary": "One-line description",
  "details_md": "Background and role",
  "tags": ["religious", "role"],
  "payload": {
    "role": "${subEntity.role}",
    "personality": "key traits",
    "motivations": ["what drives them"],
    "secrets": ["hidden aspects"]
  }
}`;
        const religionContext = ctx.world.getReligionContext(entityPlan.sourceId);
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          religion: religionContext ? {
            name: religionContext.name,
            type: religionContext.type,
            deity: religionContext.deity,
          } : { name: entityPlan.sourceName },
        });
      } else if (subEntity.type === "culture") {
        // Culture entity
        systemPrompt = `You are a world-building assistant. Generate a detailed culture description.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${subEntity.name}",
  "summary": "One-line description",
  "details_md": "Markdown description of history, values, social structure, traditions",
  "tags": ["culture-type", "key-trait"],
  "payload": {
    "traits": ["riverine", "martial", "mercantile", etc],
    "namingStyle": "Description of naming conventions",
    "customs": "Key customs and social norms",
    "values": ["core cultural values"],
    "aesthetics": "Art, architecture, clothing style",
    "governance": "Typical political organization"
  }
}`;
        const cultureContext = ctx.world.getCultureContext(entityPlan.sourceId);
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          culture: cultureContext ? {
            name: cultureContext.name,
            type: cultureContext.type,
            dominantBiomes: cultureContext.dominantBiomes,
          } : { name: entityPlan.sourceName },
        });
      } else {
        // Fallback for any other type
        systemPrompt = `You are a world-building assistant. Generate a ${subEntity.type} entity.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON with name, summary, details_md, tags, and payload fields.`;
        userPrompt = JSON.stringify({
          plannedName: subEntity.name,
          role: subEntity.role,
          reason: subEntity.reason,
          thematicNotes: entityPlan.thematicNotes,
          source: entityPlan.sourceName,
        });
      }

      const fullSystemPrompt = systemPrompt + ideaInjection.promptAddition;
      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: fullSystemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      const elapsedMs = Date.now() - startTime;
      return {
        plan: entityPlan,
        subEntity,
        result: data,
        usage,
        elapsedMs,
        candidateIdeaIds: ideaInjection.candidateIds,
      };
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      return {
        plan: entityPlan,
        subEntity,
        result: null,
        elapsedMs,
        error: e?.message || String(e),
        candidateIdeaIds: ideaInjection.candidateIds,
      };
    }
  };

  // Run all generations in parallel
  const generatedEntities = await Promise.all(
    allEntities.map((item, index) => generateOne(item.plan, item.subEntity, index))
  );

  // Write to DB sequentially and track created IDs for relationships
  const entityIdMap: Map<string, string> = new Map(); // "category:sourceId:role" -> entity ID

  for (let i = 0; i < generatedEntities.length; i++) {
    const gen = generatedEntities[i];
    const { plan: entityPlan, subEntity, result: data, elapsedMs, error, usage } = gen;

    if (error || !data) {
      result.errors.push(`${subEntity.name}: ${error || "No data returned"}`);
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, 0, elapsedMs);
      continue;
    }

    try {
      // Determine anchors based on category
      const anchors: Record<string, any> = {};
      if (entityPlan.category === "state") {
        anchors.stateId = entityPlan.sourceId;
        // For rulers, also anchor to capital burg if available
        if (subEntity.type === "npc" && subEntity.role.includes("ruler")) {
          const stateContext = ctx.world.getStateContext(entityPlan.sourceId);
          if (stateContext?.capital?.id) {
            anchors.burgId = stateContext.capital.id;
          }
        }
      } else if (entityPlan.category === "religion") {
        anchors.religionId = entityPlan.sourceId;
      } else if (entityPlan.category === "culture") {
        anchors.cultureId = entityPlan.sourceId;
      }

      const entity = ctx.canon.addEntity({
        type: subEntity.type,
        name: data.name || subEntity.name,
        summary: data.summary,
        details_md: data.details_md,
        tags: data.tags || [subEntity.role],
        anchors,
        payload: data.payload || {},
        provenance: {
          generated_by: "world-init-plan",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: entityPlan.category,
          sourceId: entityPlan.sourceId,
          role: subEntity.role,
        },
      });

      // Track for relationship creation
      const key = `${entityPlan.category}:${entityPlan.sourceId}:${subEntity.role}`;
      entityIdMap.set(key, entity.id);

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, entity.id, gen.candidateIdeaIds || []);
      logIdeaBreadcrumb(`executeWorldGeneration:${entityPlan.category}/${subEntity.role}`, gen.candidateIdeaIds || [], usedIdeas);

      result.created += 1;
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      result.errors.push(`${subEntity.name}: ${e?.message || String(e)}`);
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, 0, elapsedMs);
    }
  }

  // Create relationships
  for (const rel of plan.relationships) {
    // Find matching entities - we need to find by role pattern
    let fromId: string | undefined;
    let toId: string | undefined;

    // Look for entities matching the relationship
    for (const [key, id] of entityIdMap.entries()) {
      const [cat, srcId, role] = key.split(":");
      if (cat === rel.fromCategory && srcId === String(rel.fromSourceId) && role.includes(rel.fromRole)) {
        fromId = id;
      }
      if (cat === rel.toCategory && srcId === String(rel.toSourceId) && role.includes(rel.toRole)) {
        toId = id;
      }
    }

    if (fromId && toId && fromId !== toId) {
      try {
        ctx.canon.addRelation({
          from_id: fromId,
          to_id: toId,
          rel_type: rel.relationType,
        });
      } catch (e: any) {
        debugLog(`Failed to create relationship: ${e?.message}`);
      }
    }
  }

  // Create implicit relationships (rulers lead governments within same state)
  for (const entityPlan of plan.entities) {
    if (entityPlan.category === "state") {
      const rulerKey = `state:${entityPlan.sourceId}:ruler`;
      const govKey = `state:${entityPlan.sourceId}:government`;
      const rulerId = entityIdMap.get(rulerKey);
      const govId = entityIdMap.get(govKey);
      if (rulerId && govId) {
        try {
          ctx.canon.addRelation({
            from_id: rulerId,
            to_id: govId,
            rel_type: "leads",
            strength: 1.0,
          });
        } catch (e: any) {
          debugLog(`Failed to create ruler-government relation: ${e?.message}`);
        }
      }
    } else if (entityPlan.category === "religion") {
      // Link religious figures to their factions
      const factionKey = `religion:${entityPlan.sourceId}:religious-faction`;
      const factionId = entityIdMap.get(factionKey);
      if (factionId) {
        for (const [key, id] of entityIdMap.entries()) {
          const [cat, srcId, role] = key.split(":");
          if (cat === "religion" && srcId === String(entityPlan.sourceId) && role !== "religious-faction") {
            const isLeader = role.includes("high") || role.includes("prophet") || role.includes("leader");
            try {
              ctx.canon.addRelation({
                from_id: id,
                to_id: factionId,
                rel_type: isLeader ? "leads" : "member_of",
                strength: isLeader ? 1.0 : 0.7,
              });
            } catch (e: any) {
              debugLog(`Failed to create religion figure relation: ${e?.message}`);
            }
          }
        }
      }
    }
  }

  return result;
}

// --- Enhanced generation functions with context from previous phases ---

/**
 * Generate culture entities with religion context from DB
 * Phase 2 of phased generation - includes generated religions
 */
export async function generateCultureContentWithReligions(ctx: WorldGenContext): Promise<WorldGenResult> {
  const cultures = ctx.world.listCultures();
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  // Query previously generated religions
  const generatedReligions = getGeneratedReligions(ctx.canon);
  const religionContext = formatReligionsForPrompt(generatedReligions);

  ctx.onProgress?.(`Generating cultures for ${cultures.length} peoples (with religion context)...`);

  for (let i = 0; i < cultures.length; i++) {
    const culture = cultures[i];
    const cultureContext = ctx.world.getCultureContext(culture.id);
    if (!cultureContext) continue;

    const startTime = Date.now();
    ctx.onEntityStart?.(culture.name, i, cultures.length);

    try {
      const ideaInjectionPhased = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "culture",
        additionalLabels: ["culture"],
        anchor: {
          cultureId: culture.id,
          tags: [culture.name, cultureContext.type, ...(cultureContext.dominantBiomes || [])]
            .filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate a detailed culture description based on the provided context.
Consider how the biomes, geography, AND the established religions would shape this culture.
${religionContext ? `\nThe religions in this world are:\n${religionContext}\n\nConsider how these religions influence cultural values, practices, and social norms.` : ""}
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "culture": {
    "name": "The [Culture Name]",
    "summary": "One-line description of the culture",
    "details_md": "Markdown description of history, values, social structure, art, architecture, traditions, and how religion shapes daily life",
    "tags": ["culture-type", "key-trait"],
    "payload": {
      "dominantBiomes": ["biome names from context"],
      "traits": ["riverine", "martial", "mercantile", "scholarly", etc],
      "namingStyle": "Description of naming conventions",
      "customs": "Key customs and social norms",
      "values": ["core cultural values"],
      "aesthetics": "Art, architecture, clothing style",
      "governance": "Typical political organization",
      "relations": "How they typically relate to outsiders",
      "dominantReligion": "Primary religion if applicable"
    }
  }
}${ideaInjectionPhased.promptAddition}`;

      const userPrompt = JSON.stringify({
        culture: {
          name: cultureContext.name,
          type: cultureContext.type,
          shield: cultureContext.shield,
          code: cultureContext.code,
          expansionism: cultureContext.expansionism,
        },
        dominantBiomes: cultureContext.dominantBiomes,
        states: cultureContext.states,
        religions: cultureContext.religions,
        generatedReligions: generatedReligions.slice(0, 5).map(r => ({ name: r.name, summary: r.summary })),
      });

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2000,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create culture entity
      const phasedCultureEntity = ctx.canon.addEntity({
        type: "culture",
        name: data.culture?.name || culture.name,
        summary: data.culture?.summary,
        details_md: data.culture?.details_md,
        tags: data.culture?.tags || ["culture"],
        anchors: { cultureId: culture.id },
        payload: {
          ...data.culture?.payload,
          dominantBiomes: cultureContext.dominantBiomes,
        },
        provenance: {
          generated_by: "world-init-phased",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "culture",
          sourceId: culture.id,
          phase: 2,
        },
      });
      result.created += 1;

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data.culture || data, phasedCultureEntity.id, ideaInjectionPhased.candidateIds);
      logIdeaBreadcrumb(`generateCultureContentWithReligions:${culture.name}`, ideaInjectionPhased.candidateIds, usedIdeas);

      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(culture.name, i, cultures.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(culture.name, i, cultures.length, 0, elapsedMs);
      result.errors.push(`Culture ${culture.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

/**
 * Generate state content with religion and culture context from DB
 * Phase 3 of phased generation - includes generated religions and cultures
 */
export async function generateStateContentWithContext(ctx: WorldGenContext): Promise<WorldGenResult> {
  const states = ctx.world.listStates();
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  // Query previously generated religions and cultures
  const generatedReligions = getGeneratedReligions(ctx.canon);
  const generatedCultures = getGeneratedCultures(ctx.canon);
  const religionContext = formatReligionsForPrompt(generatedReligions);
  const cultureContext = formatCulturesForPrompt(generatedCultures);

  ctx.onProgress?.(`Generating governments for ${states.length} states (with religion & culture context)...`);

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const stateContext = ctx.world.getStateContext(state.id);
    if (!stateContext) continue;

    const startTime = Date.now();
    ctx.onEntityStart?.(state.name, i, states.length);

    try {
      const ideaInjectionStateCtx = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: "state",
        additionalLabels: ["government", "ruler"],
        anchor: {
          stateId: state.id,
          tags: [state.name, stateContext.formName, stateContext.culture?.name].filter((s): s is string => !!s),
        },
      });

      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate a government faction and its ruler for a state based on the provided context.
${religionContext ? `\nThe religions in this world are:\n${religionContext}\n` : ""}
${cultureContext ? `\nThe cultures in this world are:\n${cultureContext}\n` : ""}
Consider how the dominant religion and culture shape the government's policies, legitimacy, and the ruler's personality.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "government": {
    "name": "The Crown of [State]",
    "summary": "One-line description of the government",
    "details_md": "Markdown description of how the government operates, its relationship with religion and culture, notable policies",
    "tags": ["government", "monarchy|republic|theocracy|etc"],
    "payload": {
      "kind": "government",
      "governmentType": "Monarchy|Republic|Theocracy|etc",
      "industries": ["major", "industries"],
      "militaryStrength": "weak|moderate|strong|dominant",
      "stateReligion": "Primary religion if any",
      "culturalInfluence": "How culture shapes governance"
    }
  },
  "ruler": {
    "name": "Title Firstname Lastname",
    "summary": "One-line public description",
    "details_md": "Background, personality, religious beliefs, cultural values, secrets",
    "tags": ["ruler", "royalty|noble|elected|etc"],
    "payload": {
      "role": "King|Queen|President|etc",
      "personality": "key traits",
      "appearance": "physical description",
      "motivations": ["what drives them"],
      "secrets": ["personal secrets"],
      "religiousBeliefs": "Their faith and how devout they are",
      "culturalBackground": "Their cultural identity"
    }
  }
}${ideaInjectionStateCtx.promptAddition}`;

      const userPrompt = JSON.stringify({
        state: {
          name: stateContext.name,
          fullName: stateContext.fullName,
          form: stateContext.form,
          formName: stateContext.formName,
        },
        capital: stateContext.capital,
        culture: stateContext.culture,
        military: stateContext.military,
        campaigns: stateContext.campaigns?.slice(0, 5),
        diplomacy: stateContext.diplomacy?.filter((d: any) => d.relation !== "Neutral").slice(0, 5),
        geographic: stateContext.geographic,
        population: {
          urban: Math.round(stateContext.urban || 0),
          rural: Math.round(stateContext.rural || 0),
          burgCount: stateContext.burgCount,
        },
        generatedReligions: generatedReligions.slice(0, 5).map(r => ({ name: r.name, summary: r.summary })),
        generatedCultures: generatedCultures.slice(0, 5).map(c => ({ name: c.name, summary: c.summary })),
      });

      const { data, usage } = await completeJsonWithUsage(ctx.llm, {
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 2500,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create government faction
      const govEntity = ctx.canon.addEntity({
        type: "faction",
        name: data.government?.name || `Government of ${state.name}`,
        summary: data.government?.summary,
        details_md: data.government?.details_md,
        tags: data.government?.tags || ["government"],
        anchors: { stateId: state.id },
        payload: data.government?.payload || { kind: "government" },
        provenance: {
          generated_by: "world-init-phased",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "state",
          sourceId: state.id,
          phase: 3,
        },
      });

      // Create ruler NPC
      const rulerEntity = ctx.canon.addEntity({
        type: "npc",
        name: data.ruler?.name || `Ruler of ${state.name}`,
        summary: data.ruler?.summary,
        details_md: data.ruler?.details_md,
        tags: data.ruler?.tags || ["ruler"],
        anchors: {
          stateId: state.id,
          burgId: stateContext.capital?.id,
        },
        payload: data.ruler?.payload || { role: "Ruler" },
        provenance: {
          generated_by: "world-init-phased",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "state",
          sourceId: state.id,
          phase: 3,
        },
      });

      // Link ruler to government
      ctx.canon.addRelation({
        from_id: rulerEntity.id,
        to_id: govEntity.id,
        rel_type: "leads",
        strength: 1.0,
      });

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, govEntity.id, ideaInjectionStateCtx.candidateIds);
      logIdeaBreadcrumb(`generateStateContentWithContext:${state.name}`, ideaInjectionStateCtx.candidateIds, usedIdeas);

      result.created += 2;
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(state.name, i, states.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      ctx.onEntityComplete?.(state.name, i, states.length, 0, elapsedMs);
      result.errors.push(`State ${state.name}: ${e?.message || String(e)}`);
    }
  }

  return result;
}

// --- Phased Execution ---

/**
 * Execute world generation in up to 4 sequential phases:
 * Phase 1: Religions (uses vibe/story context)
 * Phase 1b: Pantheons (generates deities for each religion)
 * Phase 2: Cultures (queries generated religions from DB)
 * Phase 3: States + Rulers (queries generated religions and cultures from DB)
 *
 * Each phase writes to DB before the next phase starts.
 */
export async function executePhasedWorldGeneration(
  ctx: WorldGenContext,
  flags: GenerationFlags,
  onPhaseStart?: (phase: 1 | 2 | 3, name: string) => void,
  onPhaseComplete?: (phase: 1 | 2 | 3, result: WorldGenResult) => void
): Promise<WorldGenResult> {
  const totalResult: WorldGenResult = { created: 0, errors: [] };

  // Phase 1: Religions (uses vibe/story only)
  if (flags.religions) {
    onPhaseStart?.(1, "Religions");
    ctx.onProgress?.("Phase 1/4: Generating religions...");
    const result = await generateReligionContent(ctx);
    totalResult.created += result.created;
    totalResult.errors.push(...result.errors);
    onPhaseComplete?.(1, result);
    debugLog(`[Phased] Phase 1 complete: ${result.created} religions created`);
  }

  // Phase 1b: Pantheons (generates deities for each religion)
  if (flags.pantheons) {
    onPhaseStart?.(1, "Pantheons");
    ctx.onProgress?.("Phase 1b/4: Generating pantheons (deities for each religion)...");
    const result = await generatePantheonContent(ctx);
    totalResult.created += result.created;
    totalResult.errors.push(...result.errors);
    onPhaseComplete?.(1, result);
    debugLog(`[Phased] Phase 1b complete: ${result.created} deities created`);
  }

  // Phase 2: Cultures (queries generated religions from DB)
  if (flags.cultures) {
    onPhaseStart?.(2, "Cultures");
    ctx.onProgress?.("Phase 2/4: Generating cultures (with religion context)...");
    const result = await generateCultureContentWithReligions(ctx);
    totalResult.created += result.created;
    totalResult.errors.push(...result.errors);
    onPhaseComplete?.(2, result);
    debugLog(`[Phased] Phase 2 complete: ${result.created} cultures created`);
  }

  // Phase 3: States + Rulers (queries generated religions and cultures from DB)
  if (flags.states) {
    onPhaseStart?.(3, "States");
    ctx.onProgress?.("Phase 3/4: Generating states (with religion & culture context)...");
    const result = await generateStateContentWithContext(ctx);
    totalResult.created += result.created;
    totalResult.errors.push(...result.errors);
    onPhaseComplete?.(3, result);
    debugLog(`[Phased] Phase 3 complete: ${result.created} state entities created`);
  }

  return totalResult;
}

// --- Phase-Specific Planning and Execution ---

/**
 * Get religion IDs that are relevant to the specified states.
 * First tries to find dominant religions from cell data.
 * Falls back to religions associated with each state's culture if no dominant religion is found.
 */
function getReligionsForStates(world: AzgaarWorld, stateIds: number[]): Set<number> {
  const religionIds = new Set<number>();
  for (const stateId of stateIds) {
    const dominantReligion = world.getStateDominantReligion(stateId);
    if (dominantReligion) {
      religionIds.add(dominantReligion.id);
    } else {
      // Fallback: use religions associated with the state's culture
      const sc = world.getStateContext(stateId);
      if (sc?.culture?.id !== undefined) {
        const cultureCtx = world.getCultureContext(sc.culture.id);
        if (cultureCtx?.religions) {
          for (const rel of cultureCtx.religions) {
            religionIds.add(rel.id);
          }
        }
      }
    }
  }
  return religionIds;
}

/**
 * Get culture IDs that are associated with the specified states
 */
function getCulturesForStates(world: AzgaarWorld, stateIds: number[]): Set<number> {
  const cultureIds = new Set<number>();
  for (const stateId of stateIds) {
    const sc = world.getStateContext(stateId);
    if (sc?.culture?.id !== undefined) {
      cultureIds.add(sc.culture.id);
    }
  }
  return cultureIds;
}

export type PhasePlan = {
  phase: "religions" | "pantheons" | "cultures" | "states";
  description: string;
  campaignTheme: string;
  entities: WorldEntityPlan[];
};

/**
 * Plan religion generation - creates religion entities (theological content)
 *
 * Each religion gets one entity containing deity, beliefs, practices, holy sites, etc.
 * Religious factions and leaders can be added separately as needed.
 *
 * If ctx.stateFilter is provided, only includes religions dominant in those states.
 */
export async function planReligionGeneration(ctx: WorldGenContext): Promise<PhasePlan> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  let religions = ctx.world.listReligions();

  // Filter to religions present in selected states if stateFilter is provided
  if (ctx.stateFilter && ctx.stateFilter.length > 0) {
    const relevantReligionIds = getReligionsForStates(ctx.world, ctx.stateFilter);
    religions = religions.filter(r => relevantReligionIds.has(r.id));
    debugLog(`[planReligionGeneration] Filtered to ${religions.length} religions for ${ctx.stateFilter.length} states`);
  }

  const religionContexts = religions.map(religion => {
    const rc = ctx.world.getReligionContext(religion.id);
    return rc ? {
      id: religion.id,
      name: rc.name,
      type: rc.type,
      form: rc.form,
      deity: rc.deity,
      originCulture: rc.originCulture?.name,
    } : null;
  }).filter(Boolean);

  ctx.onPlanProgress?.(`Planning ${religionContexts.length} religions...`);

  const systemPrompt = `You are a world-building planning assistant for a tabletop RPG campaign.
Create a generation plan for RELIGIONS. Each religion needs one entity describing:
- The faith's theology, deity/deities, core beliefs
- Sacred practices and rituals
- Holy sites and taboos

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "description": "Brief overview of religions to generate",
  "campaignTheme": "How campaign settings influenced naming/tone",
  "entities": [
    {
      "category": "religion",
      "sourceId": 123,
      "sourceName": "Original religion name",
      "thematicNotes": "How this fits the campaign",
      "entitiesToGenerate": [
        {
          "type": "religion",
          "name": "The Eternal Flame",
          "role": "religion-theology",
          "reason": "Why this name fits the faith"
        }
      ]
    }
  ]
}

IMPORTANT:
- Each religion needs exactly ONE religion entity
- Focus on evocative names that fit the campaign tone
- The religion entity represents the faith/theology itself (not an organization)`;

  const userPrompt = JSON.stringify({ religions: religionContexts });

  const { data, usage } = await completeJsonWithUsage(ctx.llm, {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 2500,
    temperature: 0.7,
  });

  if (usage && ctx.onTokens) {
    ctx.onTokens(usage);
  }

  return {
    phase: "religions",
    description: data.description || "Religion generation plan",
    campaignTheme: data.campaignTheme || "",
    entities: (data.entities || []).map((e: any) => ({
      category: "religion" as const,
      sourceId: e.sourceId,
      sourceName: e.sourceName || "",
      thematicNotes: e.thematicNotes || "",
      entitiesToGenerate: (e.entitiesToGenerate || []).map((g: any) => ({
        type: g.type as EntityType,
        name: g.name,
        role: g.role,
        reason: g.reason || "",
      })),
    })),
  };
}

/**
 * Plan pantheon generation - creates deity entities for each religion
 *
 * Uses generated religion entities from DB for context. Deity count
 * is determined by religion form (Monotheism=1, Polytheism=5-12, etc.)
 */
export async function planPantheonGeneration(ctx: WorldGenContext): Promise<PhasePlan> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const religionEntities = getGeneratedReligionEntities(ctx.canon);

  // Filter to religions that don't already have deities
  const religionsNeedingPantheon = religionEntities.filter(re => {
    if (re.azgaarReligionId === undefined) return false;
    const existing = ctx.canon.listEntities({ type: "deity", limit: 100 })
      .filter(e => e.anchors?.azgaarReligionId === re.azgaarReligionId);
    return existing.length === 0;
  });

  ctx.onPlanProgress?.(`Planning pantheons for ${religionsNeedingPantheon.length} religions...`);

  const FORM_COUNTS: Record<string, string> = {
    "Monotheism": "1 deity",
    "Dualism": "2 opposing deities",
    "Polytheism": "5-12 deities",
    "Shamanism": "3-8 spirits",
    "Folk": "2-6 local deities",
  };

  // Build entities list from religion data
  const entities: WorldEntityPlan[] = religionsNeedingPantheon.map(re => {
    const rc = re.azgaarReligionId !== undefined
      ? ctx.world.getReligionContext(re.azgaarReligionId)
      : undefined;
    const form = rc?.form || "Polytheism";
    const countDesc = FORM_COUNTS[form] || "5-12 deities";

    return {
      category: "pantheon",
      sourceId: re.azgaarReligionId || 0,
      sourceName: re.name,
      thematicNotes: `${form} — ${countDesc}`,
      entitiesToGenerate: [{
        type: "deity" as EntityType,
        name: `Pantheon of ${re.name}`,
        role: "deity-pantheon",
        reason: `Generate ${countDesc} for this ${form} religion`,
      }],
    };
  });

  return {
    phase: "pantheons",
    description: `Generate deity pantheons for ${religionsNeedingPantheon.length} religions`,
    campaignTheme: campaignContext || "",
    entities,
  };
}

/**
 * Plan culture generation - uses generated religions from DB for context
 *
 * If ctx.stateFilter is provided, only includes cultures associated with those states.
 */
export async function planCultureGeneration(ctx: WorldGenContext): Promise<PhasePlan> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  let cultures = ctx.world.listCultures();

  // Filter to cultures present in selected states if stateFilter is provided
  if (ctx.stateFilter && ctx.stateFilter.length > 0) {
    const relevantCultureIds = getCulturesForStates(ctx.world, ctx.stateFilter);
    cultures = cultures.filter(c => relevantCultureIds.has(c.id));
    debugLog(`[planCultureGeneration] Filtered to ${cultures.length} cultures for ${ctx.stateFilter.length} states`);
  }

  // Get generated religion entities for context (with full details)
  const generatedReligionEntities = getGeneratedReligionEntities(ctx.canon);

  // Build a map of azgaarReligionId -> generated religion details
  const religionDetailsMap = new Map<number, {
    name: string;
    summary: string;
    deity?: string;
    beliefs?: string[];
  }>();
  for (const rel of generatedReligionEntities) {
    if (rel.azgaarReligionId !== undefined) {
      religionDetailsMap.set(rel.azgaarReligionId, {
        name: rel.name,
        summary: rel.summary,
        deity: rel.deity,
        beliefs: rel.beliefs,
      });
    }
  }

  const cultureContexts = cultures.map(culture => {
    const cc = ctx.world.getCultureContext(culture.id);
    if (!cc) return null;

    // Get full religion details for this culture's religions
    const cultureReligions = (cc.religions || []).map((r: any) => {
      const generated = religionDetailsMap.get(r.id);
      if (generated) {
        return {
          name: generated.name,
          summary: generated.summary,
          deity: generated.deity,
          beliefs: generated.beliefs?.slice(0, 3), // Limit to top 3 beliefs
        };
      }
      // Fall back to Azgaar data if not generated
      return { name: r.name, type: r.type };
    });

    return {
      id: culture.id,
      name: cc.name,
      type: cc.type,
      dominantBiomes: cc.dominantBiomes,
      states: cc.states?.map((s: any) => s.name),
      religions: cultureReligions,
    };
  }).filter(Boolean);

  ctx.onPlanProgress?.(`Planning ${cultureContexts.length} cultures...`);

  const systemPrompt = `You are a world-building planning assistant for a tabletop RPG campaign.
Create a generation plan for CULTURES based on the world context.

Each culture in the input includes its associated religions with their generated details (deity, beliefs, summary).
Use this religion context to inform cultural values, naming, and thematic notes.

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "description": "Brief overview of cultures to generate",
  "campaignTheme": "How campaign settings influenced naming/tone",
  "entities": [
    {
      "category": "culture",
      "sourceId": 123,
      "sourceName": "Original culture name",
      "thematicNotes": "How this culture relates to its religions and the campaign - be specific about religious influence",
      "entitiesToGenerate": [
        {
          "type": "culture",
          "name": "The [Culture Name] People",
          "role": "culture-description",
          "reason": "Why this name/approach fits given their religions and biomes"
        }
      ]
    }
  ]
}

IMPORTANT:
- Each culture needs exactly one culture entity
- The "religions" field for each culture contains generated religion details - use them!
- Consider how the specific deity, beliefs, and practices shape cultural values
- Names should be evocative and fit the campaign tone`;

  const userPrompt = JSON.stringify({ cultures: cultureContexts });

  const { data, usage } = await completeJsonWithUsage(ctx.llm, {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 3000,
    temperature: 0.7,
  });

  if (usage && ctx.onTokens) {
    ctx.onTokens(usage);
  }

  return {
    phase: "cultures",
    description: data.description || "Culture generation plan",
    campaignTheme: data.campaignTheme || "",
    entities: (data.entities || []).map((e: any) => ({
      category: "culture" as const,
      sourceId: e.sourceId,
      sourceName: e.sourceName || "",
      thematicNotes: e.thematicNotes || "",
      entitiesToGenerate: (e.entitiesToGenerate || []).map((g: any) => ({
        type: g.type as EntityType,
        name: g.name,
        role: g.role,
        reason: g.reason || "",
      })),
    })),
  };
}

/**
 * Plan state generation - uses generated religions and cultures from DB for context
 *
 * If ctx.stateFilter is provided, only includes those specific states.
 */
export async function planStateGeneration(ctx: WorldGenContext): Promise<PhasePlan> {
  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  let states = ctx.world.listStates();

  // Filter to selected states if stateFilter is provided
  if (ctx.stateFilter && ctx.stateFilter.length > 0) {
    const stateSet = new Set(ctx.stateFilter);
    states = states.filter(s => stateSet.has(s.id));
    debugLog(`[planStateGeneration] Filtered to ${states.length} states from stateFilter`);
  }

  // Build maps for generated religion and culture details
  const generatedReligionEntities = getGeneratedReligionEntities(ctx.canon);
  const religionDetailsMap = new Map<number, {
    name: string;
    summary: string;
    deity?: string;
    beliefs?: string[];
  }>();
  for (const rel of generatedReligionEntities) {
    if (rel.azgaarReligionId !== undefined) {
      religionDetailsMap.set(rel.azgaarReligionId, {
        name: rel.name,
        summary: rel.summary,
        deity: rel.deity,
        beliefs: rel.beliefs,
      });
    }
  }

  const generatedCultures = getGeneratedCultures(ctx.canon);
  const cultureDetailsMap = new Map<number, {
    name: string;
    summary: string;
    traits?: string[];
    values?: string[];
  }>();
  for (const cul of generatedCultures) {
    if (cul.cultureId !== undefined) {
      cultureDetailsMap.set(cul.cultureId, {
        name: cul.name,
        summary: cul.summary,
        traits: cul.traits,
        values: cul.values,
      });
    }
  }

  const stateContexts = states.map(state => {
    const sc = ctx.world.getStateContext(state.id);
    if (!sc) return null;

    // Get the state's dominant religion with full details
    const dominantReligion = ctx.world.getStateDominantReligion(state.id);
    let religionDetails = null;
    if (dominantReligion) {
      const generated = religionDetailsMap.get(dominantReligion.id);
      religionDetails = generated ? {
        name: generated.name,
        summary: generated.summary,
        deity: generated.deity,
        beliefs: generated.beliefs?.slice(0, 3),
      } : { name: dominantReligion.name, type: dominantReligion.type };
    }

    // Get the state's culture with full details
    let cultureDetails = null;
    if (sc.culture?.id !== undefined) {
      const generated = cultureDetailsMap.get(sc.culture.id);
      cultureDetails = generated ? {
        name: generated.name,
        summary: generated.summary,
        traits: generated.traits?.slice(0, 3),
        values: generated.values?.slice(0, 3),
      } : { name: sc.culture.name, type: sc.culture.type };
    }

    return {
      id: state.id,
      name: sc.name,
      fullName: sc.fullName,
      form: sc.form,
      formName: sc.formName,
      capital: sc.capital?.name,
      culture: cultureDetails,
      religion: religionDetails,
      population: Math.round((sc.urban || 0) + (sc.rural || 0)),
    };
  }).filter(Boolean);

  ctx.onPlanProgress?.(`Planning ${stateContexts.length} states with rulers...`);

  const systemPrompt = `You are a world-building planning assistant for a tabletop RPG campaign.
Create a generation plan for STATES based on world context.

Each state includes its dominant culture and religion with generated details (summary, traits, values, deity, beliefs).
Use this context to inform government naming, ruler titles, and thematic notes.

${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "description": "Brief overview of states to generate",
  "campaignTheme": "How campaign settings influenced naming/tone",
  "entities": [
    {
      "category": "state",
      "sourceId": 123,
      "sourceName": "Original state name",
      "thematicNotes": "How this state's culture and religion shape its government - be specific",
      "entitiesToGenerate": [
        {
          "type": "faction",
          "name": "The Crown of [State]",
          "role": "government",
          "reason": "Why this name fits given the culture and religion"
        },
        {
          "type": "npc",
          "name": "King/Queen [Name]",
          "role": "ruler",
          "reason": "Why this ruler fits the cultural and religious context"
        }
      ]
    }
  ]
}

IMPORTANT:
- Each state MUST have exactly one government faction AND one ruler NPC
- Use the state's specific culture and religion details to inform naming
- Ruler titles should match government type (King for Monarchy, President for Republic, etc.)
- Names should be evocative and fit the campaign tone`;

  const userPrompt = JSON.stringify({ states: stateContexts });

  const { data, usage } = await completeJsonWithUsage(ctx.llm, {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 3000,
    temperature: 0.7,
  });

  if (usage && ctx.onTokens) {
    ctx.onTokens(usage);
  }

  return {
    phase: "states",
    description: data.description || "State generation plan",
    campaignTheme: data.campaignTheme || "",
    entities: (data.entities || []).map((e: any) => ({
      category: "state" as const,
      sourceId: e.sourceId,
      sourceName: e.sourceName || "",
      thematicNotes: e.thematicNotes || "",
      entitiesToGenerate: (e.entitiesToGenerate || []).map((g: any) => ({
        type: g.type as EntityType,
        name: g.name,
        role: g.role,
        reason: g.reason || "",
      })),
    })),
  };
}

/**
 * Format a PhasePlan for display/approval
 */
export function formatPhasePlan(plan: PhasePlan, useColors?: boolean): string {
  const BOLD = useColors ? "\x1b[1m" : "";
  const DIM = useColors ? "\x1b[2m" : "";
  const CYAN = useColors ? "\x1b[36m" : "";
  const GREEN = useColors ? "\x1b[32m" : "";
  const YELLOW = useColors ? "\x1b[33m" : "";
  const RESET = useColors ? "\x1b[0m" : "";

  const lines: string[] = [];
  const phaseTitle = plan.phase.charAt(0).toUpperCase() + plan.phase.slice(1);

  lines.push(`${BOLD}${CYAN}${phaseTitle} Generation Plan${RESET}`);
  lines.push(`${DIM}${plan.description}${RESET}`);
  if (plan.campaignTheme) {
    lines.push(`${DIM}Theme: ${plan.campaignTheme}${RESET}`);
  }
  lines.push("");

  // Count entities
  let totalEntities = 0;
  for (const entity of plan.entities) {
    totalEntities += entity.entitiesToGenerate.length;
  }

  lines.push(`${BOLD}Summary:${RESET}`);
  lines.push(`  ${plan.entities.length} ${plan.phase} sources`);
  lines.push(`  ${totalEntities} total entities to generate`);
  lines.push("");

  // Display entities
  lines.push(`${BOLD}Planned Entities:${RESET}`);
  for (const entity of plan.entities) {
    const color = plan.phase === "religions" ? YELLOW : plan.phase === "cultures" ? CYAN : GREEN;
    lines.push(`  ${color}${entity.sourceName}${RESET}`);
    for (const e of entity.entitiesToGenerate) {
      const icon = e.type === "faction" ? (plan.phase === "religions" ? "⛪" : "🏛️") :
                   e.type === "npc" ? "👤" : "📜";
      lines.push(`    ${icon} ${e.name} ${DIM}(${e.role})${RESET}`);
    }
  }

  return lines.join("\n");
}

/**
 * Execute a phase plan - generates all entities in the plan
 */
export async function executePhasePlan(
  ctx: WorldGenContext,
  plan: PhasePlan
): Promise<WorldGenResult> {
  // Pantheon phase uses batch generation (multiple deities per religion in one LLM call)
  if (plan.phase === "pantheons") {
    return generatePantheonContent(ctx);
  }

  const campaignContext = formatSettingsForGeneration(ctx.campaignSettings);
  const result: WorldGenResult = { created: 0, errors: [] };

  // Flatten all entities to generate
  const allEntities: Array<{
    plan: WorldEntityPlan;
    subEntity: WorldEntityPlan["entitiesToGenerate"][0];
  }> = [];

  for (const entityPlan of plan.entities) {
    for (const subEntity of entityPlan.entitiesToGenerate) {
      allEntities.push({ plan: entityPlan, subEntity });
    }
  }

  if (allEntities.length === 0) {
    return result;
  }

  ctx.onProgress?.(`Generating ${allEntities.length} ${plan.phase} entities...`);

  // Generate entities in parallel
  const generatedEntities = await Promise.all(
    allEntities.map(async (item, index) => {
      const { plan: entityPlan, subEntity } = item;
      const startTime = Date.now();
      ctx.onEntityStart?.(subEntity.name, index, allEntities.length);

      const anchorBase: any = { tags: [entityPlan.sourceName, subEntity.role].filter(Boolean) };
      if (entityPlan.category === "state") anchorBase.stateId = entityPlan.sourceId;
      else if (entityPlan.category === "religion") anchorBase.azgaarReligionId = entityPlan.sourceId;
      else if (entityPlan.category === "culture") anchorBase.cultureId = entityPlan.sourceId;
      const ideaInjection = prepareIdeaInjection({
        canon: ctx.canon,
        entityType: subEntity.type,
        additionalLabels: [entityPlan.category, subEntity.role, plan.phase].filter(Boolean) as string[],
        anchor: anchorBase,
      });

      try {
        const { systemPrompt, userPrompt } = buildEntityPrompts(
          entityPlan,
          subEntity,
          ctx,
          campaignContext
        );

        const { data, usage } = await completeJsonWithUsage(ctx.llm, {
          system: systemPrompt + ideaInjection.promptAddition,
          messages: [{ role: "user", content: userPrompt }],
          maxTokens: 2000,
          temperature: 0.7,
        });

        if (usage && ctx.onTokens) {
          ctx.onTokens(usage);
        }

        return {
          entityPlan,
          subEntity,
          data,
          usage,
          elapsedMs: Date.now() - startTime,
          candidateIdeaIds: ideaInjection.candidateIds,
        };
      } catch (e: any) {
        return {
          entityPlan,
          subEntity,
          data: null,
          error: e?.message || String(e),
          elapsedMs: Date.now() - startTime,
          candidateIdeaIds: ideaInjection.candidateIds,
        };
      }
    })
  );

  // Write to DB and track IDs for relationships
  const entityIdMap: Map<string, string> = new Map();

  for (let i = 0; i < generatedEntities.length; i++) {
    const gen = generatedEntities[i];
    const { entityPlan, subEntity, data, elapsedMs, error, usage } = gen;

    if (error || !data) {
      result.errors.push(`${subEntity.name}: ${error || "No data returned"}`);
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, 0, elapsedMs);
      continue;
    }

    try {
      const anchors = buildAnchors(entityPlan, subEntity, ctx);

      const entity = ctx.canon.addEntity({
        type: subEntity.type,
        name: data.name || subEntity.name,
        summary: data.summary,
        details_md: data.details_md,
        tags: data.tags || [subEntity.role],
        anchors,
        payload: data.payload || {},
        provenance: {
          generated_by: `world-init-${plan.phase}`,
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: entityPlan.category,
          sourceId: entityPlan.sourceId,
          role: subEntity.role,
        },
      });

      const key = `${entityPlan.category}:${entityPlan.sourceId}:${subEntity.role}`;
      entityIdMap.set(key, entity.id);

      const usedIdeas = markIdeasUsedFromOutput(ctx.canon, data, entity.id, (gen as any).candidateIdeaIds || []);
      logIdeaBreadcrumb(`executePhasePlan:${plan.phase}:${subEntity.role}`, (gen as any).candidateIdeaIds || [], usedIdeas);

      result.created += 1;
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, usage?.totalTokens || 0, elapsedMs);
    } catch (e: any) {
      result.errors.push(`${subEntity.name}: ${e?.message || String(e)}`);
      ctx.onEntityComplete?.(subEntity.name, i, generatedEntities.length, 0, elapsedMs);
    }
  }

  // Create relationships within this phase
  createPhaseRelationships(ctx, plan, entityIdMap);

  return result;
}

/**
 * Build prompts for entity generation
 */
function buildEntityPrompts(
  entityPlan: WorldEntityPlan,
  subEntity: WorldEntityPlan["entitiesToGenerate"][0],
  ctx: WorldGenContext,
  campaignContext: string
): { systemPrompt: string; userPrompt: string } {
  const { category, sourceId, sourceName, thematicNotes } = entityPlan;
  const { type, name, role, reason } = subEntity;

  // Religion entity (theological content)
  if (type === "religion" && category === "religion") {
    const rc = ctx.world.getReligionContext(sourceId);
    return {
      systemPrompt: `You are a world-building assistant. Generate detailed theological content for a religion.
This is the FAITH ITSELF, not an organization - describe the beliefs, deity, practices, and sacred traditions.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line description of the faith",
  "details_md": "Markdown description of theology, cosmology, sacred texts, creation myths, afterlife beliefs",
  "tags": ["theology", "type"],
  "payload": {
    "religionType": "Folk|Organized|Cult|Heresy",
    "form": "Shamanism|Polytheism|Dualism|Monotheism|etc",
    "deity": "deity name and epithet with brief description",
    "beliefs": ["core tenets of faith"],
    "practices": ["key rituals and observances"],
    "holySites": ["sacred locations with brief descriptions"],
    "taboos": ["forbidden behaviors"],
    "symbols": ["holy symbols and icons"],
    "afterlife": "beliefs about death and what comes after"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        religion: rc ? {
          name: rc.name,
          type: rc.type,
          form: rc.form,
          deity: rc.deity,
        } : { name: sourceName },
      }),
    };
  }

  // Religious faction (organization)
  if (type === "faction" && category === "religion") {
    const rc = ctx.world.getReligionContext(sourceId);
    // Check if we've already generated the religion entity for context
    const generatedReligions = getGeneratedReligionEntities(ctx.canon);
    const matchingReligion = generatedReligions.find(r => r.azgaarReligionId === sourceId);
    return {
      systemPrompt: `You are a world-building assistant. Generate a detailed religious organization/faction.
This is the ORGANIZATION that practices the faith, not the faith itself - describe hierarchy, political influence, membership.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line description of the organization",
  "details_md": "Markdown description of organizational structure, hierarchy, political influence, temples, membership",
  "tags": ["religious-organization", "type"],
  "payload": {
    "kind": "religious-organization",
    "hierarchy": "Description of leadership structure (ranks, titles)",
    "membership": "Who can join, initiation rites, requirements",
    "influence": "Political and social influence in the world",
    "headquarters": "Primary temple, cathedral, or center of power",
    "wealth": "Economic resources and how they're obtained",
    "militancy": "none|defensive|missionary|militant"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        religion: rc ? {
          name: rc.name,
          type: rc.type,
          form: rc.form,
          deity: rc.deity,
        } : { name: sourceName },
        generatedReligionEntity: matchingReligion ? {
          name: matchingReligion.name,
          summary: matchingReligion.summary,
          deity: matchingReligion.deity,
          beliefs: matchingReligion.beliefs,
        } : undefined,
      }),
    };
  }

  // Religion leader NPC
  if (type === "npc" && category === "religion") {
    const rc = ctx.world.getReligionContext(sourceId);
    // Check if we've already generated the religion entity for context
    const generatedReligions = getGeneratedReligionEntities(ctx.canon);
    const matchingReligion = generatedReligions.find(r => r.azgaarReligionId === sourceId);
    return {
      systemPrompt: `You are a world-building assistant. Generate a detailed religious leader NPC.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line public description",
  "details_md": "Background, personality, how they lead the faith, secrets",
  "tags": ["religious-leader", "clergy"],
  "payload": {
    "role": "High Priest|Prophet|Pontiff|etc",
    "personality": "key traits",
    "appearance": "physical description",
    "motivations": ["what drives them"],
    "secrets": ["personal secrets"],
    "faithLevel": "devout|pragmatic|doubting|corrupt"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        religion: rc ? {
          name: rc.name,
          type: rc.type,
          deity: rc.deity,
        } : { name: sourceName },
        generatedReligionEntity: matchingReligion ? {
          name: matchingReligion.name,
          summary: matchingReligion.summary,
          deity: matchingReligion.deity,
        } : undefined,
      }),
    };
  }

  // Culture entity
  if (type === "culture" && category === "culture") {
    const cc = ctx.world.getCultureContext(sourceId);

    // Get generated religion entities and build a map by azgaarReligionId
    const generatedReligionEntities = getGeneratedReligionEntities(ctx.canon);
    const religionDetailsMap = new Map<number, {
      name: string;
      summary: string;
      deity?: string;
      beliefs?: string[];
    }>();
    for (const rel of generatedReligionEntities) {
      if (rel.azgaarReligionId !== undefined) {
        religionDetailsMap.set(rel.azgaarReligionId, {
          name: rel.name,
          summary: rel.summary,
          deity: rel.deity,
          beliefs: rel.beliefs,
        });
      }
    }

    // Get full religion details for this culture's religions
    const cultureReligions = (cc?.religions || []).map((r: any) => {
      const generated = religionDetailsMap.get(r.id);
      if (generated) {
        return {
          name: generated.name,
          summary: generated.summary,
          deity: generated.deity,
          beliefs: generated.beliefs?.slice(0, 3),
        };
      }
      return { name: r.name, type: r.type };
    });

    return {
      systemPrompt: `You are a world-building assistant. Generate a detailed culture description.
The culture's associated religions are provided - use their deities, beliefs, and practices to inform cultural values and traditions.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line description",
  "details_md": "Markdown description of history, values, social structure, traditions - incorporate religious influence",
  "tags": ["culture-type", "key-trait"],
  "payload": {
    "traits": ["riverine", "martial", "mercantile", etc],
    "namingStyle": "Description of naming conventions",
    "customs": "Key customs and social norms",
    "values": ["core cultural values - influenced by their religions"],
    "aesthetics": "Art, architecture, clothing style",
    "governance": "Typical political organization"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        culture: cc ? {
          name: cc.name,
          type: cc.type,
          dominantBiomes: cc.dominantBiomes,
        } : { name: sourceName },
        religions: cultureReligions,
      }),
    };
  }

  // State government faction
  if (type === "faction" && category === "state") {
    const sc = ctx.world.getStateContext(sourceId);

    // Get the state's specific religion and culture details
    const { religionDetails, cultureDetails } = getStateReligionAndCultureDetails(ctx, sourceId);

    return {
      systemPrompt: `You are a world-building assistant. Generate a detailed government faction.
The state's dominant religion and culture are provided - use them to inform governance style, state religion, and cultural influences.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line description",
  "details_md": "Markdown description of how the government operates, its relationship with religion and culture",
  "tags": ["government", "type"],
  "payload": {
    "kind": "government",
    "governmentType": "Monarchy|Republic|Theocracy|etc",
    "industries": ["major", "industries"],
    "militaryStrength": "weak|moderate|strong|dominant",
    "stateReligion": "Reference the actual religion provided",
    "culturalInfluence": "How the specific culture shapes governance"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        state: sc ? {
          name: sc.name,
          fullName: sc.fullName,
          form: sc.form,
          formName: sc.formName,
        } : { name: sourceName },
        dominantReligion: religionDetails,
        dominantCulture: cultureDetails,
      }),
    };
  }

  // State ruler NPC
  if (type === "npc" && category === "state") {
    const sc = ctx.world.getStateContext(sourceId);

    // Get the state's specific religion and culture details
    const { religionDetails, cultureDetails } = getStateReligionAndCultureDetails(ctx, sourceId);

    return {
      systemPrompt: `You are a world-building assistant. Generate a detailed ruler NPC.
The state's dominant religion and culture are provided - use them to inform the ruler's beliefs, appearance, and cultural background.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "name": "${name}",
  "summary": "One-line public description",
  "details_md": "Background, personality, religious beliefs, cultural values, secrets",
  "tags": ["ruler", "royalty|noble|elected"],
  "payload": {
    "role": "King|Queen|President|etc",
    "personality": "key traits",
    "appearance": "physical description reflecting their culture",
    "motivations": ["what drives them"],
    "secrets": ["personal secrets"],
    "religiousBeliefs": "Their relationship with the state religion",
    "culturalBackground": "Their cultural identity and how it shapes them"
  }
}`,
      userPrompt: JSON.stringify({
        plannedName: name,
        role,
        reason,
        thematicNotes,
        state: sc ? {
          name: sc.name,
          fullName: sc.fullName,
          form: sc.formName,
        } : { name: sourceName },
        dominantReligion: religionDetails,
        dominantCulture: cultureDetails,
      }),
    };
  }

  // Fallback
  return {
    systemPrompt: `You are a world-building assistant. Generate a ${type} entity.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON with name, summary, details_md, tags, and payload fields.`,
    userPrompt: JSON.stringify({
      plannedName: name,
      role,
      reason,
      thematicNotes,
      source: sourceName,
    }),
  };
}

/**
 * Build anchors for entity based on category
 */
function buildAnchors(
  entityPlan: WorldEntityPlan,
  subEntity: WorldEntityPlan["entitiesToGenerate"][0],
  ctx: WorldGenContext
): Record<string, any> {
  const anchors: Record<string, any> = {};

  if (entityPlan.category === "religion") {
    // Religion entity uses azgaarReligionId
    if (subEntity.type === "religion") {
      anchors.azgaarReligionId = entityPlan.sourceId;
    } else {
      // Factions and NPCs link to both Azgaar and canon religion
      anchors.azgaarReligionId = entityPlan.sourceId;
      // Try to find the generated religion entity to link to it
      const generatedReligions = getGeneratedReligionEntities(ctx.canon);
      const matchingReligion = generatedReligions.find(r => r.azgaarReligionId === entityPlan.sourceId);
      if (matchingReligion) {
        anchors.religionEntityId = matchingReligion.id;
      }
    }
  } else if (entityPlan.category === "culture") {
    anchors.cultureId = entityPlan.sourceId;
  } else if (entityPlan.category === "state") {
    anchors.stateId = entityPlan.sourceId;
    if (subEntity.role === "ruler") {
      const sc = ctx.world.getStateContext(entityPlan.sourceId);
      if (sc?.capital?.id) {
        anchors.burgId = sc.capital.id;
      }
    }
  }

  return anchors;
}

/**
 * Create relationships between entities in a phase
 */
function createPhaseRelationships(
  ctx: WorldGenContext,
  plan: PhasePlan,
  entityIdMap: Map<string, string>
): void {
  for (const entityPlan of plan.entities) {
    if (plan.phase === "religions") {
      // Religion entities are standalone - no automatic relationships needed
      // Factions and leaders can be added separately and linked via religionEntityId anchor
    } else if (plan.phase === "states") {
      // Link ruler to government
      const govKey = `state:${entityPlan.sourceId}:government`;
      const rulerKey = `state:${entityPlan.sourceId}:ruler`;
      const govId = entityIdMap.get(govKey);
      const rulerId = entityIdMap.get(rulerKey);

      if (govId && rulerId) {
        try {
          ctx.canon.addRelation({
            from_id: rulerId,
            to_id: govId,
            rel_type: "leads",
            strength: 1.0,
          });
        } catch (e: any) {
          debugLog(`Failed to create ruler-government relation: ${e?.message}`);
        }
      }
    }
  }
}
