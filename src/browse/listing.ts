/**
 * Listing implementations for azbrowse CLI (ls command and variants)
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity } from "../canon/canon";
import { BrowseState, currentRef, currentBurgId } from "./state";
import { formatKind, formatTags, padRight } from "./prompt";

// Color codes
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

export type ListResult = {
  items: Array<{
    name: string;
    kind?: string;
    tags?: string[];
    id?: string | number;
    extra?: string;
  }>;
  context: string; // e.g., "burgs in Realm", "locations in Portsville"
};

// List states in the world
export function listStates(world: AzgaarWorld): ListResult {
  const states = world.listStates();
  states.sort((a, b) => a.name.localeCompare(b.name));

  return {
    items: states.map(s => ({
      name: s.name,
      kind: s.formName || s.form,
      id: s.id,
    })),
    context: "states in world",
  };
}

// List burgs (optionally filtered by state)
export function listBurgs(world: AzgaarWorld, stateId?: number, limit = 30): ListResult {
  let burgs = world.listBurgs();

  if (stateId !== undefined) {
    burgs = burgs.filter(b => b.state === stateId);
  }

  // Sort by population descending
  burgs.sort((a, b) => (b.population ?? b.pop ?? 0) - (a.population ?? a.pop ?? 0));
  burgs = burgs.slice(0, limit);

  const stateName = stateId !== undefined ? world.getState(stateId)?.name : undefined;
  const context = stateName ? `burgs in ${stateName}` : "burgs in world";

  return {
    items: burgs.map(b => ({
      name: b.name,
      kind: b.capital ? "capital" : b.port ? "port" : undefined,
      id: b.id,
      extra: `pop: ${b.population ?? b.pop ?? "?"}`,
    })),
    context,
  };
}

// List locations (optionally filtered by burgId, stateId, or kind)
export function listLocations(
  canon: CanonStore,
  world: AzgaarWorld,
  opts: { burgId?: number; stateId?: number; kind?: string }
): ListResult {
  let locations: CanonEntity[];

  if (opts.burgId !== undefined) {
    // Single burg
    locations = canon.listEntities({
      type: "location",
      anchors: { burgId: opts.burgId },
      limit: 200,
    });
  } else if (opts.stateId !== undefined) {
    // All burgs in state
    const burgIds = world.listBurgs()
      .filter(b => b.state === opts.stateId)
      .map(b => b.id);
    locations = [];
    for (const bid of burgIds) {
      const locs = canon.listEntities({
        type: "location",
        anchors: { burgId: bid },
        limit: 100,
      });
      locations.push(...locs);
    }
  } else {
    // All locations
    locations = canon.listEntities({ type: "location", limit: 500 });
  }

  if (opts.kind) {
    locations = locations.filter(l => {
      const k = l.payload?.kind as string | undefined;
      return k?.toLowerCase().includes(opts.kind!.toLowerCase());
    });
  }

  return {
    items: locations.map(l => ({
      name: l.name,
      kind: l.payload?.kind as string | undefined,
      tags: l.tags,
      id: l.id,
    })),
    context: opts.kind ? `${opts.kind} locations` : "locations",
  };
}

// List NPCs at a location, in a burg, or in a state
export function listNpcs(
  canon: CanonStore,
  world: AzgaarWorld,
  opts: { locationId?: string; burgId?: number; stateId?: number }
): ListResult {
  let npcs: CanonEntity[];

  if (opts.locationId) {
    // Get NPCs at specific location via relations
    const rels = canon.listRelations({ entity_id: opts.locationId, limit: 200 });
    const npcIds = rels
      .filter(r => r.rel_type === "located_at" && r.to_id === opts.locationId)
      .map(r => r.from_id);

    npcs = npcIds
      .map(id => canon.getEntity(id))
      .filter((e): e is CanonEntity => e !== undefined && e.type === "npc");
  } else if (opts.burgId !== undefined) {
    npcs = canon.listEntities({
      type: "npc",
      anchors: { burgId: opts.burgId },
      limit: 200,
    });
  } else if (opts.stateId !== undefined) {
    // All burgs in state
    const burgIds = world.listBurgs()
      .filter(b => b.state === opts.stateId)
      .map(b => b.id);
    npcs = [];
    for (const bid of burgIds) {
      const burgNpcs = canon.listEntities({
        type: "npc",
        anchors: { burgId: bid },
        limit: 100,
      });
      npcs.push(...burgNpcs);
    }
  } else {
    npcs = canon.listEntities({ type: "npc", limit: 200 });
  }

  return {
    items: npcs.map(n => ({
      name: n.name,
      tags: n.tags,
      id: n.id,
      extra: n.summary?.slice(0, 40),
    })),
    context: "npcs",
  };
}

// List factions in context
export function listFactions(canon: CanonStore, burgId?: number): ListResult {
  const factions = canon.listEntities({
    type: "faction",
    anchors: burgId !== undefined ? { burgId } : undefined,
    limit: 50,
  });

  return {
    items: factions.map(f => ({
      name: f.name,
      kind: f.payload?.kind as string | undefined,
      tags: f.tags,
      id: f.id,
    })),
    context: "factions",
  };
}

// List events affecting context
export function listEvents(canon: CanonStore, opts: { burgId?: number; stateId?: number }): ListResult {
  const events = canon.getActiveEvents({
    burgId: opts.burgId,
    stateId: opts.stateId,
    recencyDays: 365,
  });

  return {
    items: events.map(e => ({
      name: e.name,
      kind: e.payload?.scope as string | undefined,
      tags: [e.payload?.severity as string].filter(Boolean),
      id: e.id,
      extra: `${e.payload?.daysAgo ?? 0} days ago`,
    })),
    context: "events",
  };
}

// List rumors and hooks (combined)
export function listRumorsAndHooks(canon: CanonStore, burgId?: number): ListResult {
  const rumors = canon.listEntities({
    type: "rumor",
    anchors: burgId !== undefined ? { burgId } : undefined,
    limit: 30,
  });
  const hooks = canon.listEntities({
    type: "hook",
    anchors: burgId !== undefined ? { burgId } : undefined,
    limit: 30,
  });

  const all = [...rumors, ...hooks];

  return {
    items: all.map(r => ({
      name: r.name,
      kind: r.type,
      tags: r.tags,
      id: r.id,
      extra: r.type === "rumor"
        ? `${r.payload?.truthLevel || "?"} · ${r.payload?.spreadLevel || "local"}`
        : `${r.payload?.hookType || "quest"} · ${r.payload?.urgency || "whenever"}`,
    })),
    context: "rumors & hooks",
  };
}

// List only rumors
export function listRumorsOnly(canon: CanonStore, burgId?: number): ListResult {
  const rumors = canon.listEntities({
    type: "rumor",
    anchors: burgId !== undefined ? { burgId } : undefined,
    limit: 50,
  });

  return {
    items: rumors.map(r => ({
      name: r.name,
      kind: `${r.payload?.truthLevel || "?"} truth`,
      tags: [r.payload?.spreadLevel as string, r.payload?.sourceType as string].filter(Boolean),
      id: r.id,
      extra: r.summary?.slice(0, 50) || undefined,
    })),
    context: "rumors",
  };
}

// List only hooks
export function listHooksOnly(canon: CanonStore, burgId?: number): ListResult {
  const hooks = canon.listEntities({
    type: "hook",
    anchors: burgId !== undefined ? { burgId } : undefined,
    limit: 50,
  });

  return {
    items: hooks.map(h => ({
      name: h.name,
      kind: h.payload?.hookType as string | undefined,
      tags: [h.payload?.difficulty as string, h.payload?.urgency as string].filter(Boolean),
      id: h.id,
      extra: h.payload?.rewardType as string | undefined,
    })),
    context: "hooks",
  };
}

// Alias for backward compatibility
export const listRumors = listRumorsAndHooks;

function listEntityRelations(canon: CanonStore, entityId: string, context: string): ListResult {
  const relations = canon.listRelations({ entity_id: entityId, limit: 100 });
  return {
    items: relations.map(rel => {
      const otherId = rel.from_id === entityId ? rel.to_id : rel.from_id;
      const other = canon.getEntity(otherId);
      return {
        name: other?.name || otherId,
        kind: other?.type || rel.rel_type,
        id: otherId,
        extra: rel.from_id === entityId ? rel.rel_type : `← ${rel.rel_type}`,
      };
    }),
    context,
  };
}

// Context-aware listing based on current navigation state
export function listContextual(
  state: BrowseState,
  world: AzgaarWorld,
  canon: CanonStore,
  filter?: string
): ListResult {
  const cur = currentRef(state);

  switch (cur.kind) {
    case "world":
      if (filter === "burgs") return listBurgs(world);
      if (filter === "locations") return listLocations(canon, world, {});
      if (filter === "npcs") return listNpcs(canon, world, {});
      if (filter === "factions") return listFactions(canon);
      if (filter === "events") return listEvents(canon, {});
      return listStates(world);

    case "state":
      if (filter === "locations") return listLocations(canon, world, { stateId: cur.stateId });
      if (filter === "npcs") return listNpcs(canon, world, { stateId: cur.stateId });
      if (filter === "factions") return listFactions(canon);
      if (filter === "events") return listEvents(canon, { stateId: cur.stateId });
      return listBurgs(world, cur.stateId);

    case "burg":
      if (filter === "npcs") return listNpcs(canon, world, { burgId: cur.burgId });
      if (filter === "factions") return listFactions(canon, cur.burgId);
      if (filter === "events") {
        const burg = world.getBurg(cur.burgId);
        const stateId = typeof burg?.state === "number" ? burg.state : undefined;
        return listEvents(canon, { burgId: cur.burgId, stateId });
      }
      if (filter === "rumors") return listRumorsOnly(canon, cur.burgId);
      if (filter === "hooks") return listHooksOnly(canon, cur.burgId);
      if (filter === "rumors&hooks" || filter === "quests") return listRumorsAndHooks(canon, cur.burgId);
      return listLocations(canon, world, { burgId: cur.burgId, kind: filter });

    case "location":
      // Get parent burg from location's anchors
      const loc = canon.getEntity(cur.locationId);
      const locBurgId = loc?.anchors?.burgId as number | undefined;

      if (filter === "factions") return listFactions(canon, locBurgId);
      if (filter === "events") return listEvents(canon, { burgId: locBurgId });
      return listNpcs(canon, world, { locationId: cur.locationId });

    case "npc":
      return listEntityRelations(canon, cur.npcId, "npc relations");

    case "faction":
      return listEntityRelations(canon, cur.factionId, "faction relations");

    case "event":
      return listEntityRelations(canon, cur.eventId, "event relations");

    case "rumor":
      return listEntityRelations(canon, cur.rumorId, "rumor relations");

    case "hook":
      return listEntityRelations(canon, cur.hookId, "hook relations");

    case "deity":
      return listEntityRelations(canon, cur.deityId, "deity relations");

    case "culture": {
      const culture = world.getCulture(cur.cultureId);
      if (!culture) return { items: [], context: "culture" };
      const states = world.listStates().filter(s => s.culture === cur.cultureId);
      return {
        items: states.map(s => ({
          name: s.name,
          kind: s.formName || s.form,
          id: s.id,
        })),
        context: `${culture.name} states`,
      };
    }

    case "religion": {
      const religion = world.getReligion(cur.religionId);
      if (!religion) return { items: [], context: "religion" };
      const deities = canon.listEntities({ type: "deity", limit: 100 })
        .filter(e => e.anchors?.azgaarReligionId === cur.religionId);
      return {
        items: deities.map(d => ({
          name: d.name,
          kind: d.payload?.rank as string | undefined,
          id: d.id,
          extra: (d.payload?.domains as string[] | undefined)?.slice(0, 2).join(", "),
        })),
        context: `${religion.name} deities`,
      };
    }

    default:
      return { items: [], context: "unknown context" };
  }
}

// Format list results for display
export function formatListResult(result: ListResult, useColors = true): string {
  if (result.items.length === 0) {
    return `  (no ${result.context})`;
  }

  const lines: string[] = [];
  const maxNameLen = Math.max(...result.items.map(i => i.name.length), 10);

  const dim = useColors ? DIM : "";
  const reset = useColors ? RESET : "";

  for (const item of result.items) {
    let line = "  ";

    // Name (padded)
    if (useColors) {
      line += padRight(item.name, maxNameLen + 2);
    } else {
      line += item.name.padEnd(maxNameLen + 2);
    }

    // Kind/tags
    const annotations: string[] = [];
    if (item.kind) {
      annotations.push(`${dim}(${item.kind})${reset}`);
    }
    if (item.tags && item.tags.length > 0) {
      const tagStr = item.tags.slice(0, 3).join(", ");
      annotations.push(`${dim}[${tagStr}]${reset}`);
    }
    if (item.extra) {
      annotations.push(`${dim}${item.extra}${reset}`);
    }

    if (annotations.length > 0) {
      line += annotations.join(" ");
    }

    lines.push(line);
  }

  return lines.join("\n");
}
