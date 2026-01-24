import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity, EntityType } from "../canon/canon";
import { LLMClient, completeJson } from "../llm/providers";
import { SceneGenResult, SceneGenResultSchema, SCENE_JSON_SCHEMA } from "./schema";

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

function inferIntent(text: string): { wantsTavern: boolean; wantsUnderworld: boolean; wantsNew: boolean } {
  const t = text.toLowerCase();
  const wantsTavern = /\b(tavern|bar|inn|alehouse|taproom|pub|mead\s*hall)\b/.test(t);
  const wantsUnderworld = /\b(underworld|criminal|crime|thieves|thief|smuggler|gang|syndicate|mob|black\s*market)\b/.test(t);
  const wantsNew = /\b(new|different|another|elsewhere|somewhere\s+else)\b/.test(t);
  return { wantsTavern, wantsUnderworld, wantsNew };
}

function extractCapitalizedPhrases(text: string): string[] {
  const re = /\b([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+)*)\b/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const phrase = m[1]!.trim();
    if (phrase.length >= 2) out.push(phrase);
  }
  return [...new Set(out)];
}

export function resolveBurgFromText(world: AzgaarWorld, text: string): number | undefined {
  const candidates = extractCapitalizedPhrases(text);
  for (const c of candidates) {
    const id = world.resolveBurgId(c);
    if (id !== undefined) return id;
  }
  const all = world.listBurgs();
  const t = text.toLowerCase();
  const hits = all
    .filter((b) => typeof b?.name === "string" && t.includes(b.name.toLowerCase()))
    .map((b) => b.id as number);
  return hits[0];
}

export function pickDefaultBurg(world: AzgaarWorld): number | undefined {
  const burgs = world.listBurgs();
  if (!burgs.length) return undefined;
  burgs.sort((a, b) => Number(b.population ?? b.pop ?? 0) - Number(a.population ?? a.pop ?? 0));
  return burgs[0]?.id;
}

function ensureTag(tags: string[], t: string): string[] {
  const set = new Set(tags.map((x) => x.toLowerCase()));
  if (!set.has(t.toLowerCase())) tags.push(t);
  return tags;
}

function findExistingByName(canon: CanonStore, burgId: number, type: EntityType, name: string): CanonEntity | undefined {
  const candidates = canon.listEntities({ type, anchors: { burgId }, limit: 200 });
  const n = name.trim().toLowerCase();
  return candidates.find((e) => e.name.trim().toLowerCase() === n);
}

function listCriminalFactions(canon: CanonStore, burgId: number): CanonEntity[] {
  const local = canon.listEntities({ type: "faction", anchors: { burgId }, limit: 200 });
  return local.filter((f) => f.tags.map((t) => t.toLowerCase()).some((t) => t === "criminal" || t === "underworld"));
}

function locationConnectedToFaction(canon: CanonStore, locationId: string, factionId: string): boolean {
  const rels = canon.listRelations({ entity_id: locationId, limit: 2000 });
  return rels.some(
    (r) =>
      ((r.from_id === factionId && r.to_id === locationId) || (r.from_id === locationId && r.to_id === factionId)) &&
      ["front_for", "protected_by", "affiliated_with", "owned_by", "controls"].includes(r.rel_type)
  );
}

