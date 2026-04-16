/**
 * Detail panel renderer for azbrowse TUI
 *
 * Renders the right panel with entity details.
 */

import type { TreeNode, TuiState, EntityKind, DetailLink } from "../types";
import type { LayoutDimensions } from "../layout";
import type { EntityRef } from "../../state";
import type { AzgaarWorld } from "../../../world/azgaar";
import type { CanonStore, CanonEntity } from "../../../canon/canon";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  FG_GRAY,
  FG_WHITE,
  FG_CYAN,
  FG_GREEN,
  FG_YELLOW,
  getEntityColor,
  padRight,
  padCenter,
  truncate,
  wrapText,
} from "../renderer";
import { nodeIdToRef } from "../tree";

/**
 * Build links from relations for a canon entity
 */
function buildLinksFromRelations(
  canon: CanonStore,
  entityId: string
): DetailLink[] {
  const links: DetailLink[] = [];
  const relations = canon.listRelations({ entity_id: entityId, limit: 50 });

  for (const rel of relations) {
    // Get the other entity in the relation
    const otherId = rel.from_id === entityId ? rel.to_id : rel.from_id;
    const otherEntity = canon.getEntity(otherId);
    if (!otherEntity) continue;

    // Determine the kind for display
    let kind: EntityKind;
    switch (otherEntity.type) {
      case "npc":
        kind = "npc";
        break;
      case "location":
        kind = "location";
        break;
      case "faction":
        kind = "faction";
        break;
      case "culture":
        kind = "culture";
        break;
      case "religion":
        kind = "religion";
        break;
      case "event":
        kind = "event";
        break;
      case "rumor":
        kind = "rumor";
        break;
      case "hook":
        kind = "hook";
        break;
      case "deity":
        kind = "deity";
        break;
      default:
        kind = "location";
    }

    // Build relation label (direction matters)
    let relLabel = rel.rel_type;
    if (rel.from_id === entityId) {
      // This entity -> other (e.g., "leads", "located_at")
      relLabel = rel.rel_type;
    } else {
      // Other -> this entity (e.g., "led by" instead of "leads")
      const inverseMap: Record<string, string> = {
        leads: "led by",
        member_of: "has member",
        located_at: "contains",
        patron_of: "patronized by",
        ally: "allied with",
        rival: "rival of",
        works_at: "employs",
      };
      relLabel = inverseMap[rel.rel_type] || `← ${rel.rel_type}`;
    }

    links.push({
      id: otherId,
      name: otherEntity.name,
      kind,
      relationType: relLabel,
    });
  }

  return links;
}

/**
 * Detail section for display
 */
export type DetailSection = {
  key: string;          // Unique key for collapse state
  label?: string;
  content: string[];
  color?: string;
  collapsible?: boolean; // Whether this section can be collapsed
  defaultExpanded?: boolean; // If true, section starts expanded (default is collapsed)
  links?: DetailLink[];  // Navigable links within this section
};

/**
 * Detail content for display
 */
export type DetailContent = {
  title: string;
  kind: EntityKind;
  entityId?: string;    // Entity ID for scoping collapse state
  sections: DetailSection[];
};

/**
 * Build detail content from selected node
 */
export function buildDetailContent(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): DetailContent | undefined {
  const selectedNode = state.treeNodes.find((n) => n.id === state.selectedNodeId);
  if (!selectedNode) return undefined;

  const ref = nodeIdToRef(selectedNode.id);

  switch (ref.kind) {
    case "world":
      return buildWorldDetail(world, canon);
    case "state":
      return buildStateDetail(world, canon, ref.stateId);
    case "burg":
      return buildBurgDetail(world, canon, ref.burgId);
    case "location":
      return buildLocationDetail(canon, ref.locationId);
    case "npc":
      return buildNpcDetail(canon, ref.npcId);
    case "faction":
      return buildFactionDetail(world, canon, ref.factionId);
    case "event":
      return buildEventDetail(world, canon, ref.eventId);
    case "rumor":
      return buildRumorDetail(canon, ref.rumorId);
    case "hook":
      return buildHookDetail(canon, ref.hookId);
    case "culture":
      return buildCultureDetail(world, canon, ref.cultureId);
    case "religion":
      return buildReligionDetail(world, canon, ref.religionId);
    case "deity":
      return buildDeityDetail(world, canon, ref.deityId);
    default:
      return undefined;
  }
}

function buildWorldDetail(world: AzgaarWorld, canon: CanonStore): DetailContent {
  const counts = world.counts();
  const canonCounts = {
    entities: canon.listEntities({ limit: 100000 }).length,
    relations: canon.listRelations({ limit: 200000 }).length,
  };

  return {
    title: "World Overview",
    kind: "world",
    entityId: "world",
    sections: [
      {
        key: "world:azgaar",
        label: "Azgaar Map Data",
        content: [
          `States:    ${counts.states}`,
          `Burgs:     ${counts.burgs}`,
          `Cultures:  ${counts.cultures}`,
          `Religions: ${counts.religions}`,
          `Rivers:    ${counts.rivers}`,
        ],
        collapsible: true,
      },
      {
        key: "world:canon",
        label: "Canon Database",
        content: [
          `Entities:  ${canonCounts.entities}`,
          `Relations: ${canonCounts.relations}`,
        ],
        collapsible: true,
      },
    ],
  };
}

