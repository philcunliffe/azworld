/**
 * Search utilities for azbrowse TUI
 *
 * Provides unified search across world (Azgaar) and canon (SQLite) entities.
 */

import type { SearchResult, EntityKind } from "./types";
import type { AzgaarWorld } from "../../world/azgaar";
import type { CanonStore, CanonEntity } from "../../canon/canon";

/**
 * Score a name match (higher = better match)
 */
function scoreName(query: string, name: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();

  // Exact match
  if (n === q) return 1.0;

  // Starts with query
  if (n.startsWith(q)) return 0.9;

  // Contains query
  const idx = n.indexOf(q);
  if (idx >= 0) return 0.7 - Math.min(0.2, idx / 100);

  return 0;
}

/**
 * Build breadcrumb for a world entity
 */
function buildWorldBreadcrumb(kind: string, entity: any, world: AzgaarWorld): string {
  if (kind === "state") return "World";
  if (kind === "burg") {
    const state = world.getState(entity.state);
    return state ? `World > ${state.name}` : "World";
  }
  return "World";
}

/**
 * Build breadcrumb for a canon entity
 */
function buildCanonBreadcrumb(entity: CanonEntity, world: AzgaarWorld): string {
  const parts = ["Canon"];

  const burgId = entity.anchors?.burgId as number | undefined;
  if (burgId !== undefined) {
    const burg = world.getBurg(burgId);
    if (burg) {
      const state = world.getState(burg.state);
      if (state) parts.push(state.name);
      parts.push(burg.name);
    }
  }

  return parts.join(" > ");
}

/**
 * Map world search kind to EntityKind
 */
function worldKindToEntityKind(kind: string): EntityKind {
  switch (kind) {
    case "state":
      return "state";
    case "burg":
      return "burg";
    default:
      return "world";
  }
}

/**
 * Map canon entity type to EntityKind
 */
function canonTypeToEntityKind(type: string): EntityKind {
  switch (type) {
    case "npc":
      return "npc";
    case "location":
      return "location";
    case "faction":
      return "faction";
    case "event":
      return "event";
    case "rumor":
      return "rumor";
    case "hook":
      return "hook";
    case "deity":
      return "deity";
    case "marker":
      return "marker";
    default:
      return "location";
  }
}

/**
 * Perform unified search across world and canon
 */
export function performSearch(
  query: string,
  world: AzgaarWorld,
  canon: CanonStore,
  limit: number = 20
): SearchResult[] {
  const q = query.trim();
  if (q.length < 2) return []; // Require at least 2 chars

  const results: SearchResult[] = [];

  // Search world entities (states, burgs)
  const worldResults = world.search(q, ["states", "burgs"], limit);
  for (const wr of worldResults) {
    results.push({
      id: `${wr.kind}:${wr.id}`,
      name: wr.name,
      kind: worldKindToEntityKind(wr.kind),
      score: wr.score ?? scoreName(q, wr.name),
      breadcrumb: buildWorldBreadcrumb(wr.kind, wr.raw, world),
      source: "world",
    });
  }

  for (const culture of world.listCultures()) {
    const score = scoreName(q, culture.name);
    if (score > 0.1) {
      results.push({
        id: `culture:${culture.id}`,
        name: culture.name,
        kind: "culture",
        score,
        breadcrumb: "World > Cultures",
        source: "world",
      });
    }
  }

  for (const religion of world.listReligions()) {
    const score = scoreName(q, religion.name);
    if (score > 0.1) {
      results.push({
        id: `religion:${religion.id}`,
        name: religion.name,
        kind: "religion",
        score,
        breadcrumb: "World > Religions",
        source: "world",
      });
    }
  }

  // Search canon entities
  const canonTypes = ["location", "npc", "faction", "deity", "event", "rumor", "hook", "marker"] as const;
  for (const type of canonTypes) {
    const entities = canon.listEntities({ type, text: q, limit: limit * 2 });
    for (const entity of entities) {
      const score = scoreName(q, entity.name);
      if (score > 0.1) {
        results.push({
          id: `${type}:${entity.id}`,
          name: entity.name,
          kind: canonTypeToEntityKind(type),
          score,
          breadcrumb: buildCanonBreadcrumb(entity, world),
          source: "canon",
        });
      }
    }
  }

  // Sort by score descending, then name
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      unique.push(r);
    }
    if (unique.length >= limit) break;
  }

  return unique;
}