async function generateScene(opts: {
  llm: LLMClient;
  world: AzgaarWorld;
  canon: CanonStore;
  burgId: number;
  wantsUnderworld: boolean;
  userText: string;
  tone?: string;
  existingLocationId?: string;
}): Promise<SceneGenResult> {
  const burg = opts.world.getBurg(opts.burgId);
  if (!burg) throw new Error(`Unknown burgId ${opts.burgId}`);
  const state = typeof burg.state === "number" ? opts.world.getState(burg.state) : undefined;

  const existingEnts = opts.canon.listEntities({ anchors: { burgId: opts.burgId }, limit: 200 });
  const existingNames = existingEnts.map((e) => `${e.type}:${e.name}`).slice(0, 120);

  const existingFactions = existingEnts
    .filter((e) => e.type === "faction")
    .slice(0, 40)
    .map((f) => ({ id: f.id, name: f.name, tags: f.tags, summary: f.summary ?? null }));

  const existingLocations = existingEnts
    .filter((e) => e.type === "location")
    .slice(0, 40)
    .map((l) => ({ id: l.id, name: l.name, tags: l.tags, summary: l.summary ?? null }));

  const sys =
    `You are a tabletop GM assistant. Produce canon-friendly content for a fantasy city scene.\n` +
    `Output ONLY valid JSON matching the schema.\n` +
    `Constraints:\n` +
    `- Keep names distinct; avoid reusing existing canon names.\n` +
    `- Use vivid but concise details.\n` +
    `- Do not invent geography outside the city; keep it local.\n` +
    (opts.existingLocationId
      ? `- IMPORTANT: A tavern/location already exists and MUST be reused. Do not create any NEW location entities.\n`
      : ``);

  const user = {
    request: {
      wantsUnderworld: opts.wantsUnderworld,
      existingLocationId: opts.existingLocationId ?? null,
      userText: opts.userText,
    },
    burg: {
      id: burg.id,
      name: burg.name,
      population: burg.population ?? burg.pop,
      stateId: burg.state,
      cultureId: burg.culture,
      religionId: burg.religion,
      port: burg.port,
      capital: burg.capital,
    },
    state: state ? { id: state.id, name: state.name, form: state.formName ?? state.form, capital: state.capital } : null,
    tone: opts.tone ?? null,
    existingCanonNames: existingNames,
    existingFactions,
    existingLocations,
    instructions:
      "Use request.userText as the primary creative constraint (e.g., 'extremely large miners guild bar').\n" +
      "Generate 1 tavern/bar (or guild bar) scene with 4-7 core NPCs suitable for play; if the user text implies a very large/crowded venue, you MAY add extra patrons (up to 5 more NPCs).\n" +
      "If the user text implies an organization (e.g., a guild, cult, criminal ring), generate at most 1 faction unless an existing faction fits.\n" +
      "If wantsUnderworld is true, the faction (new or reused) MUST be criminal/underworld and must be connected to the location.\n" +
      "Entities MUST have stable keys so relations can reference them (e.g., 'npc_barkeep').\n" +
      "If existingLocationId is provided, use that exact string in relations as the location target.\n" +
      "If you reuse an existing faction/location, reference its exact id string from existingFactions/existingLocations in relations.\n" +
      "Entity tags should be short (e.g., 'tavern', 'criminal', 'guard', 'merchant').\n" +
      "Relations rel_type examples: 'located_at', 'works_at', 'member_of', 'affiliated_with', 'front_for', 'protected_by', 'owes', 'rival_of'.\n" +
      "Narration should be a short GM-facing description of the opening scene.",
  };

  const result = await completeJson(opts.llm, {
    system: sys,
    messages: [{ role: "user", content: JSON.stringify(user) }],
    jsonSchema: SCENE_JSON_SCHEMA,
    maxTokens: 1200,
    temperature: 0.7,
  });

  const parsed = SceneGenResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;

  // One repair attempt
  const repair = await completeJson(opts.llm, {
    system:
      "You fix invalid JSON so it matches the schema. Output only JSON. Do not add new creative content unless required to satisfy the schema.",
    messages: [{ role: "user", content: JSON.stringify({ schema: SCENE_JSON_SCHEMA, input: result }, null, 2) }],
    jsonSchema: SCENE_JSON_SCHEMA,
    maxTokens: 1200,
    temperature: 0.2,
  });

  return SceneGenResultSchema.parse(repair);
}

