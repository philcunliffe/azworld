/**
 * Entity Context Serializer for :ask command
 *
 * Builds rich text context from entities for LLM prompts.
 */

import type { AzgaarWorld } from "../world/azgaar";
import type { CanonStore, CanonEntity } from "../canon/canon";
import type { EntityRef } from "./state";
import type { CampaignSettings } from "../chat/schema";

/**
 * Serialized entity context for LLM consumption
 */
export type EntityContext = {
  kind: string;
  name: string;
  summary: string;
  details: string; // Full serialized text
  relatedEntities: Array<{ kind: string; name: string; relation: string }>;
};

/**
 * Build rich entity context from an EntityRef
 */
export function buildEntityContext(
  ref: EntityRef,
  world: AzgaarWorld,
  canon: CanonStore
): EntityContext | undefined {
  switch (ref.kind) {
    case "world":
      return buildWorldContext(world, canon);
    case "state":
      return buildStateContext(world, canon, ref.stateId);
    case "burg":
      return buildBurgContext(world, canon, ref.burgId);
    case "location":
      return buildLocationContext(canon, ref.locationId, world);
    case "npc":
      return buildNpcContext(canon, ref.npcId, world);
    case "faction":
      return buildFactionContext(canon, ref.factionId, world);
    case "culture":
      return buildCultureContext(world, canon, ref.cultureId);
    case "religion":
      return buildReligionContext(world, canon, ref.religionId);
    case "event":
      return buildEventContext(canon, ref.eventId, world);
    case "rumor":
      return buildRumorContext(canon, ref.rumorId, world);
    case "hook":
      return buildHookContext(canon, ref.hookId, world);
    default:
      return undefined;
  }
}

function buildWorldContext(world: AzgaarWorld, canon: CanonStore): EntityContext {
  const counts = world.counts();
  const canonCounts = {
    entities: canon.listEntities({ limit: 100000 }).length,
    relations: canon.listRelations({ limit: 200000 }).length,
  };

  const lines: string[] = [
    "World Overview",
    "",
    "Azgaar Map Data:",
    `  States: ${counts.states}`,
    `  Burgs: ${counts.burgs}`,
    `  Cultures: ${counts.cultures}`,
    `  Religions: ${counts.religions}`,
    `  Rivers: ${counts.rivers}`,
    "",
    "Canon Database:",
    `  Entities: ${canonCounts.entities}`,
    `  Relations: ${canonCounts.relations}`,
  ];

  return {
    kind: "world",
    name: "World Overview",
    summary: `Fantasy world with ${counts.states} states, ${counts.burgs} burgs, ${counts.cultures} cultures, and ${counts.religions} religions.`,
    details: lines.join("\n"),
    relatedEntities: [],
  };
}

