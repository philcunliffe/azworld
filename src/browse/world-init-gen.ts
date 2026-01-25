/**
 * world-init-gen.ts - Batch generation of world content from Azgaar data
 *
 * Generates entities for states/governments, religions, and cultures
 * based on the world data from Azgaar Fantasy Map Generator.
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, EntityType } from "../canon/canon";
import { LLMClient, completeJsonWithUsage, TokenUsage } from "../llm/providers";
import { CampaignSettings } from "../chat/schema";
import { formatSettingsForGeneration } from "../chat/campaign-settings";

export type WorldGenContext = {
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  campaignSettings?: CampaignSettings;
  onProgress?: (message: string) => void;
  onEntityStart?: (name: string, index: number, total: number) => void;
  onEntityComplete?: (name: string, index: number, total: number, tokens: number, elapsedMs: number) => void;
  onTokens?: (usage: Partial<TokenUsage>) => void;
};

export type WorldGenResult = {
  created: number;
  errors: string[];
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
}`;

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
 * Generate religion factions and religious figures
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
      const systemPrompt = `You are a world-building assistant for a fantasy tabletop RPG.
Generate a religious faction and its major figures based on the provided context.
${campaignContext ? `Campaign style: ${campaignContext}\n` : ""}
Output ONLY valid JSON:
{
  "religion": {
    "name": "The [Religion Name]",
    "summary": "One-line description",
    "details_md": "Markdown description of beliefs, practices, holy sites, organization",
    "tags": ["religion", "type"],
    "payload": {
      "kind": "religion",
      "religionType": "Folk|Organized|Cult|Heresy",
      "form": "Shamanism|Polytheism|Dualism|etc",
      "deity": "deity name and epithet",
      "practices": ["key rituals/practices"],
      "holySites": ["notable holy locations"],
      "beliefs": ["core tenets"]
    }
  },
  "figures": [{
    "name": "Title Firstname",
    "summary": "One-line description",
    "role": "High Priest|Prophet|Saint|Oracle|etc",
    "tags": ["religious", "role"],
    "payload": {
      "role": "their religious role",
      "personality": "key traits",
      "motivations": ["what drives them"],
      "secrets": ["hidden aspects"]
    }
  }]
}`;

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
        maxTokens: 2500,
        temperature: 0.7,
      });

      if (usage && ctx.onTokens) {
        ctx.onTokens(usage);
      }

      // Create religion faction
      const relEntity = ctx.canon.addEntity({
        type: "faction",
        name: data.religion?.name || religion.name,
        summary: data.religion?.summary,
        details_md: data.religion?.details_md,
        tags: data.religion?.tags || ["religion"],
        anchors: { religionId: religion.id },
        payload: data.religion?.payload || { kind: "religion" },
        provenance: {
          generated_by: "world-init",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
          source: "religion",
          sourceId: religion.id,
        },
      });
      result.created += 1;

      // Create religious figures
      const figures = data.figures || [];
      for (const figure of figures) {
        const figureEntity = ctx.canon.addEntity({
          type: "npc",
          name: figure.name,
          summary: figure.summary,
          tags: figure.tags || ["religious"],
          anchors: { religionId: religion.id },
          payload: figure.payload || { role: figure.role },
          provenance: {
            generated_by: "world-init",
            provider: ctx.llm.provider,
            model: ctx.llm.model,
            source: "religion",
            sourceId: religion.id,
          },
        });

        // Link figure to religion faction
        const relType = figure.role?.toLowerCase().includes("prophet") ||
                        figure.role?.toLowerCase().includes("high priest") ||
                        figure.role?.toLowerCase().includes("leader")
          ? "leads"
          : "member_of";

        ctx.canon.addRelation({
          from_id: figureEntity.id,
          to_id: relEntity.id,
          rel_type: relType,
          strength: relType === "leads" ? 1.0 : 0.7,
        });
        result.created += 1;
      }

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
}`;

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
      ctx.canon.addEntity({
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
