/**
 * Tree node utilities for azbrowse TUI
 *
 * Handles building tree nodes from EntityRefs and lazy loading children.
 */

import type { TreeNode, EntityKind } from "./types";
import type { EntityRef, BrowseState } from "../state";
import type { AzgaarWorld } from "../../world/azgaar";
import type { CanonStore, CanonEntity } from "../../canon/canon";

/**
 * Convert EntityRef to a unique node ID
 */
export function refToNodeId(ref: EntityRef): string {
  switch (ref.kind) {
    case "world":
      return "world";
    case "state":
      return `state:${ref.stateId}`;
    case "burg":
      return `burg:${ref.burgId}`;
    case "location":
      return `location:${ref.locationId}`;
    case "npc":
      return `npc:${ref.npcId}`;
  }
}

/**
 * Parse node ID back to EntityRef
 */
export function nodeIdToRef(nodeId: string): EntityRef {
  if (nodeId === "world") {
    return { kind: "world" };
  }

  const [kind, id] = nodeId.split(":");
  switch (kind) {
    case "state":
      return { kind: "state", stateId: parseInt(id, 10) };
    case "burg":
      return { kind: "burg", burgId: parseInt(id, 10) };
    case "location":
      return { kind: "location", locationId: id };
    case "npc":
      return { kind: "npc", npcId: id };
    default:
      return { kind: "world" };
  }
}

/**
 * Get the EntityKind for an EntityRef
 */
export function getEntityKind(ref: EntityRef): EntityKind {
  return ref.kind as EntityKind;
}

/**
 * Create root tree node (world)
 */
export function createRootNode(world: AzgaarWorld): TreeNode {
  return {
    id: "world",
    ref: { kind: "world" },
    name: "World",
    kind: "world",
    expanded: true,
    hasChildren: true,
    depth: 0,
    isSelected: false,
  };
}

/**
 * Create tree node from a state
 */
export function createStateNode(
  state: { id: number; name: string; form?: string; formName?: string },
  depth: number,
  expanded: boolean
): TreeNode {
  return {
    id: `state:${state.id}`,
    ref: { kind: "state", stateId: state.id },
    name: state.name,
    kind: "state",
    expanded,
    hasChildren: true,
    depth,
    isSelected: false,
    extra: state.formName || state.form,
  };
}

/**
 * Create tree node from a burg
 */
export function createBurgNode(
  burg: { id: number; name: string; population?: number; pop?: number; capital?: boolean; port?: boolean },
  depth: number,
  expanded: boolean
): TreeNode {
  const pop = burg.population ?? burg.pop;
  const traits: string[] = [];
  if (burg.capital) traits.push("capital");
  if (burg.port) traits.push("port");

  return {
    id: `burg:${burg.id}`,
    ref: { kind: "burg", burgId: burg.id },
    name: burg.name,
    kind: "burg",
    expanded,
    hasChildren: true,
    depth,
    isSelected: false,
    extra: pop ? `pop: ${pop}${traits.length ? ` (${traits.join(", ")})` : ""}` : undefined,
  };
}

/**
 * Create tree node from a location
 */
export function createLocationNode(
  location: CanonEntity,
  depth: number,
  expanded: boolean
): TreeNode {
  return {
    id: `location:${location.id}`,
    ref: { kind: "location", locationId: location.id },
    name: location.name,
    kind: "location",
    expanded,
    hasChildren: true,
    depth,
    isSelected: false,
    extra: location.payload?.kind as string | undefined,
  };
}

/**
 * Create tree node from an NPC
 */
export function createNpcNode(npc: CanonEntity, depth: number): TreeNode {
  return {
    id: `npc:${npc.id}`,
    ref: { kind: "npc", npcId: npc.id },
    name: npc.name,
    kind: "npc",
    expanded: false,
    hasChildren: false, // NPCs are leaf nodes
    depth,
    isSelected: false,
    extra: npc.tags?.slice(0, 2).join(", "),
  };
}

/**
 * Create tree node from a faction
 */
export function createFactionNode(faction: CanonEntity, depth: number): TreeNode {
  return {
    id: `faction:${faction.id}`,
    ref: { kind: "location", locationId: faction.id }, // Use location kind for navigation
    name: faction.name,
    kind: "faction",
    expanded: false,
    hasChildren: false,
    depth,
    isSelected: false,
    extra: faction.payload?.kind as string | undefined,
  };
}

/**
 * Create tree node from an event
 */
export function createEventNode(event: CanonEntity, depth: number): TreeNode {
  return {
    id: `event:${event.id}`,
    ref: { kind: "location", locationId: event.id }, // Use location kind for navigation
    name: event.name,
    kind: "event",
    expanded: false,
    hasChildren: false,
    depth,
    isSelected: false,
    extra: event.payload?.scope as string | undefined,
  };
}

/**
 * Get children for a tree node
 * This is the lazy loading function called when a node is expanded
 */