function buildStateContext(
  world: AzgaarWorld,
  canon: CanonStore,
  stateId: number
): EntityContext | undefined {
  const state = world.getState(stateId);
  if (!state) return undefined;

  const stateContext = world.getStateContext(stateId);
  const burgs = world.listBurgs().filter((b) => b.state === stateId);
  const totalPop = burgs.reduce((sum, b) => sum + (b.population ?? b.pop ?? 0), 0);

  // Get culture and religion context
  const culture = typeof state.culture === "number" ? world.getCulture(state.culture) : undefined;
  const dominantReligion = world.getStateDominantReligion(stateId);

  // Query canon for generated description
  const descriptions = canon.listEntities({
    type: "meta",
    anchors: { stateId },
    limit: 10,
  }).filter(e => e.payload?.kind === "description");
  const stateDesc = descriptions[0];

  // Query canon for government faction and ruler NPC
  const factions = canon.listEntities({
    type: "faction",
    anchors: { stateId },
    limit: 10,
  });
  const government = factions.find(
    (f) => f.tags?.includes("government") || f.payload?.kind === "government"
  );

  const npcs = canon.listEntities({
    type: "npc",
    anchors: { stateId },
    limit: 50,
  });
  const ruler = npcs.find(
    (n) => n.tags?.includes("ruler") || n.payload?.role?.toLowerCase().includes("king") ||
           n.payload?.role?.toLowerCase().includes("queen") || n.payload?.role?.toLowerCase().includes("ruler")
  );

  const lines: string[] = [
    `State: ${state.name}`,
    `Government: ${state.formName || state.form || "unknown"}`,
    `Population: ${totalPop.toLocaleString()} across ${burgs.length} burgs`,
  ];

  if (culture) {
    const cultureType = culture.type && culture.type.toLowerCase() !== "generic" ? ` (${culture.type})` : "";
    lines.push(`Culture: ${culture.name}${cultureType}`);
  }
  if (dominantReligion) {
    const relType = dominantReligion.type ? ` (${dominantReligion.type})` : "";
    lines.push(`Religion: ${dominantReligion.name}${relType}`);
  }

  // Add generated description
  if (stateDesc) {
    const descPayload = stateDesc.payload || {};
    lines.push("");
    lines.push("GENERATED DESCRIPTION:");
    if (stateDesc.summary) lines.push(stateDesc.summary);
    if (descPayload.atmosphere) lines.push(`Atmosphere: ${descPayload.atmosphere}`);
    if (descPayload.politicalClimate) lines.push(`Politics: ${descPayload.politicalClimate}`);
    if (descPayload.currentAffairs) lines.push(`Current Affairs: ${descPayload.currentAffairs}`);
    if (descPayload.history) lines.push(`History: ${descPayload.history}`);
    if (descPayload.notableFeatures?.length) {
      lines.push("Notable Features:");
      for (const feature of descPayload.notableFeatures as string[]) {
        lines.push(`  - ${feature}`);
      }
    }
  }

  // Add government info
  if (government) {
    const govPayload = government.payload || {};
    lines.push("");
    lines.push("GOVERNMENT:");
    lines.push(`Name: ${government.name}`);
    if (government.summary) lines.push(`Summary: ${government.summary}`);
    if (govPayload.governmentType) lines.push(`Type: ${govPayload.governmentType}`);
    if (govPayload.militaryStrength) lines.push(`Military: ${govPayload.militaryStrength}`);
    if (govPayload.industries?.length) {
      lines.push(`Industries: ${(govPayload.industries as string[]).join(", ")}`);
    }
    if (govPayload.stateReligion) lines.push(`State Religion: ${govPayload.stateReligion}`);
  }

  // Add ruler info
  if (ruler) {
    const rulerPayload = ruler.payload || {};
    lines.push("");
    lines.push("RULER:");
    lines.push(`Name: ${ruler.name}`);
    if (rulerPayload.role) lines.push(`Title: ${rulerPayload.role}`);
    if (ruler.summary) lines.push(`Description: ${ruler.summary}`);
    if (rulerPayload.personality) lines.push(`Personality: ${rulerPayload.personality}`);
  }

  // Add military context
  if (stateContext?.military) {
    const mil = stateContext.military;
    if (mil.total > 0) {
      lines.push("");
      lines.push("MILITARY:");
      lines.push(`Total troops: ${mil.total}`);
      if (mil.infantry > 0) lines.push(`  Infantry: ${mil.infantry}`);
      if (mil.cavalry > 0) lines.push(`  Cavalry: ${mil.cavalry}`);
      if (mil.archers > 0) lines.push(`  Archers: ${mil.archers}`);
      if (mil.fleet > 0) lines.push(`  Fleet: ${mil.fleet}`);
    }
  }

  // Add diplomacy
  if (stateContext?.diplomacy?.length > 0) {
    lines.push("");
    lines.push("DIPLOMACY:");
    for (const d of stateContext.diplomacy.slice(0, 10)) {
      lines.push(`  ${d.stateName}: ${d.relation}`);
    }
  }

  // Build related entities
  const relatedEntities: EntityContext["relatedEntities"] = [];
  if (government) {
    relatedEntities.push({ kind: "faction", name: government.name, relation: "government" });
  }
  if (ruler) {
    relatedEntities.push({ kind: "npc", name: ruler.name, relation: "ruler" });
  }
  for (const faction of factions.filter(f => f.id !== government?.id).slice(0, 5)) {
    relatedEntities.push({ kind: "faction", name: faction.name, relation: "faction" });
  }
  for (const npc of npcs.filter(n => n.id !== ruler?.id).slice(0, 10)) {
    relatedEntities.push({ kind: "npc", name: npc.name, relation: "npc" });
  }

  return {
    kind: "state",
    name: state.name,
    summary: stateDesc?.summary || `${state.formName || state.form || "nation"} with ${burgs.length} burgs and a population of ${totalPop.toLocaleString()}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildBurgContext(
  world: AzgaarWorld,
  canon: CanonStore,
  burgId: number
): EntityContext | undefined {
  const burg = world.getBurg(burgId);
  if (!burg) return undefined;

  const state = typeof burg.state === "number" ? world.getState(burg.state) : undefined;

  // Query canon for generated description
  const descriptions = canon.listEntities({
    type: "meta",
    anchors: { burgId },
    limit: 10,
  }).filter(e => e.payload?.kind === "description");
  const burgDesc = descriptions[0];

  const locations = canon.listEntities({
    type: "location",
    anchors: { burgId },
    limit: 100,
  });
  const npcs = canon.listEntities({
    type: "npc",
    anchors: { burgId },
    limit: 100,
  });
  const factions = canon.listEntities({
    type: "faction",
    anchors: { burgId },
    limit: 50,
  });

  const traits: string[] = [];
  if (burg.capital) traits.push("Capital");
  if (burg.port) traits.push("Port");

  // Get culture, religion, and terrain context
  const culture = typeof burg.culture === "number" ? world.getCulture(burg.culture) : undefined;
  const cell = typeof burg.cell === "number" ? world.getCell(burg.cell) : undefined;
  const religion = cell && typeof cell.religionId === "number" ? world.getReligion(cell.religionId) : undefined;
  const terrain = cell && typeof cell.biomeId === "number" ? world.getBiomeName(cell.biomeId) : undefined;

  const lines: string[] = [
    `Burg: ${burg.name}`,
    `State: ${state?.name || "(none)"}`,
    `Population: ${(burg.population ?? burg.pop ?? 0).toLocaleString()}`,
  ];

  if (traits.length > 0) lines.push(`Traits: ${traits.join(", ")}`);
  if (culture) {
    const cultureType = culture.type && culture.type.toLowerCase() !== "generic" ? ` (${culture.type})` : "";
    lines.push(`Culture: ${culture.name}${cultureType}`);
  }
  if (religion) {
    const relType = religion.type ? ` (${religion.type})` : "";
    lines.push(`Religion: ${religion.name}${relType}`);
  }
  if (terrain && terrain !== "unknown terrain") {
    lines.push(`Terrain: ${terrain}`);
  }

  // Add geographic context
  const geoContext = world.getBurgGeographicContext(burgId);
  if (geoContext) {
    lines.push("");
    lines.push("GEOGRAPHY:");
    lines.push(geoContext);
  }

  // Add generated description
  if (burgDesc) {
    const descPayload = burgDesc.payload || {};
    lines.push("");
    lines.push("GENERATED DESCRIPTION:");
    if (burgDesc.summary) lines.push(burgDesc.summary);
    if (descPayload.atmosphere) lines.push(`Atmosphere: ${descPayload.atmosphere}`);
    if (descPayload.dailyLife) lines.push(`Daily Life: ${descPayload.dailyLife}`);
    if (descPayload.localCustoms) lines.push(`Customs: ${descPayload.localCustoms}`);
    if (descPayload.reputation) lines.push(`Reputation: ${descPayload.reputation}`);
    if (descPayload.notableLandmarks?.length) {
      lines.push("Notable Landmarks:");
      for (const landmark of descPayload.notableLandmarks as string[]) {
        lines.push(`  - ${landmark}`);
      }
    }
  }

  // Add locations summary
  if (locations.length > 0) {
    lines.push("");
    lines.push(`LOCATIONS (${locations.length}):`);
    for (const loc of locations.slice(0, 10)) {
      const kind = loc.payload?.kind || "location";
      lines.push(`  - ${loc.name} (${kind})${loc.summary ? `: ${loc.summary}` : ""}`);
    }
    if (locations.length > 10) {
      lines.push(`  ... and ${locations.length - 10} more`);
    }
  }

  // Add NPCs summary
  if (npcs.length > 0) {
    lines.push("");
    lines.push(`NPCS (${npcs.length}):`);
    for (const npc of npcs.slice(0, 10)) {
      const role = npc.payload?.role || "";
      lines.push(`  - ${npc.name}${role ? ` (${role})` : ""}${npc.summary ? `: ${npc.summary}` : ""}`);
    }
    if (npcs.length > 10) {
      lines.push(`  ... and ${npcs.length - 10} more`);
    }
  }

  // Build related entities
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const loc of locations.slice(0, 10)) {
    relatedEntities.push({ kind: "location", name: loc.name, relation: "location" });
  }
  for (const npc of npcs.slice(0, 10)) {
    relatedEntities.push({ kind: "npc", name: npc.name, relation: "npc" });
  }
  for (const faction of factions.slice(0, 5)) {
    relatedEntities.push({ kind: "faction", name: faction.name, relation: "faction" });
  }

  return {
    kind: "burg",
    name: burg.name,
    summary: burgDesc?.summary || `${traits.join(", ") || "Settlement"} in ${state?.name || "unknown region"} with population ${(burg.population ?? burg.pop ?? 0).toLocaleString()}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildLocationContext(
  canon: CanonStore,
  locationId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const location = canon.getEntity(locationId);
  if (!location) return undefined;

  // Get NPCs at this location
  const rels = canon.listRelations({ entity_id: locationId, limit: 200 });
  const npcIds = rels
    .filter((r) => r.rel_type === "located_at" && r.to_id === locationId)
    .map((r) => r.from_id);
  const npcs = npcIds
    .map((id) => canon.getEntity(id))
    .filter((e): e is CanonEntity => e !== undefined && e.type === "npc");

  // Get burg context if anchored
  const burgId = location.anchors?.burgId;
  const burg = typeof burgId === "number" ? world.getBurg(burgId) : undefined;

  const lines: string[] = [
    `Location: ${location.name}`,
    `Kind: ${(location.payload?.kind as string) || "unknown"}`,
  ];

  if (burg) lines.push(`In: ${burg.name}`);
  if (location.tags?.length) lines.push(`Tags: ${location.tags.join(", ")}`);

  if (location.summary) {
    lines.push("");
    lines.push("SUMMARY:");
    lines.push(location.summary);
  }

  const briefDesc = location.payload?.briefDescription as string | undefined;
  if (briefDesc) {
    lines.push("");
    lines.push("BRIEF DESCRIPTION:");
    lines.push(briefDesc);
  }

  const physicalDesc = location.payload?.physicalDescription as string | undefined;
  if (physicalDesc) {
    lines.push("");
    lines.push("PHYSICAL DESCRIPTION:");
    lines.push(physicalDesc);
  }

  if (location.details_md) {
    lines.push("");
    lines.push("DETAILED NOTES:");
    lines.push(location.details_md);
  }

  // Add NPCs at this location
  if (npcs.length > 0) {
    lines.push("");
    lines.push(`NPCS HERE (${npcs.length}):`);
    for (const npc of npcs) {
      const role = npc.payload?.role || "";
      lines.push(`  - ${npc.name}${role ? ` (${role})` : ""}${npc.summary ? `: ${npc.summary}` : ""}`);
    }
  }

  // Build related entities from relations
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const npc of npcs) {
    relatedEntities.push({ kind: "npc", name: npc.name, relation: "present" });
  }
  for (const rel of rels) {
    if (rel.from_id === locationId) {
      const other = canon.getEntity(rel.to_id);
      if (other) {
        relatedEntities.push({ kind: other.type, name: other.name, relation: rel.rel_type });
      }
    } else if (rel.to_id === locationId && rel.rel_type !== "located_at") {
      const other = canon.getEntity(rel.from_id);
      if (other) {
        relatedEntities.push({ kind: other.type, name: other.name, relation: `${rel.rel_type} (from)` });
      }
    }
  }

  return {
    kind: "location",
    name: location.name,
    summary: location.summary || `${location.payload?.kind || "Location"} in ${burg?.name || "unknown area"}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildNpcContext(
  canon: CanonStore,
  npcId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const npc = canon.getEntity(npcId);
  if (!npc) return undefined;

  const payload = npc.payload || {};

  // Get location and burg context
  const rels = canon.listRelations({ entity_id: npcId, limit: 200 });
  const locationRel = rels.find(r => r.rel_type === "located_at" && r.from_id === npcId);
  const location = locationRel ? canon.getEntity(locationRel.to_id) : undefined;

  const burgId = npc.anchors?.burgId;
  const burg = typeof burgId === "number" ? world.getBurg(burgId) : undefined;

  const lines: string[] = [
    `NPC: ${npc.name}`,
  ];

  if (payload.role) lines.push(`Role: ${payload.role}`);
  if (npc.tags?.length) lines.push(`Tags: ${npc.tags.join(", ")}`);
  if (location) lines.push(`Location: ${location.name}`);
  if (burg) lines.push(`Burg: ${burg.name}`);

  if (npc.summary) {
    lines.push("");
    lines.push("SUMMARY:");
    lines.push(npc.summary);
  }

  if (payload.appearance) {
    lines.push("");
    lines.push("APPEARANCE:");
    lines.push(String(payload.appearance));
  }

  if (payload.personality) {
    lines.push("");
    lines.push("PERSONALITY:");
    lines.push(String(payload.personality));
  }

  if (payload.background) {
    lines.push("");
    lines.push("BACKGROUND:");
    lines.push(String(payload.background));
  }

  // Story hooks (GM-facing)
  const hooks = payload.hooks as string[] | undefined;
  if (hooks?.length) {
    lines.push("");
    lines.push("STORY HOOKS:");
    for (const h of hooks) {
      lines.push(`  - ${h}`);
    }
  }

  // Knowledge
  const knows = payload.knows as { public?: string[]; secret?: string[]; intimate?: string[] } | undefined;
  if (knows?.public?.length) {
    lines.push("");
    lines.push("KNOWN FACTS (PUBLIC):");
    for (const f of knows.public) {
      lines.push(`  - ${f}`);
    }
  }
  if (knows?.secret?.length) {
    lines.push("");
    lines.push("SECRET KNOWLEDGE:");
    for (const f of knows.secret) {
      lines.push(`  - ${f}`);
    }
  }

  // Personal secrets
  const secrets = payload.secrets as string[] | undefined;
  if (secrets?.length) {
    lines.push("");
    lines.push("PERSONAL SECRETS:");
    for (const s of secrets) {
      lines.push(`  - ${s}`);
    }
  }

  // Motivations
  const motivations = payload.motivations as string[] | undefined;
  if (motivations?.length) {
    lines.push("");
    lines.push("MOTIVATIONS:");
    for (const m of motivations) {
      lines.push(`  - ${m}`);
    }
  }

  // Additional notes
  if (npc.details_md?.trim()) {
    lines.push("");
    lines.push("ADDITIONAL NOTES:");
    lines.push(npc.details_md);
  }

  // Build related entities from relations
  const relatedEntities: EntityContext["relatedEntities"] = [];
  if (location) {
    relatedEntities.push({ kind: "location", name: location.name, relation: "located_at" });
  }
  for (const rel of rels) {
    if (rel.rel_type === "located_at") continue;
    const otherId = rel.from_id === npcId ? rel.to_id : rel.from_id;
    const other = canon.getEntity(otherId);
    if (other) {
      const relLabel = rel.from_id === npcId ? rel.rel_type : `← ${rel.rel_type}`;
      relatedEntities.push({ kind: other.type, name: other.name, relation: relLabel });
    }
  }

  return {
    kind: "npc",
    name: npc.name,
    summary: npc.summary || `${payload.role || "NPC"} in ${burg?.name || location?.name || "unknown location"}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildFactionContext(
  canon: CanonStore,
  factionId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const faction = canon.getEntity(factionId);
  if (!faction) return undefined;

  const payload = faction.payload || {};
  const anchors = faction.anchors || {};

  // Get location context
  const state = anchors.stateId !== undefined ? world.getState(anchors.stateId) : undefined;
  const burg = anchors.burgId !== undefined ? world.getBurg(anchors.burgId) : undefined;

  const lines: string[] = [
    `Faction: ${faction.name}`,
  ];

  if (payload.kind) lines.push(`Kind: ${payload.kind}`);
  if (payload.governmentType) lines.push(`Type: ${payload.governmentType}`);
  if (faction.tags?.length) lines.push(`Tags: ${faction.tags.join(", ")}`);
  if (state) lines.push(`State: ${state.name}`);
  if (burg) lines.push(`Burg: ${burg.name}`);

  if (faction.summary) {
    lines.push("");
    lines.push("SUMMARY:");
    lines.push(faction.summary);
  }

  if (payload.militaryStrength) {
    lines.push("");
    lines.push("MILITARY:");
    lines.push(`Strength: ${payload.militaryStrength}`);
  }

  const industries = payload.industries as string[] | undefined;
  if (industries?.length) {
    lines.push("");
    lines.push("INDUSTRIES:");
    for (const i of industries) {
      lines.push(`  - ${i}`);
    }
  }

  if (payload.stateReligion) {
    lines.push("");
    lines.push("STATE RELIGION:");
    lines.push(String(payload.stateReligion));
  }

  if (payload.culturalInfluence) {
    lines.push("");
    lines.push("CULTURAL INFLUENCE:");
    lines.push(String(payload.culturalInfluence));
  }

  if (faction.details_md?.trim()) {
    lines.push("");
    lines.push("DESCRIPTION:");
    lines.push(faction.details_md);
  }

  // Build related entities from relations
  const rels = canon.listRelations({ entity_id: factionId, limit: 200 });
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const rel of rels) {
    const otherId = rel.from_id === factionId ? rel.to_id : rel.from_id;
    const other = canon.getEntity(otherId);
    if (other) {
      const relLabel = rel.from_id === factionId ? rel.rel_type : `← ${rel.rel_type}`;
      relatedEntities.push({ kind: other.type, name: other.name, relation: relLabel });
    }
  }

  return {
    kind: "faction",
    name: faction.name,
    summary: faction.summary || `${payload.kind || "Faction"} in ${state?.name || burg?.name || "unknown region"}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildCultureContext(
  world: AzgaarWorld,
  canon: CanonStore,
  cultureId: number
): EntityContext | undefined {
  const context = world.getCultureContext(cultureId);
  if (!context) return undefined;

  // Query canon DB for generated culture entity
  const cultureEntities = canon.listEntities({
    type: "culture",
    anchors: { cultureId },
    limit: 10,
  });
  const cultureEntity = cultureEntities.length > 0 ? cultureEntities[0] : undefined;

  const lines: string[] = [
    `Culture: ${cultureEntity?.name || context.name}`,
    `Type: ${context.type || "unknown"}`,
  ];

  if (context.code) lines.push(`Code: ${context.code}`);
  if (context.shield) lines.push(`Shield: ${context.shield}`);
  if (context.expansionism !== undefined) lines.push(`Expansionism: ${context.expansionism}`);

  // Add generated content if available
  if (cultureEntity) {
    const payload = cultureEntity.payload || {};

    if (cultureEntity.summary) {
      lines.push("");
      lines.push("SUMMARY:");
      lines.push(cultureEntity.summary);
    }

    const traits = payload.traits as string[] | undefined;
    if (traits?.length) {
      lines.push("");
      lines.push("CULTURAL TRAITS:");
      for (const t of traits) {
        lines.push(`  - ${t}`);
      }
    }

    const values = payload.values as string[] | undefined;
    if (values?.length) {
      lines.push("");
      lines.push("CORE VALUES:");
      for (const v of values) {
        lines.push(`  - ${v}`);
      }
    }

    if (payload.customs) {
      lines.push("");
      lines.push("CUSTOMS:");
      lines.push(String(payload.customs));
    }

    if (payload.aesthetics) {
      lines.push("");
      lines.push("AESTHETICS:");
      lines.push(String(payload.aesthetics));
    }

    if (payload.governance) {
      lines.push("");
      lines.push("GOVERNANCE:");
      lines.push(String(payload.governance));
    }

    if (payload.namingStyle) {
      lines.push("");
      lines.push("NAMING STYLE:");
      lines.push(String(payload.namingStyle));
    }

    if (payload.relations) {
      lines.push("");
      lines.push("RELATIONS WITH OUTSIDERS:");
      lines.push(String(payload.relations));
    }

    if (cultureEntity.details_md?.trim()) {
      lines.push("");
      lines.push("DESCRIPTION:");
      lines.push(cultureEntity.details_md);
    }
  }

  // Add states using this culture
  if (context.states?.length > 0) {
    lines.push("");
    lines.push(`STATES (${context.states.length}):`);
    for (const s of context.states) {
      lines.push(`  - ${s.name}`);
    }
  }

  // Add associated religions
  if (context.religions?.length > 0) {
    lines.push("");
    lines.push(`RELIGIONS (${context.religions.length}):`);
    for (const r of context.religions) {
      lines.push(`  - ${r.name}${r.type ? ` (${r.type})` : ""}`);
    }
  }

  // Add dominant biomes
  if (context.dominantBiomes?.length > 0) {
    lines.push("");
    lines.push("DOMINANT BIOMES:");
    for (const b of context.dominantBiomes) {
      lines.push(`  - ${b}`);
    }
  }

  // Build related entities
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const s of (context.states || []).slice(0, 5)) {
    relatedEntities.push({ kind: "state", name: s.name, relation: "uses culture" });
  }
  for (const r of (context.religions || []).slice(0, 5)) {
    relatedEntities.push({ kind: "religion", name: r.name, relation: "associated religion" });
  }

  return {
    kind: "culture",
    name: cultureEntity?.name || context.name,
    summary: cultureEntity?.summary || `${context.type || "Culture"} with ${context.states?.length || 0} states.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildReligionContext(
  world: AzgaarWorld,
  canon: CanonStore,
  religionId: number
): EntityContext | undefined {
  const context = world.getReligionContext(religionId);
  if (!context) return undefined;

  // Query canon DB for generated religion entity
  const religionEntities = canon.listEntities({
    type: "religion",
    limit: 100,
  }).filter(e => e.anchors?.azgaarReligionId === religionId);
  const religionEntity = religionEntities.length > 0 ? religionEntities[0] : undefined;

  // Query for religious factions
  const factions = canon.listEntities({
    type: "faction",
    limit: 100,
  }).filter(e =>
    e.anchors?.azgaarReligionId === religionId ||
    e.anchors?.religionEntityId === religionEntity?.id
  );

  // Query for religious NPCs
  const npcs = canon.listEntities({
    type: "npc",
    limit: 100,
  }).filter(e =>
    e.anchors?.azgaarReligionId === religionId ||
    e.anchors?.religionEntityId === religionEntity?.id
  );

  const lines: string[] = [
    `Religion: ${religionEntity?.name || context.name}`,
    `Type: ${context.type || "unknown"}`,
  ];

  if (context.form) lines.push(`Form: ${context.form}`);
  if (context.deity) lines.push(`Deity: ${context.deity}`);
  if (context.code) lines.push(`Code: ${context.code}`);
  if (context.expansion) lines.push(`Expansion: ${context.expansion}`);
  if (context.expansionism !== undefined) lines.push(`Expansionism: ${context.expansionism}`);

  if (context.originCulture) {
    lines.push(`Origin Culture: ${context.originCulture.name}`);
  }

  // Add generated content if available
  if (religionEntity) {
    const payload = religionEntity.payload || {};

    if (religionEntity.summary) {
      lines.push("");
      lines.push("SUMMARY:");
      lines.push(religionEntity.summary);
    }

    if (payload.deity) {
      lines.push("");
      lines.push("DEITY:");
      lines.push(String(payload.deity));
    }

    const beliefs = payload.beliefs as string[] | undefined;
    if (beliefs?.length) {
      lines.push("");
      lines.push("CORE BELIEFS:");
      for (const b of beliefs) {
        lines.push(`  - ${b}`);
      }
    }

    const practices = payload.practices as string[] | undefined;
    if (practices?.length) {
      lines.push("");
      lines.push("PRACTICES:");
      for (const p of practices) {
        lines.push(`  - ${p}`);
      }
    }

    const holySites = payload.holySites as string[] | undefined;
    if (holySites?.length) {
      lines.push("");
      lines.push("HOLY SITES:");
      for (const s of holySites) {
        lines.push(`  - ${s}`);
      }
    }

    const taboos = payload.taboos as string[] | undefined;
    if (taboos?.length) {
      lines.push("");
      lines.push("TABOOS:");
      for (const t of taboos) {
        lines.push(`  - ${t}`);
      }
    }

    if (payload.afterlife) {
      lines.push("");
      lines.push("AFTERLIFE:");
      lines.push(String(payload.afterlife));
    }

    if (religionEntity.details_md?.trim()) {
      lines.push("");
      lines.push("DESCRIPTION:");
      lines.push(religionEntity.details_md);
    }
  }

  // Add practicing factions
  if (factions.length > 0) {
    lines.push("");
    lines.push(`PRACTICING FACTIONS (${factions.length}):`);
    for (const f of factions) {
      lines.push(`  - ${f.name}${f.payload?.kind ? ` (${f.payload.kind})` : ""}`);
    }
  }

  // Add religious NPCs
  if (npcs.length > 0) {
    lines.push("");
    lines.push(`RELIGIOUS FIGURES (${npcs.length}):`);
    for (const n of npcs) {
      lines.push(`  - ${n.name}${n.payload?.role ? ` (${n.payload.role})` : ""}`);
    }
  }

  // Build related entities
  const relatedEntities: EntityContext["relatedEntities"] = [];
  if (context.originCulture) {
    relatedEntities.push({ kind: "culture", name: context.originCulture.name, relation: "origin" });
  }
  for (const f of factions.slice(0, 5)) {
    relatedEntities.push({ kind: "faction", name: f.name, relation: "practices" });
  }
  for (const n of npcs.slice(0, 5)) {
    relatedEntities.push({ kind: "npc", name: n.name, relation: "clergy" });
  }

  return {
    kind: "religion",
    name: religionEntity?.name || context.name,
    summary: religionEntity?.summary || `${context.type || "Religion"} (${context.form || "unknown form"}).`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildEventContext(
  canon: CanonStore,
  eventId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const event = canon.getEntity(eventId);
  if (!event || event.type !== "event") return undefined;

  const payload = event.payload || {};
  const anchors = event.anchors || {};

  // Get location context
  const burg = anchors.burgId !== undefined ? world.getBurg(anchors.burgId) : undefined;
  const state = anchors.stateId !== undefined ? world.getState(anchors.stateId) : undefined;

  const lines: string[] = [
    `Event: ${event.name}`,
  ];

  if (payload.scope) lines.push(`Scope: ${payload.scope}`);
  if (payload.severity) lines.push(`Severity: ${payload.severity}`);
  if (payload.daysAgo !== undefined) {
    lines.push(`When: ${payload.daysAgo === 0 ? "Today/Now" : `${payload.daysAgo} days ago`}`);
  }
  if (payload.ongoing !== undefined) {
    lines.push(`Status: ${payload.ongoing ? "Ongoing" : "Concluded"}`);
  }
  if (event.tags?.length) lines.push(`Tags: ${event.tags.join(", ")}`);
  if (burg) lines.push(`Location: ${burg.name}`);
  if (state) lines.push(`State: ${state.name}`);

  if (event.summary) {
    lines.push("");
    lines.push("SUMMARY:");
    lines.push(event.summary);
  }

  if (event.details_md) {
    lines.push("");
    lines.push("DESCRIPTION:");
    lines.push(event.details_md);
  }

  // Consequences
  const consequences = payload.consequences as Array<{ type?: string; target?: string; severity?: string; effect?: string }> | undefined;
  if (consequences?.length) {
    lines.push("");
    lines.push("CONSEQUENCES:");
    for (const c of consequences) {
      let line = `  - ${c.type || "Effect"}`;
      if (c.target) line += ` on ${c.target}`;
      if (c.severity) line += ` (${c.severity})`;
      if (c.effect) line += `: ${c.effect}`;
      lines.push(line);
    }
  }

  // Get awareness info
  const awareness = canon.getAwareness({ eventId });
  if (awareness.length > 0) {
    lines.push("");
    lines.push("AWARENESS:");
    const byLevel = { intimate: [] as string[], confirmed: [] as string[], rumor: [] as string[] };
    for (const a of awareness) {
      if (a.level !== "unknown") {
        const label = `${a.actorType}:${a.actorId}`;
        (byLevel[a.level as keyof typeof byLevel] || []).push(label);
      }
    }
    if (byLevel.intimate.length) lines.push(`  Intimate: ${byLevel.intimate.slice(0, 5).join(", ")}${byLevel.intimate.length > 5 ? ` (+${byLevel.intimate.length - 5} more)` : ""}`);
    if (byLevel.confirmed.length) lines.push(`  Confirmed: ${byLevel.confirmed.slice(0, 5).join(", ")}${byLevel.confirmed.length > 5 ? ` (+${byLevel.confirmed.length - 5} more)` : ""}`);
    if (byLevel.rumor.length) lines.push(`  Rumor: ${byLevel.rumor.slice(0, 5).join(", ")}${byLevel.rumor.length > 5 ? ` (+${byLevel.rumor.length - 5} more)` : ""}`);
  }

  // Build related entities from relations
  const rels = canon.listRelations({ entity_id: eventId, limit: 200 });
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const rel of rels) {
    const otherId = rel.from_id === eventId ? rel.to_id : rel.from_id;
    const other = canon.getEntity(otherId);
    if (other) {
      const relLabel = rel.from_id === eventId ? rel.rel_type : `← ${rel.rel_type}`;
      relatedEntities.push({ kind: other.type, name: other.name, relation: relLabel });
    }
  }

  return {
    kind: "event",
    name: event.name,
    summary: event.summary || `${payload.scope || "Local"} ${payload.severity || ""} event${payload.ongoing ? " (ongoing)" : ""}.`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildRumorContext(
  canon: CanonStore,
  rumorId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const rumor = canon.getEntity(rumorId);
  if (!rumor || rumor.type !== "rumor") return undefined;

  const payload = rumor.payload || {};
  const anchors = rumor.anchors || {};

  // Get location context
  const burg = anchors.burgId !== undefined ? world.getBurg(anchors.burgId) : undefined;

  const lines: string[] = [
    `Rumor: ${rumor.name}`,
  ];

  if (payload.truthLevel) lines.push(`Truth Level: ${payload.truthLevel}`);
  if (payload.spreadLevel) lines.push(`Spread: ${payload.spreadLevel}`);
  if (payload.sourceType) lines.push(`Source: ${payload.sourceType}`);
  if (rumor.tags?.length) lines.push(`Tags: ${rumor.tags.join(", ")}`);
  if (burg) lines.push(`Circulating in: ${burg.name}`);

  if (rumor.summary) {
    lines.push("");
    lines.push("WHAT PEOPLE SAY:");
    lines.push(rumor.summary);
  }

  if (rumor.details_md) {
    lines.push("");
    lines.push("VARIATIONS:");
    lines.push(rumor.details_md);
  }

  // GM-only truth
  if (payload.actualTruth) {
    lines.push("");
    lines.push("THE ACTUAL TRUTH (GM ONLY):");
    lines.push(String(payload.actualTruth));
  }

  // Linked entities from anchors
  if (anchors.linkedEventId) {
    const linkedEvent = canon.getEntity(anchors.linkedEventId);
    if (linkedEvent) {
      lines.push("");
      lines.push(`RELATED EVENT: ${linkedEvent.name}`);
      if (linkedEvent.summary) lines.push(`  ${linkedEvent.summary}`);
    }
  }
  if (anchors.linkedNpcId) {
    const linkedNpc = canon.getEntity(anchors.linkedNpcId);
    if (linkedNpc) {
      lines.push("");
      lines.push(`SOURCE/SUBJECT NPC: ${linkedNpc.name}`);
      if (linkedNpc.summary) lines.push(`  ${linkedNpc.summary}`);
    }
  }

  // Build related entities from relations
  const rels = canon.listRelations({ entity_id: rumorId, limit: 200 });
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const rel of rels) {
    const otherId = rel.from_id === rumorId ? rel.to_id : rel.from_id;
    const other = canon.getEntity(otherId);
    if (other) {
      const relLabel = rel.from_id === rumorId ? rel.rel_type : `← ${rel.rel_type}`;
      relatedEntities.push({ kind: other.type, name: other.name, relation: relLabel });
    }
  }

  return {
    kind: "rumor",
    name: rumor.name,
    summary: rumor.summary || `${payload.spreadLevel || "Local"} rumor (${payload.truthLevel || "unknown truth"}).`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

function buildHookContext(
  canon: CanonStore,
  hookId: string,
  world: AzgaarWorld
): EntityContext | undefined {
  const hook = canon.getEntity(hookId);
  if (!hook || hook.type !== "hook") return undefined;

  const payload = hook.payload || {};
  const anchors = hook.anchors || {};

  // Get location context
  const burg = anchors.burgId !== undefined ? world.getBurg(anchors.burgId) : undefined;

  const lines: string[] = [
    `Hook: ${hook.name}`,
  ];

  if (payload.hookType) lines.push(`Type: ${payload.hookType}`);
  if (payload.urgency) lines.push(`Urgency: ${payload.urgency}`);
  if (payload.difficulty) lines.push(`Difficulty: ${payload.difficulty}`);
  if (payload.rewardType) lines.push(`Reward: ${payload.rewardType}`);
  if (payload.rewardDetails) lines.push(`Reward Details: ${payload.rewardDetails}`);
  if (hook.tags?.length) lines.push(`Tags: ${hook.tags.join(", ")}`);
  if (burg) lines.push(`Available in: ${burg.name}`);

  if (hook.summary) {
    lines.push("");
    lines.push("THE HOOK (PLAYER-FACING):");
    lines.push(hook.summary);
  }

  if (hook.details_md) {
    lines.push("");
    lines.push("GM DETAILS:");
    lines.push(hook.details_md);
  }

  // Complications
  const complications = payload.complications as string[] | undefined;
  if (complications?.length) {
    lines.push("");
    lines.push("POTENTIAL COMPLICATIONS:");
    for (const c of complications) {
      lines.push(`  - ${c}`);
    }
  }

  // Failure consequences
  if (payload.failureConsequences) {
    lines.push("");
    lines.push("IF PLAYERS FAIL/IGNORE:");
    lines.push(String(payload.failureConsequences));
  }

  // Linked entities from anchors
  if (anchors.linkedEventId) {
    const linkedEvent = canon.getEntity(anchors.linkedEventId);
    if (linkedEvent) {
      lines.push("");
      lines.push(`RELATED EVENT: ${linkedEvent.name}`);
      if (linkedEvent.summary) lines.push(`  ${linkedEvent.summary}`);
    }
  }
  if (anchors.linkedNpcId) {
    const linkedNpc = canon.getEntity(anchors.linkedNpcId);
    if (linkedNpc) {
      lines.push("");
      lines.push(`QUEST GIVER: ${linkedNpc.name}`);
      if (linkedNpc.summary) lines.push(`  ${linkedNpc.summary}`);
    }
  }
  if (anchors.linkedFactionId) {
    const linkedFaction = canon.getEntity(anchors.linkedFactionId);
    if (linkedFaction) {
      lines.push("");
      lines.push(`FACTION INVOLVED: ${linkedFaction.name}`);
      if (linkedFaction.summary) lines.push(`  ${linkedFaction.summary}`);
    }
  }

  // Build related entities from relations
  const rels = canon.listRelations({ entity_id: hookId, limit: 200 });
  const relatedEntities: EntityContext["relatedEntities"] = [];
  for (const rel of rels) {
    const otherId = rel.from_id === hookId ? rel.to_id : rel.from_id;
    const other = canon.getEntity(otherId);
    if (other) {
      const relLabel = rel.from_id === hookId ? rel.rel_type : `← ${rel.rel_type}`;
      relatedEntities.push({ kind: other.type, name: other.name, relation: relLabel });
    }
  }

  return {
    kind: "hook",
    name: hook.name,
    summary: hook.summary || `${payload.hookType || "Adventure"} hook (${payload.difficulty || "moderate"}, ${payload.urgency || "whenever"}).`,
    details: lines.join("\n"),
    relatedEntities,
  };
}

/**
 * Build the system prompt for the :ask command
 */
export function buildAskSystemPrompt(
  entityContext: EntityContext,
  campaignSettings?: CampaignSettings
): string {
  const lines: string[] = [
    "You are a helpful tabletop RPG assistant. Answer questions about the focused entity.",
    "",
    "=== CURRENT ENTITY ===",
    entityContext.details,
  ];

  if (entityContext.relatedEntities.length > 0) {
    lines.push("");
    lines.push("=== RELATED ENTITIES ===");
    for (const rel of entityContext.relatedEntities.slice(0, 20)) {
      lines.push(`- ${rel.name} (${rel.kind}, ${rel.relation})`);
    }
  }

  if (campaignSettings) {
    const campaignLines: string[] = [];
    if (campaignSettings.worldVibe) campaignLines.push(`World Vibe: ${campaignSettings.worldVibe}`);
    if (campaignSettings.culturalTouchpoints) campaignLines.push(`Cultural Touchpoints: ${campaignSettings.culturalTouchpoints}`);
    if (campaignSettings.campaignArc) campaignLines.push(`Campaign Arc: ${campaignSettings.campaignArc}`);
    if (campaignSettings.userNotes) campaignLines.push(`Notes: ${campaignSettings.userNotes}`);
    if (campaignSettings.contentTone !== undefined) campaignLines.push(`Tone (1-5): ${campaignSettings.contentTone}`);
    if (campaignSettings.rating) campaignLines.push(`Content Rating: ${campaignSettings.rating}`);

    if (campaignLines.length > 0) {
      lines.push("");
      lines.push("=== CAMPAIGN CONTEXT ===");
      lines.push(...campaignLines);
    }
  }

  lines.push("");
  lines.push("=== INSTRUCTIONS ===");
  lines.push("- Answer based on the entity context above");
  lines.push("- If asked about something not in context, say so clearly");
  lines.push("- Provide creative, useful answers for a GM");
  lines.push("- Keep responses concise (2-4 paragraphs)");
  lines.push("- You may reveal secrets/hidden info to the GM");

  return lines.join("\n");
}