function buildStateDetail(world: AzgaarWorld, canon: CanonStore, stateId: number): DetailContent {
  const state = world.getState(stateId);
  if (!state) {
    return {
      title: `State ${stateId}`,
      kind: "state",
      entityId: `state:${stateId}`,
      sections: [{ key: "state:notfound", content: ["State not found"] }],
    };
  }

  const burgs = world.listBurgs().filter((b) => b.state === stateId);
  const totalPop = burgs.reduce((sum, b) => sum + (b.population ?? b.pop ?? 0), 0);

  // Get culture and religion context
  const culture = typeof state.culture === "number" ? world.getCulture(state.culture) : undefined;
  const dominantReligion = world.getStateDominantReligion(stateId);

  const contextContent: string[] = [];
  if (culture) {
    const cultureType = culture.type && culture.type.toLowerCase() !== "generic" ? ` (${culture.type})` : "";
    contextContent.push(`Culture:    ${culture.name}${cultureType}`);
  }
  if (dominantReligion) {
    const relType = dominantReligion.type ? ` (${dominantReligion.type})` : "";
    contextContent.push(`Religion:   ${dominantReligion.name}${relType}`);
  }

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
    limit: 20,
  });
  const ruler = npcs.find(
    (n) => n.tags?.includes("ruler") || n.payload?.role?.toLowerCase().includes("king") ||
           n.payload?.role?.toLowerCase().includes("queen") || n.payload?.role?.toLowerCase().includes("ruler")
  );

  const sections: DetailContent["sections"] = [];

  // Generated description section (if exists) - show first as it's the main flavor content
  if (stateDesc) {
    const descPayload = stateDesc.payload || {};
    const descContent: string[] = [];

    if (stateDesc.summary) {
      descContent.push(stateDesc.summary);
      descContent.push("");  // blank line after summary
    }
    if (descPayload.atmosphere) {
      descContent.push(`${descPayload.atmosphere}`);
    }
    if (descPayload.politicalClimate) {
      descContent.push("");
      descContent.push(`Politics: ${descPayload.politicalClimate}`);
    }
    if (descPayload.currentAffairs) {
      descContent.push("");
      descContent.push(`Current Affairs: ${descPayload.currentAffairs}`);
    }
    if (descPayload.history) {
      descContent.push("");
      descContent.push(`History: ${descPayload.history}`);
    }
    if (descPayload.notableFeatures?.length) {
      descContent.push("");
      descContent.push("Notable Features:");
      for (const feature of descPayload.notableFeatures as string[]) {
        descContent.push(`  • ${feature}`);
      }
    }

    sections.push({
      key: `state:${stateId}:description`,
      label: "Description",
      content: descContent,
      color: FG_CYAN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  sections.push({
    key: `state:${stateId}:details`,
    label: "Details",
    content: [
      `ID:         ${state.id}`,
      `Government: ${state.formName || state.form || "unknown"}`,
      `Color:      ${state.color || "none"}`,
    ],
    collapsible: true,
  });

  // Government faction section (if generated)
  if (government) {
    const govPayload = government.payload || {};
    const govContent: string[] = [
      `Name:       ${government.name}`,
    ];
    if (government.summary) {
      govContent.push(`Summary:    ${government.summary}`);
    }
    if (govPayload.governmentType) {
      govContent.push(`Type:       ${govPayload.governmentType}`);
    }
    if (govPayload.militaryStrength) {
      govContent.push(`Military:   ${govPayload.militaryStrength}`);
    }
    if (govPayload.industries?.length) {
      govContent.push(`Industries: ${(govPayload.industries as string[]).join(", ")}`);
    }
    if (govPayload.stateReligion) {
      govContent.push(`State Religion: ${govPayload.stateReligion}`);
    }

    sections.push({
      key: `state:${stateId}:government`,
      label: "Government",
      content: govContent,
      color: FG_GREEN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Ruler NPC section (if generated)
  if (ruler) {
    const rulerPayload = ruler.payload || {};
    const rulerContent: string[] = [
      `Name:        ${ruler.name}`,
    ];
    if (rulerPayload.role) {
      rulerContent.push(`Title:       ${rulerPayload.role}`);
    }
    if (ruler.summary) {
      rulerContent.push(`Description: ${ruler.summary}`);
    }
    if (rulerPayload.personality) {
      rulerContent.push(`Personality: ${rulerPayload.personality}`);
    }
    if (rulerPayload.appearance) {
      rulerContent.push(`Appearance:  ${rulerPayload.appearance}`);
    }

    sections.push({
      key: `state:${stateId}:ruler`,
      label: "Ruler",
      content: rulerContent,
      color: FG_YELLOW,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  if (contextContent.length > 0) {
    sections.push({
      key: `state:${stateId}:context`,
      label: "Context",
      content: contextContent,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  sections.push({
    key: `state:${stateId}:demographics`,
    label: "Demographics",
    content: [
      `Burgs:      ${burgs.length}`,
      `Population: ${totalPop.toLocaleString()}`,
    ],
    collapsible: true,
  });

  // Links - navigable links to entities in this state
  const stateLinks: DetailLink[] = [];
  if (government) {
    stateLinks.push({
      id: government.id,
      name: government.name,
      kind: "faction",
      relationType: "government",
    });
  }
  if (ruler) {
    stateLinks.push({
      id: ruler.id,
      name: ruler.name,
      kind: "npc",
      relationType: "ruler",
    });
  }
  // Add other factions in this state
  for (const faction of factions) {
    if (faction.id !== government?.id) {
      stateLinks.push({
        id: faction.id,
        name: faction.name,
        kind: "faction",
        relationType: "faction",
      });
    }
  }
  // Add other NPCs in this state (excluding ruler)
  for (const npc of npcs) {
    if (npc.id !== ruler?.id) {
      stateLinks.push({
        id: npc.id,
        name: npc.name,
        kind: "npc",
        relationType: "npc",
      });
    }
  }

  if (stateLinks.length > 0) {
    sections.push({
      key: `state:${stateId}:links`,
      label: `Links (${stateLinks.length})`,
      content: [],
      collapsible: true,
      links: stateLinks,
    });
  }

  return {
    title: state.name,
    kind: "state",
    entityId: `state:${stateId}`,
    sections,
  };
}

function buildBurgDetail(
  world: AzgaarWorld,
  canon: CanonStore,
  burgId: number
): DetailContent {
  const burg = world.getBurg(burgId);
  if (!burg) {
    return {
      title: `Burg ${burgId}`,
      kind: "burg",
      entityId: `burg:${burgId}`,
      sections: [{ key: "burg:notfound", content: ["Burg not found"] }],
    };
  }

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

  const contextContent: string[] = [];
  if (culture) {
    const cultureType = culture.type && culture.type.toLowerCase() !== "generic" ? ` (${culture.type})` : "";
    contextContent.push(`Culture:    ${culture.name}${cultureType}`);
  }
  if (religion) {
    const relType = religion.type ? ` (${religion.type})` : "";
    contextContent.push(`Religion:   ${religion.name}${relType}`);
  }
  if (terrain && terrain !== "unknown terrain") {
    contextContent.push(`Terrain:    ${terrain}`);
  }

  const sections: DetailContent["sections"] = [];

  // Generated description section (if exists) - show first as it's the main flavor content
  if (burgDesc) {
    const descPayload = burgDesc.payload || {};
    const descContent: string[] = [];

    if (burgDesc.summary) {
      descContent.push(burgDesc.summary);
      descContent.push("");  // blank line after summary
    }
    if (descPayload.atmosphere) {
      descContent.push(`${descPayload.atmosphere}`);
    }
    if (descPayload.dailyLife) {
      descContent.push("");
      descContent.push(`Daily Life: ${descPayload.dailyLife}`);
    }
    if (descPayload.localCustoms) {
      descContent.push("");
      descContent.push(`Customs: ${descPayload.localCustoms}`);
    }
    if (descPayload.reputation) {
      descContent.push("");
      descContent.push(`Reputation: ${descPayload.reputation}`);
    }
    if (descPayload.notableLandmarks?.length) {
      descContent.push("");
      descContent.push("Notable Landmarks:");
      for (const landmark of descPayload.notableLandmarks as string[]) {
        descContent.push(`  • ${landmark}`);
      }
    }

    sections.push({
      key: `burg:${burgId}:description`,
      label: "Description",
      content: descContent,
      color: FG_CYAN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  sections.push({
    key: `burg:${burgId}:details`,
    label: "Details",
    content: [
      `ID:         ${burg.id}`,
      `State:      ${state?.name || "(none)"}`,
      `Population: ${(burg.population ?? burg.pop ?? 0).toLocaleString()}`,
      traits.length > 0 ? `Traits:     ${traits.join(", ")}` : "",
    ].filter(Boolean),
    collapsible: true,
  });

  if (contextContent.length > 0) {
    sections.push({
      key: `burg:${burgId}:context`,
      label: "Context",
      content: contextContent,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Optionally add geographic narrative
  const geoContext = world.getBurgGeographicContext(burgId);
  if (geoContext) {
    sections.push({
      key: `burg:${burgId}:geography`,
      label: "Geography",
      content: [geoContext],
      collapsible: true,
    });
  }

  sections.push({
    key: `burg:${burgId}:canon`,
    label: "Canon Content",
    content: [
      `Locations:  ${locations.length}`,
      `NPCs:       ${npcs.length}`,
      `Factions:   ${factions.length}`,
    ],
    collapsible: true,
  });

  // Links - navigable links to entities in this burg
  const burgLinks: DetailLink[] = [];
  for (const loc of locations) {
    burgLinks.push({
      id: loc.id,
      name: loc.name,
      kind: "location",
      relationType: "location",
    });
  }
  for (const npc of npcs) {
    burgLinks.push({
      id: npc.id,
      name: npc.name,
      kind: "npc",
      relationType: "npc",
    });
  }
  for (const faction of factions) {
    burgLinks.push({
      id: faction.id,
      name: faction.name,
      kind: "faction",
      relationType: "faction",
    });
  }

  if (burgLinks.length > 0) {
    sections.push({
      key: `burg:${burgId}:links`,
      label: `Links (${burgLinks.length})`,
      content: [],
      collapsible: true,
      links: burgLinks,
    });
  }

  return {
    title: burg.name,
    kind: "burg",
    entityId: `burg:${burgId}`,
    sections,
  };
}

function buildLocationDetail(canon: CanonStore, locationId: string): DetailContent {
  const location = canon.getEntity(locationId);
  if (!location) {
    return {
      title: `Location`,
      kind: "location",
      entityId: locationId,
      sections: [{ key: "loc:notfound", content: ["Location not found"] }],
    };
  }

  // Get NPCs at this location
  const rels = canon.listRelations({ entity_id: locationId, limit: 200 });
  const npcIds = rels
    .filter((r) => r.rel_type === "located_at" && r.to_id === locationId)
    .map((r) => r.from_id);
  const npcs = npcIds
    .map((id) => canon.getEntity(id))
    .filter((e): e is CanonEntity => e !== undefined && e.type === "npc");

  const sections: DetailContent["sections"] = [
    {
      key: `loc:${locationId}:details`,
      label: "Details",
      content: [
        `ID:   ${location.id}`,
        `Kind: ${(location.payload?.kind as string) || "unknown"}`,
        location.tags?.length ? `Tags: ${location.tags.join(", ")}` : "",
      ].filter(Boolean),
      collapsible: true,
    },
  ];

  if (location.summary) {
    sections.push({
      key: `loc:${locationId}:summary`,
      label: "Summary",
      content: [location.summary],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Brief description from payload (quick reference, default expanded)
  const briefDesc = location.payload?.briefDescription as string | undefined;
  if (briefDesc) {
    sections.push({
      key: `loc:${locationId}:brief`,
      label: "Brief Description",
      content: [briefDesc],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Detailed physical description from payload (rich sensory details, collapsed by default)
  const physicalDesc = location.payload?.physicalDescription as string | undefined;
  if (physicalDesc) {
    sections.push({
      key: `loc:${locationId}:physical`,
      label: "Physical Description",
      content: [physicalDesc],
      collapsible: true,
    });
  }

  if (location.details_md) {
    sections.push({
      key: `loc:${locationId}:desc`,
      label: "Description",
      content: location.details_md.split("\n"),
      collapsible: true,
    });
  }

  if (npcs.length > 0) {
    sections.push({
      key: `loc:${locationId}:npcs`,
      label: `NPCs (${npcs.length})`,
      content: npcs.map((n) => `• ${n.name}${n.summary ? ` - ${n.summary.slice(0, 40)}...` : ""}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // Links - relations to other entities
  const locLinks = buildLinksFromRelations(canon, locationId);
  if (locLinks.length > 0) {
    sections.push({
      key: `loc:${locationId}:links`,
      label: `Links (${locLinks.length})`,
      content: [],
      collapsible: true,
      links: locLinks,
    });
  }

  return {
    title: location.name,
    kind: "location",
    entityId: locationId,
    sections,
  };
}

// Magenta color for GM-facing hooks
const FG_MAGENTA = "\x1b[35m";

function buildNpcDetail(canon: CanonStore, npcId: string): DetailContent {
  const npc = canon.getEntity(npcId);
  if (!npc) {
    return {
      title: `NPC`,
      kind: "npc",
      entityId: npcId,
      sections: [{ key: "npc:notfound", content: ["NPC not found"] }],
    };
  }

  const payload = npc.payload || {};
  const sections: DetailContent["sections"] = [];

  // 1. Details (ID, tags, role) - always visible
  const detailsContent: string[] = [
    `ID:   ${npc.id}`,
  ];
  if (payload.role) {
    detailsContent.push(`Role: ${payload.role}`);
  }
  if (npc.tags?.length) {
    detailsContent.push(`Tags: ${npc.tags.join(", ")}`);
  }
  sections.push({
    key: `npc:${npcId}:details`,
    label: "Details",
    content: detailsContent,
    collapsible: true,
  });

  // 2. Summary - one-liner
  if (npc.summary) {
    sections.push({
      key: `npc:${npcId}:summary`,
      label: "Summary",
      content: [npc.summary],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 3. Appearance - from payload.appearance (at top for quick visual reference)
  if (payload.appearance) {
    sections.push({
      key: `npc:${npcId}:appearance`,
      label: "Appearance",
      content: [String(payload.appearance)],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 4. Background - from payload.background
  if (payload.background) {
    sections.push({
      key: `npc:${npcId}:background`,
      label: "Background",
      content: [String(payload.background)],
      collapsible: true,
    });
  }

  // 5. Personality - from payload.personality
  if (payload.personality) {
    sections.push({
      key: `npc:${npcId}:personality`,
      label: "Personality",
      content: [String(payload.personality)],
      collapsible: true,
    });
  }

  // 6. Story Hooks - from payload.hooks (magenta, GM-facing)
  const hooks = payload.hooks as string[] | undefined;
  if (hooks?.length) {
    sections.push({
      key: `npc:${npcId}:hooks`,
      label: "Story Hooks",
      content: hooks.map((h: string) => `• ${h}`),
      color: FG_MAGENTA,
      collapsible: true,
    });
  }

  // 7. Known Facts (Public) - green
  const knows = payload.knows as { public?: string[]; secret?: string[]; intimate?: string[] } | undefined;
  if (knows?.public?.length) {
    sections.push({
      key: `npc:${npcId}:knows-public`,
      label: "Known Facts (Public)",
      content: knows.public.map((f: string) => `• ${f}`),
      color: FG_GREEN,
      collapsible: true,
    });
  }

  // 8. Secret Knowledge - yellow
  if (knows?.secret?.length) {
    sections.push({
      key: `npc:${npcId}:knows-secret`,
      label: "Secret Knowledge",
      content: knows.secret.map((f: string) => `• ${f}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // 9. Personal Secrets - from payload.secrets
  const secrets = payload.secrets as string[] | undefined;
  if (secrets?.length) {
    sections.push({
      key: `npc:${npcId}:secrets`,
      label: "Personal Secrets",
      content: secrets.map((s: string) => `• ${s}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // 10. Motivations - from payload.motivations
  const motivations = payload.motivations as string[] | undefined;
  if (motivations?.length) {
    sections.push({
      key: `npc:${npcId}:motivations`,
      label: "Motivations",
      content: motivations.map((m: string) => `• ${m}`),
      collapsible: true,
    });
  }

  // 11. Additional Notes - from details_md (gray, only if non-empty)
  if (npc.details_md?.trim()) {
    sections.push({
      key: `npc:${npcId}:notes`,
      label: "Additional Notes",
      content: npc.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  // 12. Links - relations to other entities
  const npcLinks = buildLinksFromRelations(canon, npcId);
  if (npcLinks.length > 0) {
    sections.push({
      key: `npc:${npcId}:links`,
      label: `Links (${npcLinks.length})`,
      content: [], // Links rendered specially
      collapsible: true,
      links: npcLinks,
    });
  }

  return {
    title: npc.name,
    kind: "npc",
    entityId: npcId,
    sections,
  };
}

function buildEventDetail(world: AzgaarWorld, canon: CanonStore, eventId: string): DetailContent {
  const event = canon.getEntity(eventId);
  if (!event || event.type !== "event") {
    return {
      title: `Event`,
      kind: "event",
      entityId: eventId,
      sections: [{ key: "event:notfound", content: ["Event not found"] }],
    };
  }

  const payload = event.payload || {};
  const sections: DetailContent["sections"] = [];

  sections.push({
    key: `event:${eventId}:details`,
    label: "Details",
    content: [
      `ID:       ${event.id}`,
      `Scope:    ${payload.scope || "unknown"}`,
      `Severity: ${payload.severity || "unknown"}`,
      `Scale:    ${payload.scale || "unknown"}`,
      `Secrecy:  ${payload.secrecy || "public"}`,
      `When:     ${payload.daysAgo ?? 0} days ago${payload.ongoing ? " (ongoing)" : ""}`,
    ],
    collapsible: true,
    defaultExpanded: true,
  });

  const anchors = event.anchors || {};
  const contextLines: string[] = [];
  if (anchors.stateId !== undefined) {
    const state = world.getState(anchors.stateId);
    if (state) contextLines.push(`State: ${state.name}`);
  }
  if (anchors.burgId !== undefined) {
    const burg = world.getBurg(anchors.burgId);
    if (burg) contextLines.push(`Burg:  ${burg.name}`);
  }
  if (contextLines.length > 0) {
    sections.push({
      key: `event:${eventId}:context`,
      label: "Context",
      content: contextLines,
      collapsible: true,
    });
  }

  if (event.summary) {
    sections.push({
      key: `event:${eventId}:summary`,
      label: "Summary",
      content: [event.summary],
      color: FG_YELLOW,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  if (event.details_md?.trim()) {
    sections.push({
      key: `event:${eventId}:description`,
      label: "Description",
      content: event.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  const audience = payload.audience as Record<string, any> | undefined;
  if (audience && Object.keys(audience).length > 0) {
    const audienceLines: string[] = [];
    if (audience.public) audienceLines.push("Publicly known");
    if (Array.isArray(audience.knownFactionIds) && audience.knownFactionIds.length) audienceLines.push(`Known factions: ${audience.knownFactionIds.join(", ")}`);
    if (Array.isArray(audience.knownNpcIds) && audience.knownNpcIds.length) audienceLines.push(`Known NPCs: ${audience.knownNpcIds.join(", ")}`);
    if (Array.isArray(audience.knownBurgIds) && audience.knownBurgIds.length) audienceLines.push(`Known burgs: ${audience.knownBurgIds.join(", ")}`);
    if (Array.isArray(audience.knownStateIds) && audience.knownStateIds.length) audienceLines.push(`Known states: ${audience.knownStateIds.join(", ")}`);
    if (Array.isArray(audience.suspectedByFactionIds) && audience.suspectedByFactionIds.length) audienceLines.push(`Suspected by factions: ${audience.suspectedByFactionIds.join(", ")}`);
    sections.push({
      key: `event:${eventId}:audience`,
      label: "Audience",
      content: audienceLines,
      collapsible: true,
    });
  }

  const links = buildLinksFromRelations(canon, eventId);
  if (links.length > 0) {
    sections.push({
      key: `event:${eventId}:links`,
      label: `Links (${links.length})`,
      content: [],
      collapsible: true,
      links,
    });
  }

  return {
    title: event.name,
    kind: "event",
    entityId: eventId,
    sections,
  };
}

function buildRumorDetail(canon: CanonStore, rumorId: string): DetailContent {
  const rumor = canon.getEntity(rumorId);
  if (!rumor || rumor.type !== "rumor") {
    return {
      title: `Rumor`,
      kind: "rumor",
      entityId: rumorId,
      sections: [{ key: "rumor:notfound", content: ["Rumor not found"] }],
    };
  }

  const payload = rumor.payload || {};
  const sections: DetailContent["sections"] = [
    {
      key: `rumor:${rumorId}:details`,
      label: "Details",
      content: [
        `ID:          ${rumor.id}`,
        `Truth Level: ${payload.truthLevel || "unknown"}`,
        `Spread:      ${payload.spreadLevel || "unknown"}`,
        `Source:      ${payload.sourceType || "unknown"}`,
        `Secrecy:     ${payload.secrecy || "unknown"}`,
        `Age:         ${payload.ageDays ?? 0} days`,
      ],
      collapsible: true,
      defaultExpanded: true,
    },
  ];

  if (rumor.summary) {
    sections.push({
      key: `rumor:${rumorId}:summary`,
      label: "Summary",
      content: [rumor.summary],
      color: FG_YELLOW,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  if (rumor.details_md?.trim()) {
    sections.push({
      key: `rumor:${rumorId}:description`,
      label: "Description",
      content: rumor.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  const links = buildLinksFromRelations(canon, rumorId);
  if (links.length > 0) {
    sections.push({
      key: `rumor:${rumorId}:links`,
      label: `Links (${links.length})`,
      content: [],
      collapsible: true,
      links,
    });
  }

  return {
    title: rumor.name,
    kind: "rumor",
    entityId: rumorId,
    sections,
  };
}

function buildHookDetail(canon: CanonStore, hookId: string): DetailContent {
  const hook = canon.getEntity(hookId);
  if (!hook || hook.type !== "hook") {
    return {
      title: `Hook`,
      kind: "hook",
      entityId: hookId,
      sections: [{ key: "hook:notfound", content: ["Hook not found"] }],
    };
  }

  const payload = hook.payload || {};
  const sections: DetailContent["sections"] = [
    {
      key: `hook:${hookId}:details`,
      label: "Details",
      content: [
        `ID:         ${hook.id}`,
        `Type:       ${payload.hookType || "unknown"}`,
        `Urgency:    ${payload.urgency || "unknown"}`,
        `Difficulty: ${payload.difficulty || "unknown"}`,
        `Reward:     ${payload.rewardType || "unknown"}`,
      ],
      collapsible: true,
      defaultExpanded: true,
    },
  ];

  if (hook.summary) {
    sections.push({
      key: `hook:${hookId}:summary`,
      label: "Summary",
      content: [hook.summary],
      color: FG_GREEN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  if (hook.details_md?.trim()) {
    sections.push({
      key: `hook:${hookId}:description`,
      label: "Description",
      content: hook.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  const links = buildLinksFromRelations(canon, hookId);
  if (links.length > 0) {
    sections.push({
      key: `hook:${hookId}:links`,
      label: `Links (${links.length})`,
      content: [],
      collapsible: true,
      links,
    });
  }

  return {
    title: hook.name,
    kind: "hook",
    entityId: hookId,
    sections,
  };
}

function buildFactionDetail(
  world: AzgaarWorld,
  canon: CanonStore,
  factionId: string
): DetailContent {
  const faction = canon.getEntity(factionId);
  if (!faction) {
    return {
      title: `Faction`,
      kind: "faction",
      entityId: factionId,
      sections: [{ key: "faction:notfound", content: ["Faction not found"] }],
    };
  }

  const payload = faction.payload || {};
  const sections: DetailContent["sections"] = [];

  // 1. Details (ID, tags, kind)
  const detailsContent: string[] = [
    `ID:   ${faction.id}`,
  ];
  if (payload.kind) {
    detailsContent.push(`Kind: ${payload.kind}`);
  }
  if (payload.governmentType) {
    detailsContent.push(`Type: ${payload.governmentType}`);
  }
  if (faction.tags?.length) {
    detailsContent.push(`Tags: ${faction.tags.join(", ")}`);
  }
  sections.push({
    key: `faction:${factionId}:details`,
    label: "Details",
    content: detailsContent,
    collapsible: true,
  });

  // 2. Summary
  if (faction.summary) {
    sections.push({
      key: `faction:${factionId}:summary`,
      label: "Summary",
      content: [faction.summary],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 3. Location context (state/burg)
  const anchors = faction.anchors || {};
  const contextContent: string[] = [];
  if (anchors.stateId !== undefined) {
    const state = world.getState(anchors.stateId);
    if (state) {
      contextContent.push(`State: ${state.name}`);
    }
  }
  if (anchors.burgId !== undefined) {
    const burg = world.getBurg(anchors.burgId);
    if (burg) {
      contextContent.push(`Burg:  ${burg.name}`);
    }
  }
  if (contextContent.length > 0) {
    sections.push({
      key: `faction:${factionId}:context`,
      label: "Location",
      content: contextContent,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 4. Military strength
  if (payload.militaryStrength) {
    sections.push({
      key: `faction:${factionId}:military`,
      label: "Military",
      content: [`Strength: ${payload.militaryStrength}`],
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // 5. Industries
  const industries = payload.industries as string[] | undefined;
  if (industries?.length) {
    sections.push({
      key: `faction:${factionId}:industries`,
      label: "Industries",
      content: industries.map((i: string) => `• ${i}`),
      color: FG_GREEN,
      collapsible: true,
    });
  }

  const goals = payload.goals as string[] | undefined;
  if (goals?.length) {
    sections.push({
      key: `faction:${factionId}:goals`,
      label: "Goals",
      content: goals.map((goal: string) => `• ${goal}`),
      collapsible: true,
      defaultExpanded: true,
    });
  }

  const goalProgress = payload.goalProgress as Array<Record<string, any>> | undefined;
  if (goalProgress?.length) {
    const lines = goalProgress.map((progress) => {
      const parts = [
        progress.goal || progress.id || "Unnamed goal",
        progress.status ? `[${progress.status}]` : null,
        progress.progress !== undefined ? `${progress.progress}%` : null,
        progress.stage ? `stage: ${progress.stage}` : null,
        progress.nextMilestone ? `next: ${progress.nextMilestone}` : null,
        progress.secrecy ? `secrecy: ${progress.secrecy}` : null,
      ].filter(Boolean);
      return `• ${parts.join(" | ")}`;
    });
    sections.push({
      key: `faction:${factionId}:goal-progress`,
      label: "Goal Progress",
      content: lines,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 6. State Religion (for governments)
  if (payload.stateReligion) {
    sections.push({
      key: `faction:${factionId}:state-religion`,
      label: "State Religion",
      content: [String(payload.stateReligion)],
      collapsible: true,
    });
  }

  // 6b. Practiced Religion (for religious factions)
  // Check if this faction practices a religion (via relation or anchor)
  const religionEntityId = anchors.religionEntityId;
  const azgaarReligionId = anchors.azgaarReligionId;
  if (religionEntityId || azgaarReligionId) {
    let religionName: string | undefined;
    let religionSummary: string | undefined;
    let religionId: string | undefined;

    // Try to get from canon entity
    if (religionEntityId) {
      const religionEntity = canon.getEntity(religionEntityId);
      if (religionEntity) {
        religionName = religionEntity.name;
        religionSummary = religionEntity.summary || undefined;
        religionId = religionEntity.id;
      }
    }

    // Fall back to Azgaar data
    if (!religionName && azgaarReligionId !== undefined) {
      const azgaarReligion = world.getReligion(azgaarReligionId);
      if (azgaarReligion) {
        religionName = azgaarReligion.name;
      }
    }

    if (religionName) {
      const religionContent: string[] = [`Faith: ${religionName}`];
      if (religionSummary) {
        religionContent.push(`${religionSummary}`);
      }
      sections.push({
        key: `faction:${factionId}:practiced-religion`,
        label: "Practiced Religion",
        content: religionContent,
        color: FG_YELLOW,
        collapsible: true,
        defaultExpanded: true,
        // Add link to religion entity if available
        links: religionId ? [{
          id: religionId,
          name: religionName,
          kind: "religion" as EntityKind,
          relationType: "practices",
        }] : undefined,
      });
    }
  }

  // 7. Cultural Influence
  if (payload.culturalInfluence) {
    sections.push({
      key: `faction:${factionId}:culture`,
      label: "Cultural Influence",
      content: [String(payload.culturalInfluence)],
      collapsible: true,
    });
  }

  // 8. Full Description (details_md)
  if (faction.details_md?.trim()) {
    sections.push({
      key: `faction:${factionId}:description`,
      label: "Description",
      content: faction.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  // 9. Links - relations to other entities
  const factionLinks = buildLinksFromRelations(canon, factionId);
  if (factionLinks.length > 0) {
    sections.push({
      key: `faction:${factionId}:links`,
      label: `Links (${factionLinks.length})`,
      content: [],
      collapsible: true,
      links: factionLinks,
    });
  }

  return {
    title: faction.name,
    kind: "faction",
    entityId: factionId,
    sections,
  };
}

function buildCultureDetail(world: AzgaarWorld, canon: CanonStore, cultureId: number): DetailContent {
  const context = world.getCultureContext(cultureId);
  if (!context) {
    return {
      title: `Culture ${cultureId}`,
      kind: "culture",
      entityId: `culture:${cultureId}`,
      sections: [{ key: "culture:notfound", content: ["Culture not found"] }],
    };
  }

  // Query canon DB for generated culture entity
  const cultureEntities = canon.listEntities({
    type: "culture",
    anchors: { cultureId },
    limit: 10,
  });
  const cultureEntity = cultureEntities.length > 0 ? cultureEntities[0] : undefined;

  const sections: DetailContent["sections"] = [];

  // If we have generated content, show it prominently
  if (cultureEntity) {
    const payload = cultureEntity.payload || {};

    // Summary section (always shown first and expanded)
    if (cultureEntity.summary) {
      sections.push({
        key: `culture:${cultureId}:summary`,
        label: "Summary",
        content: [cultureEntity.summary],
        color: FG_GREEN,
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Cultural Traits section
    const traits = payload.traits as string[] | undefined;
    if (traits?.length) {
      sections.push({
        key: `culture:${cultureId}:traits`,
        label: "Cultural Traits",
        content: traits.map((t: string) => `• ${t}`),
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Values section
    const values = payload.values as string[] | undefined;
    if (values?.length) {
      sections.push({
        key: `culture:${cultureId}:values`,
        label: "Core Values",
        content: values.map((v: string) => `• ${v}`),
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Customs section
    if (payload.customs) {
      sections.push({
        key: `culture:${cultureId}:customs`,
        label: "Customs",
        content: [String(payload.customs)],
        collapsible: true,
      });
    }

    // Aesthetics section
    if (payload.aesthetics) {
      sections.push({
        key: `culture:${cultureId}:aesthetics`,
        label: "Aesthetics",
        content: [String(payload.aesthetics)],
        collapsible: true,
      });
    }

    // Governance section
    if (payload.governance) {
      sections.push({
        key: `culture:${cultureId}:governance`,
        label: "Governance",
        content: [String(payload.governance)],
        collapsible: true,
      });
    }

    // Naming Style section
    if (payload.namingStyle) {
      sections.push({
        key: `culture:${cultureId}:naming`,
        label: "Naming Style",
        content: [String(payload.namingStyle)],
        color: FG_YELLOW,
        collapsible: true,
      });
    }

    // Relations with outsiders
    if (payload.relations) {
      sections.push({
        key: `culture:${cultureId}:relations`,
        label: "Relations with Outsiders",
        content: [String(payload.relations)],
        collapsible: true,
      });
    }

    // Full description
    if (cultureEntity.details_md?.trim()) {
      sections.push({
        key: `culture:${cultureId}:description`,
        label: "Description",
        content: cultureEntity.details_md.split("\n"),
        color: FG_GRAY,
        collapsible: true,
      });
    }
  }

  // Azgaar skeleton data section
  sections.push({
    key: `culture:${cultureId}:details`,
    label: "Azgaar Data",
    content: [
      `ID:           ${context.id}`,
      `Type:         ${context.type || "unknown"}`,
      context.code ? `Code:         ${context.code}` : "",
      context.shield ? `Shield:       ${context.shield}` : "",
      context.expansionism !== undefined ? `Expansionism: ${context.expansionism}` : "",
    ].filter(Boolean),
    collapsible: true,
    defaultExpanded: !cultureEntity, // Only expand if no generated content
  });

  // States using this culture
  if (context.states?.length > 0) {
    sections.push({
      key: `culture:${cultureId}:states`,
      label: `States (${context.states.length})`,
      content: context.states.map((s: { id: number; name: string }) => `• ${s.name}`),
      color: FG_CYAN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Associated religions
  if (context.religions?.length > 0) {
    sections.push({
      key: `culture:${cultureId}:religions`,
      label: `Religions (${context.religions.length})`,
      content: context.religions.map((r: { id: number; name: string; type: string }) =>
        `• ${r.name}${r.type ? ` (${r.type})` : ""}`
      ),
      color: FG_GREEN,
      collapsible: true,
    });
  }

  // Dominant biomes
  if (context.dominantBiomes?.length > 0) {
    sections.push({
      key: `culture:${cultureId}:biomes`,
      label: "Dominant Biomes",
      content: context.dominantBiomes.map((b: string) => `• ${b}`),
      collapsible: true,
    });
  }

  return {
    title: cultureEntity?.name || context.name,
    kind: "culture",
    entityId: `culture:${cultureId}`,
    sections,
  };
}

function buildReligionDetail(world: AzgaarWorld, canon: CanonStore, religionId: number): DetailContent {
  const context = world.getReligionContext(religionId);
  if (!context) {
    return {
      title: `Religion ${religionId}`,
      kind: "religion",
      entityId: `religion:${religionId}`,
      sections: [{ key: "religion:notfound", content: ["Religion not found"] }],
    };
  }

  // Query canon DB for generated religion entity
  const religionEntities = canon.listEntities({
    type: "religion",
    limit: 100,
  }).filter(e => e.anchors?.azgaarReligionId === religionId);
  const religionEntity = religionEntities.length > 0 ? religionEntities[0] : undefined;

  // Query canon DB for religious factions practicing this religion
  const factions = canon.listEntities({
    type: "faction",
    limit: 100,
  }).filter(e =>
    e.anchors?.azgaarReligionId === religionId ||
    e.anchors?.religionEntityId === religionEntity?.id ||
    (e.tags?.includes("religion") && e.anchors?.religionId === religionId)
  );

  // Query for religious NPCs
  const npcs = canon.listEntities({
    type: "npc",
    limit: 100,
  }).filter(e =>
    e.anchors?.azgaarReligionId === religionId ||
    e.anchors?.religionEntityId === religionEntity?.id ||
    e.anchors?.religionId === religionId
  );

  const sections: DetailContent["sections"] = [];

  // If we have generated content, show it prominently
  if (religionEntity) {
    const payload = religionEntity.payload || {};

    // Summary section (always shown first and expanded)
    if (religionEntity.summary) {
      sections.push({
        key: `religion:${religionId}:summary`,
        label: "Summary",
        content: [religionEntity.summary],
        color: FG_GREEN,
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Deity section
    if (payload.deity) {
      sections.push({
        key: `religion:${religionId}:deity`,
        label: "Deity",
        content: [String(payload.deity)],
        color: FG_YELLOW,
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Core Beliefs section
    const beliefs = payload.beliefs as string[] | undefined;
    if (beliefs?.length) {
      sections.push({
        key: `religion:${religionId}:beliefs`,
        label: "Core Beliefs",
        content: beliefs.map((b: string) => `• ${b}`),
        collapsible: true,
        defaultExpanded: true,
      });
    }

    // Practices section
    const practices = payload.practices as string[] | undefined;
    if (practices?.length) {
      sections.push({
        key: `religion:${religionId}:practices`,
        label: "Practices",
        content: practices.map((p: string) => `• ${p}`),
        collapsible: true,
      });
    }

    // Holy Sites section
    const holySites = payload.holySites as string[] | undefined;
    if (holySites?.length) {
      sections.push({
        key: `religion:${religionId}:holysites`,
        label: "Holy Sites",
        content: holySites.map((s: string) => `• ${s}`),
        collapsible: true,
      });
    }

    // Taboos section
    const taboos = payload.taboos as string[] | undefined;
    if (taboos?.length) {
      sections.push({
        key: `religion:${religionId}:taboos`,
        label: "Taboos",
        content: taboos.map((t: string) => `• ${t}`),
        color: FG_YELLOW,
        collapsible: true,
      });
    }

    // Afterlife beliefs
    if (payload.afterlife) {
      sections.push({
        key: `religion:${religionId}:afterlife`,
        label: "Afterlife",
        content: [String(payload.afterlife)],
        collapsible: true,
      });
    }

    // Full description
    if (religionEntity.details_md?.trim()) {
      sections.push({
        key: `religion:${religionId}:description`,
        label: "Description",
        content: religionEntity.details_md.split("\n"),
        color: FG_GRAY,
        collapsible: true,
      });
    }
  }

  // Azgaar skeleton data section
  sections.push({
    key: `religion:${religionId}:details`,
    label: "Azgaar Data",
    content: [
      `ID:           ${context.id}`,
      `Type:         ${context.type || "unknown"}`,
      context.form ? `Form:         ${context.form}` : "",
      context.deity ? `Deity:        ${context.deity}` : "",
      context.code ? `Code:         ${context.code}` : "",
      context.expansion ? `Expansion:    ${context.expansion}` : "",
      context.expansionism !== undefined ? `Expansionism: ${context.expansionism}` : "",
    ].filter(Boolean),
    collapsible: true,
    defaultExpanded: !religionEntity, // Only expand if no generated content
  });

  // Origin culture
  if (context.originCulture) {
    sections.push({
      key: `religion:${religionId}:origin`,
      label: "Origin Culture",
      content: [`${context.originCulture.name}`],
      color: FG_YELLOW,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Origins (if applicable - for heresies, etc.)
  if (context.origins !== undefined && context.origins !== null) {
    sections.push({
      key: `religion:${religionId}:origins`,
      label: "Origins",
      content: [`Origin religion: ${context.origins}`],
      collapsible: true,
    });
  }

  // Practicing Factions section (navigable links)
  if (factions.length > 0) {
    const factionLinks: DetailLink[] = factions.map(f => ({
      id: f.id,
      name: f.name,
      kind: "faction" as EntityKind,
      relationType: f.payload?.kind || "religious-organization",
    }));
    sections.push({
      key: `religion:${religionId}:factions`,
      label: `Practicing Factions (${factions.length})`,
      content: [],
      collapsible: true,
      links: factionLinks,
    });
  }

  // Religious NPCs section (navigable links)
  if (npcs.length > 0) {
    const npcLinks: DetailLink[] = npcs.map(n => ({
      id: n.id,
      name: n.name,
      kind: "npc" as EntityKind,
      relationType: n.payload?.role || "clergy",
    }));
    sections.push({
      key: `religion:${religionId}:npcs`,
      label: `Religious Figures (${npcs.length})`,
      content: [],
      collapsible: true,
      links: npcLinks,
    });
  }

  // Pantheon section - deities belonging to this religion
  const deities = canon.listEntities({ type: "deity", limit: 100 })
    .filter(e => e.anchors?.azgaarReligionId === religionId ||
      (religionEntity && e.anchors?.religionEntityId === religionEntity.id));
  if (deities.length > 0) {
    // Sort by rank
    const rankOrder: Record<string, number> = { supreme: 0, greater: 1, lesser: 2, demigod: 3, spirit: 4 };
    deities.sort((a, b) => {
      const ra = rankOrder[a.payload?.rank as string] ?? 5;
      const rb = rankOrder[b.payload?.rank as string] ?? 5;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    const deityLinks: DetailLink[] = deities.map(d => ({
      id: d.id,
      name: d.name,
      kind: "deity" as EntityKind,
      relationType: d.payload?.rank || "deity",
    }));
    const deityContent = deities.map(d => {
      const domains = (d.payload?.domains as string[] | undefined)?.join(", ");
      return `${d.payload?.rank || "deity"} — ${domains || "unknown domains"}`;
    });
    sections.push({
      key: `religion:${religionId}:pantheon`,
      label: `Pantheon (${deities.length})`,
      content: deityContent,
      color: FG_CYAN,
      collapsible: true,
      defaultExpanded: true,
      links: deityLinks,
    });
  }

  return {
    title: religionEntity?.name || context.name,
    kind: "religion",
    entityId: `religion:${religionId}`,
    sections,
  };
}

function buildDeityDetail(world: AzgaarWorld, canon: CanonStore, deityId: string): DetailContent {
  const deity = canon.getEntity(deityId);
  if (!deity || deity.type !== "deity") {
    return {
      title: `Deity ${deityId}`,
      kind: "deity",
      entityId: deityId,
      sections: [{ key: "deity:notfound", content: ["Deity not found"] }],
    };
  }

  const payload = deity.payload || {};
  const anchors = deity.anchors || {};
  const sections: DetailContent["sections"] = [];

  // Summary
  if (deity.summary) {
    sections.push({
      key: `deity:${deityId}:summary`,
      label: "Summary",
      content: [deity.summary],
      color: FG_GREEN,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Core info
  const coreLines: string[] = [];
  if (payload.rank) coreLines.push(`Rank:      ${payload.rank}`);
  if (payload.alignment) coreLines.push(`Alignment: ${payload.alignment}`);
  const domains = payload.domains as string[] | undefined;
  if (domains?.length) coreLines.push(`Domains:   ${domains.join(", ")}`);
  if (payload.sacredAnimal) coreLines.push(`Sacred Animal:   ${payload.sacredAnimal}`);
  if (payload.sacredElement) coreLines.push(`Sacred Element:  ${payload.sacredElement}`);
  if (coreLines.length > 0) {
    sections.push({
      key: `deity:${deityId}:core`,
      label: "Divine Attributes",
      content: coreLines,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Titles
  const titles = payload.titles as string[] | undefined;
  if (titles?.length) {
    sections.push({
      key: `deity:${deityId}:titles`,
      label: "Titles & Epithets",
      content: titles.map((t: string) => `• ${t}`),
      color: FG_YELLOW,
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Symbols
  const symbols = payload.symbols as string[] | undefined;
  if (symbols?.length) {
    sections.push({
      key: `deity:${deityId}:symbols`,
      label: "Sacred Symbols",
      content: symbols.map((s: string) => `• ${s}`),
      collapsible: true,
    });
  }

  // Appearance
  if (payload.appearance) {
    sections.push({
      key: `deity:${deityId}:appearance`,
      label: "Appearance",
      content: [String(payload.appearance)],
      collapsible: true,
    });
  }

  // Mythology
  if (payload.mythology) {
    sections.push({
      key: `deity:${deityId}:mythology`,
      label: "Mythology",
      content: String(payload.mythology).split("\n"),
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Worship Style
  if (payload.worshipStyle) {
    sections.push({
      key: `deity:${deityId}:worship`,
      label: "Worship",
      content: [String(payload.worshipStyle)],
      collapsible: true,
    });
  }

  // Festivals
  const festivals = payload.festivals as string[] | undefined;
  if (festivals?.length) {
    sections.push({
      key: `deity:${deityId}:festivals`,
      label: "Festivals",
      content: festivals.map((f: string) => `• ${f}`),
      collapsible: true,
    });
  }

  // Full description
  if (deity.details_md?.trim()) {
    sections.push({
      key: `deity:${deityId}:description`,
      label: "Description",
      content: deity.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  // Parent religion link
  const religionLinks: DetailLink[] = [];
  if (anchors.azgaarReligionId !== undefined) {
    const rel = world.getReligion(anchors.azgaarReligionId);
    if (rel) {
      religionLinks.push({
        id: String(anchors.azgaarReligionId),
        name: rel.name,
        kind: "religion" as EntityKind,
        relationType: "religion",
      });
    }
  }
  if (religionLinks.length > 0) {
    sections.push({
      key: `deity:${deityId}:religion`,
      label: "Religion",
      content: [],
      collapsible: true,
      defaultExpanded: true,
      links: religionLinks,
    });
  }

  // Relations to other entities
  const allRels = canon.listRelations({ entity_id: deityId });
  if (allRels.length > 0) {
    const relLinks: DetailLink[] = [];
    for (const r of allRels) {
      const otherId = r.from_id === deityId ? r.to_id : r.from_id;
      const other = canon.getEntity(otherId);
      if (other) {
        relLinks.push({
          id: other.id,
          name: other.name,
          kind: other.type as EntityKind,
          relationType: r.rel_type,
        });
      }
    }
    if (relLinks.length > 0) {
      sections.push({
        key: `deity:${deityId}:relations`,
        label: `Connections (${relLinks.length})`,
        content: [],
        collapsible: true,
        links: relLinks,
      });
    }
  }

  // Sibling deities in same pantheon
  const siblings = canon.listEntities({ type: "deity", limit: 100 })
    .filter(e => e.id !== deityId && (
      (anchors.azgaarReligionId !== undefined && e.anchors?.azgaarReligionId === anchors.azgaarReligionId) ||
      (anchors.religionEntityId && e.anchors?.religionEntityId === anchors.religionEntityId)
    ));
  if (siblings.length > 0) {
    const siblingLinks: DetailLink[] = siblings.map(s => ({
      id: s.id,
      name: s.name,
      kind: "deity" as EntityKind,
      relationType: s.payload?.rank || "deity",
    }));
    sections.push({
      key: `deity:${deityId}:siblings`,
      label: `Pantheon Siblings (${siblings.length})`,
      content: [],
      collapsible: true,
      links: siblingLinks,
    });
  }

  // Tags
  if (deity.tags?.length) {
    sections.push({
      key: `deity:${deityId}:tags`,
      label: "Tags",
      content: [deity.tags.join(", ")],
      color: FG_GRAY,
      collapsible: true,
    });
  }

  return {
    title: deity.name,
    kind: "deity",
    entityId: deityId,
    sections,
  };
}

// Inverse video for highlighting active section
const BG_HIGHLIGHT = "\x1b[7m";

/**
 * Render the detail panel
 *
 * The detail panel provides the divider between tree and detail panels.
 * Uses T-junction characters at top/bottom left to connect with tree borders.
 *
 * Returns both the lines and the section count (for updating state).
 */
export function renderDetailPanel(
  state: TuiState,
  layout: LayoutDimensions,
  world: AzgaarWorld,
  canon: CanonStore,
  isFocused?: boolean
): { lines: string[]; sectionCount: number } {
  const lines: string[] = [];
  const { detailWidth, detailContentHeight } = layout;
  const innerWidth = detailWidth - 2; // Account for left and right borders

  const content = buildDetailContent(state, world, canon);

  // Title bar - T-junction on left connects with tree panel top border
  const title = content ? ` ${content.title} ` : " Details ";
  const titleColor = content ? getEntityColor(content.kind) : FG_WHITE;
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BOX.horizontalDown}${BOX.horizontal.repeat(titlePadding)}${BOLD}${titleColor}${title}${RESET}${BOX.horizontal.repeat(
      Math.max(0, innerWidth - titlePadding - title.length)
    )}${BOX.topRight}`
  );

  // Content lines with section tracking
  const contentLines: string[] = [];
  let sectionCount = 0;

  if (content) {
    const expandedSections = state.detailExpandedSections;

    for (let sectionIdx = 0; sectionIdx < content.sections.length; sectionIdx++) {
      const section = content.sections[sectionIdx];
      // Sections with defaultExpanded start expanded; others start collapsed
      // User can toggle either way, and expandedSections tracks explicit toggles
      const hasBeenToggled = expandedSections.has(section.key);
      const isCollapsed = section.collapsible && (
        section.defaultExpanded ? hasBeenToggled : !hasBeenToggled
      );
      const isActiveSection = isFocused && sectionIdx === state.detailSectionIndex;

      // Section label with collapse indicator
      if (section.label) {
        contentLines.push("");

        // Build the label line with toggle indicator
        const toggleIcon = section.collapsible
          ? (isCollapsed ? "▸ " : "▾ ")
          : "  ";
        const labelText = `${toggleIcon}${section.label}`;
        const highlight = isActiveSection ? BG_HIGHLIGHT : "";
        const resetHighlight = isActiveSection ? RESET : "";

        contentLines.push(
          `${highlight}${BOLD}${section.color || FG_CYAN}${labelText}${RESET}${resetHighlight}`
        );

        // Underline (only if not collapsed)
        if (!isCollapsed) {
          contentLines.push(`${DIM}${"─".repeat(labelText.length)}${RESET}`);
        }
      }

      // Section content (only if not collapsed)
      if (!isCollapsed) {
        for (const line of section.content) {
          const wrapped = wrapText(line, innerWidth - 4); // Extra indent for content
          for (const wrapLine of wrapped) {
            contentLines.push(`  ${section.color || ""}${wrapLine}${section.color ? RESET : ""}`);
          }
        }

        // Render links if present
        if (section.links?.length) {
          for (let linkIdx = 0; linkIdx < section.links.length; linkIdx++) {
            const link = section.links[linkIdx];
            const linkColor = getEntityColor(link.kind);
            const relLabel = link.relationType ? ` (${link.relationType})` : "";
            const isSelectedLink = isActiveSection && linkIdx === state.detailLinkIndex;
            const linkHighlight = isSelectedLink ? BG_HIGHLIGHT : "";
            const linkReset = isSelectedLink ? RESET : "";
            contentLines.push(
              `  ${linkHighlight}${linkColor}→ ${link.name}${RESET}${DIM}${relLabel}${RESET}${linkReset}`
            );
          }
        }
      }

      sectionCount++;
    }
  } else {
    contentLines.push("");
    contentLines.push(`${DIM}No entity selected${RESET}`);
    contentLines.push("");
    contentLines.push("Navigate the tree on the left");
    contentLines.push("to view entity details here.");
  }

  // Apply scroll offset and render
  const visibleLines = contentLines.slice(
    state.detailScrollOffset,
    state.detailScrollOffset + detailContentHeight
  );

  for (let i = 0; i < detailContentHeight; i++) {
    const line = visibleLines[i] || "";
    // Left border serves as divider from tree panel
    const paddedLine = padRight(truncate(line, innerWidth), innerWidth);
    lines.push(`${BOX.vertical}${paddedLine}${BOX.vertical}`);
  }

  // Bottom border with scroll indicator - T-junction on left connects with tree bottom
  const totalLines = contentLines.length;
  const scrollInfo =
    totalLines > detailContentHeight
      ? ` ${state.detailScrollOffset + 1}-${Math.min(
          state.detailScrollOffset + detailContentHeight,
          totalLines
        )}/${totalLines} `
      : "";
  const bottomPadding = innerWidth - scrollInfo.length;
  lines.push(
    `${BOX.horizontalUp}${BOX.horizontal.repeat(
      Math.floor(bottomPadding / 2)
    )}${DIM}${scrollInfo}${RESET}${BOX.horizontal.repeat(
      Math.ceil(bottomPadding / 2)
    )}${BOX.bottomRight}`
  );

  return { lines, sectionCount };
}

/**
 * Get the section key at the current section index
 */
export function getCurrentSectionKey(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): string | undefined {
  const content = buildDetailContent(state, world, canon);
  if (!content) return undefined;
  const section = content.sections[state.detailSectionIndex];
  return section?.key;
}

/**
 * Get the current section's links (for navigation)
 */
export function getCurrentSectionLinks(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): DetailLink[] | undefined {
  const content = buildDetailContent(state, world, canon);
  if (!content) return undefined;
  const section = content.sections[state.detailSectionIndex];
  return section?.links;
}

/**
 * Check if current section is a links section (has links and is expanded)
 */
export function isCurrentSectionLinksExpanded(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): boolean {
  const content = buildDetailContent(state, world, canon);
  if (!content) return false;
  const section = content.sections[state.detailSectionIndex];
  if (!section?.links?.length) return false;

  // Check if section is expanded
  const hasBeenToggled = state.detailExpandedSections.has(section.key);
  const isCollapsed = section.collapsible && (
    section.defaultExpanded ? hasBeenToggled : !hasBeenToggled
  );
  return !isCollapsed;
}

/**
 * Render detail panel with focus indicator
 * Returns lines and section count for state updates
 */
export function renderDetailPanelWithBorder(
  state: TuiState,
  layout: LayoutDimensions,
  world: AzgaarWorld,
  canon: CanonStore,
  isFocused: boolean
): { lines: string[]; sectionCount: number } {
  const { lines, sectionCount } = renderDetailPanel(state, layout, world, canon, isFocused);

  if (isFocused) {
    const styledLines = lines.map((line, i) => {
      if (i === 0 || i === lines.length - 1) {
        return `${BOLD}${line}${RESET}`;
      }
      return line;
    });
    return { lines: styledLines, sectionCount };
  }

  return { lines, sectionCount };
}