export function getTreeChildren(
  nodeId: string,
  world: AzgaarWorld,
  canon: CanonStore,
  expandedNodes: Set<string>
): TreeNode[] {
  const ref = nodeIdToRef(nodeId);
  const depth = nodeId.split(":").length; // Simple depth calculation

  switch (ref.kind) {
    case "world": {
      // World -> States
      const states = world.listStates();
      states.sort((a, b) => a.name.localeCompare(b.name));
      return states.map((s) => createStateNode(s, 1, expandedNodes.has(`state:${s.id}`)));
    }

    case "state": {
      // State -> Burgs in that state
      const burgs = world.listBurgs().filter((b) => b.state === ref.stateId);
      burgs.sort((a, b) => (b.population ?? b.pop ?? 0) - (a.population ?? a.pop ?? 0));
      return burgs.slice(0, 50).map((b) => createBurgNode(b, depth + 1, expandedNodes.has(`burg:${b.id}`)));
    }

    case "burg": {
      // Burg -> Locations in that burg
      const locations = canon.listEntities({
        type: "location",
        anchors: { burgId: ref.burgId },
        limit: 100,
      });
      return locations.map((l) =>
        createLocationNode(l, depth + 1, expandedNodes.has(`location:${l.id}`))
      );
    }

    case "location": {
      // Location -> NPCs at that location
      const rels = canon.listRelations({ entity_id: ref.locationId, limit: 200 });
      const npcIds = rels
        .filter((r) => r.rel_type === "located_at" && r.to_id === ref.locationId)
        .map((r) => r.from_id);

      const npcs = npcIds
        .map((id) => canon.getEntity(id))
        .filter((e): e is CanonEntity => e !== undefined && e.type === "npc");

      return npcs.map((n) => createNpcNode(n, depth + 1));
    }

    case "npc":
      // NPCs are leaf nodes
      return [];

    default:
      return [];
  }
}

/**
 * Build the full tree from current state
 * Includes all expanded nodes and their children
 */
export function buildTree(
  world: AzgaarWorld,
  canon: CanonStore,
  expandedNodes: Set<string>,
  selectedNodeId: string | null
): TreeNode[] {
  const nodes: TreeNode[] = [];

  // Add root
  const root = createRootNode(world);
  root.expanded = expandedNodes.has("world") || true; // Root always expanded
  root.isSelected = selectedNodeId === "world";
  nodes.push(root);

  // Recursively add children for expanded nodes
  function addChildren(parentId: string, depth: number) {
    if (!expandedNodes.has(parentId) && parentId !== "world") return;

    const children = getTreeChildren(parentId, world, canon, expandedNodes);
    for (const child of children) {
      child.isSelected = selectedNodeId === child.id;
      child.depth = depth;
      nodes.push(child);

      // Recursively add grandchildren if this node is expanded
      if (child.expanded && child.hasChildren) {
        addChildren(child.id, depth + 1);
      }
    }
  }

  addChildren("world", 1);

  return nodes;
}

/**
 * Find the path from root to a given node ID
 */
export function findPathToNode(
  nodeId: string,
  world: AzgaarWorld,
  canon: CanonStore
): string[] {
  const path: string[] = ["world"];

  if (nodeId === "world") return path;

  const ref = nodeIdToRef(nodeId);

  switch (ref.kind) {
    case "state":
      path.push(`state:${ref.stateId}`);
      break;

    case "burg": {
      const burg = world.getBurg(ref.burgId);
      if (burg?.state !== undefined) {
        path.push(`state:${burg.state}`);
      }
      path.push(`burg:${ref.burgId}`);
      break;
    }

    case "location": {
      const location = canon.getEntity(ref.locationId);
      const burgId = location?.anchors?.burgId as number | undefined;
      if (burgId !== undefined) {
        const burg = world.getBurg(burgId);
        if (burg?.state !== undefined) {
          path.push(`state:${burg.state}`);
        }
        path.push(`burg:${burgId}`);
      }
      path.push(`location:${ref.locationId}`);
      break;
    }

    case "npc": {
      const npc = canon.getEntity(ref.npcId);
      const burgId = npc?.anchors?.burgId as number | undefined;
      if (burgId !== undefined) {
        const burg = world.getBurg(burgId);
        if (burg?.state !== undefined) {
          path.push(`state:${burg.state}`);
        }
        path.push(`burg:${burgId}`);
      }

      // Check if NPC is at a location
      const rels = canon.listRelations({ entity_id: ref.npcId, limit: 50 });
      const locationRel = rels.find(
        (r) => r.rel_type === "located_at" && r.from_id === ref.npcId
      );
      if (locationRel) {
        path.push(`location:${locationRel.to_id}`);
      }

      path.push(`npc:${ref.npcId}`);
      break;
    }
  }

  return path;
}

/**
 * Expand all nodes in the path to a given node
 */
export function expandPathToNode(
  nodeId: string,
  currentExpanded: Set<string>,
  world: AzgaarWorld,
  canon: CanonStore
): Set<string> {
  const path = findPathToNode(nodeId, world, canon);
  const newExpanded = new Set(currentExpanded);

  // Add all nodes except the target (leaf nodes shouldn't be "expanded")
  for (let i = 0; i < path.length - 1; i++) {
    newExpanded.add(path[i]);
  }

  return newExpanded;
}