export async function ensureSceneFromUserText(opts: {
  llm: LLMClient;
  world: AzgaarWorld;
  canon: CanonStore;
  state: ChatState;
  userText: string;
}): Promise<{ reply: string; scene?: SceneContext; state: ChatState }> {
  const intent = inferIntent(opts.userText);

  // Burg resolution: update state if user mentions a city.
  const mentioned = resolveBurgFromText(opts.world, opts.userText);
  let burgId = mentioned ?? opts.state.currentBurgId ?? pickDefaultBurg(opts.world);
  if (burgId === undefined) {
    return { reply: "I couldn't find any cities (burgs) in this world export.", state: opts.state };
  }

  opts.state.currentBurgId = burgId;

  const burg = opts.world.getBurg(burgId);
  if (!burg) {
    return { reply: "I couldn't load that city from the world export.", state: opts.state };
  }

  // If user isn't requesting a tavern-ish scene, answer as a general director reply.
  if (!intent.wantsTavern && !opts.state.currentLocationId) {
    const st = typeof burg.state === "number" ? opts.world.getState(burg.state) : undefined;
    const pop = burg.population ?? burg.pop;
    return {
      reply:
        `You're currently in **${burg.name}** (burg ${burg.id})` +
        (st?.name ? `, within **${st.name}**` : "") +
        (pop ? `. Approx. population: ${pop}.` : ".") +
        `\n\nTip: say something like “My heroes are in a tavern in ${burg.name}...” to spawn a scene.`,
      state: opts.state,
    };
  }

  // Ensure canon DB is initialized
  opts.canon.initDb();

  // Reuse current location if it exists and user didn't ask for a new one.
  let location: CanonEntity | undefined;
  if (opts.state.currentLocationId && !intent.wantsNew) {
    const loc = opts.canon.getEntity(opts.state.currentLocationId);
    if (loc && loc.type === "location") location = loc;
  }

  // Find recent tavern in this burg if no current location
  if (!location || intent.wantsNew) {
    const taverns = opts.canon.listEntities({ type: "location", tag: "tavern", anchors: { burgId }, limit: 20 });
    if (taverns.length && !intent.wantsNew) {
      location = taverns[0];
      opts.state.currentLocationId = location.id;
    } else {
      location = undefined;
      opts.state.currentLocationId = undefined;
    }
  }

  // Load local underworld factions (if any)
  let criminalFactions = listCriminalFactions(opts.canon, burgId);

  // Load NPCs in current location (if any)
  const existingNpcs: CanonEntity[] = [];
  if (location) {
    const rels = opts.canon.listRelations({ entity_id: location.id, limit: 2000 });
    const npcIds = rels
      .filter((r) => r.rel_type === "located_at" && r.to_id === location!.id)
      .map((r) => r.from_id);
    for (const id of npcIds) {
      const e = opts.canon.getEntity(id);
      if (e && e.type === "npc") existingNpcs.push(e);
    }
  }

  const needsAnyTavern = !location;
  const needsMoreNpcs = location ? existingNpcs.length < 4 : true;
  const needsUnderworldFaction = intent.wantsUnderworld && criminalFactions.length === 0;

  const shouldGenerate = intent.wantsTavern && (intent.wantsNew || needsAnyTavern || needsMoreNpcs || needsUnderworldFaction);

  let narration = "";

  if (shouldGenerate) {
    const gen = await generateScene({
      llm: opts.llm,
      world: opts.world,
      canon: opts.canon,
      burgId,
      wantsUnderworld: intent.wantsUnderworld,
      userText: opts.userText,
      existingLocationId: location?.id,
    });

    const idMap = new Map<string, string>();

    // Insert entities with collision checks
    for (const e of gen.entities) {
      const type = e.type as EntityType;
      // If we already have a location, ignore any generated location entities.
      if (type === "location" && location) continue;

      const name = e.name;
      const existing = findExistingByName(opts.canon, burgId, type, name);
      if (existing) {
        idMap.set(e.key, existing.id);
        continue;
      }

      const tags = Array.isArray(e.tags) ? [...e.tags] : [];
      if (type === "location") ensureTag(tags, "location");
      if (type === "npc") ensureTag(tags, "npc");
      if (type === "faction") ensureTag(tags, "faction");
      if (type === "location") ensureTag(tags, "tavern");
      if (type === "faction" && intent.wantsUnderworld) ensureTag(tags, "criminal");

      const ent = opts.canon.addEntity({
        type,
        name,
        summary: e.summary ?? null,
        details_md: e.details_md ?? null,
        tags,
        anchors: { burgId },
        payload: e.payload ?? {},
        provenance: {
          generated_by: "azchat",
          provider: opts.llm.provider,
          model: opts.llm.model,
        },
      });
      idMap.set(e.key, ent.id);
    }

    // Add relations
    for (const r of gen.relations) {
      const from = idMap.get(r.from) ?? (opts.canon.getEntity(r.from) ? r.from : undefined);
      const to = idMap.get(r.to) ?? (opts.canon.getEntity(r.to) ? r.to : undefined);
      if (!from || !to) continue;

      const existingRels = opts.canon.listRelations({ entity_id: from, limit: 500 });
      const dupe = existingRels.find((x) => x.from_id === from && x.to_id === to && x.rel_type === r.rel_type);
      if (dupe) continue;

      opts.canon.addRelation({
        from_id: from,
        to_id: to,
        rel_type: r.rel_type,
        strength: r.strength ?? null,
        notes: r.notes ?? null,
      });
    }

    narration = gen.narration;
  }

  // If we still don't have a location, try to find a tavern now.
  if (!location) {
    const taverns = opts.canon.listEntities({ type: "location", tag: "tavern", anchors: { burgId }, limit: 20 });
    location = taverns[0];
    if (location) opts.state.currentLocationId = location.id;
  }

  // Refresh underworld factions
  criminalFactions = listCriminalFactions(opts.canon, burgId);

  // If user wanted underworld and we have both location and faction, ensure at least one connective link exists.
  if (intent.wantsUnderworld && location && criminalFactions.length) {
    const f = criminalFactions[0]!;
    if (!locationConnectedToFaction(opts.canon, location.id, f.id)) {
      opts.canon.addRelation({ from_id: f.id, to_id: location.id, rel_type: "front_for", strength: 0.7, notes: "Set by azchat" });
    }
  }

  // Load NPCs present
  const npcs: CanonEntity[] = [];
  if (location) {
    const rels = opts.canon.listRelations({ entity_id: location.id, limit: 2000 });
    const npcIds = rels
      .filter((r) => r.rel_type === "located_at" && r.to_id === location!.id)
      .map((r) => r.from_id);
    for (const id of npcIds) {
      const e = opts.canon.getEntity(id);
      if (e && e.type === "npc") npcs.push(e);
    }
  }

  const factions = intent.wantsUnderworld ? criminalFactions : [];

  const replyLines: string[] = [];
  replyLines.push(narration || `You arrive in ${burg.name}.`);
  if (location) replyLines.push(`\n**Location:** ${location.name} (${location.id})`);
  if (npcs.length) replyLines.push(`\n**NPCs here:** ${npcs.map((n) => n.name).join(", ")}`);
  if (factions.length) replyLines.push(`\n**Underworld:** ${factions.map((f) => f.name).join(", ")}`);

  opts.state.directorHistory.push({ role: "user", content: opts.userText });
  opts.state.directorHistory.push({ role: "assistant", content: replyLines.join("\n") });

  const scene: SceneContext = {
    burgId,
    burg,
    state: typeof burg.state === "number" ? opts.world.getState(burg.state) : undefined,
    location,
    npcs,
    factions,
  };
  return { reply: replyLines.join("\n"), scene, state: opts.state };
}
