/**
 * BrowseState - Navigation state management for azbrowse CLI
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity } from "../canon/canon";
import { ChatState, newChatState } from "../chat/director";

// Entity reference types for navigation stack
export type EntityRef =
  | { kind: "world" }
  | { kind: "state"; stateId: number }
  | { kind: "burg"; burgId: number }
  | { kind: "location"; locationId: string }
  | { kind: "npc"; npcId: string }
  | { kind: "faction"; factionId: string }
  | { kind: "culture"; cultureId: number }
  | { kind: "religion"; religionId: number };

export type BrowseState = {
  stack: EntityRef[];           // Navigation path (current path, root is world)
  focusedNpcId?: string;        // NPC focus within location (for /talk mode)
  history: EntityRef[][];       // For back command (previous stack states)
  chatState: ChatState;         // Director/NPC state for LLM interactions
};

export function newBrowseState(): BrowseState {
  return {
    stack: [{ kind: "world" }],
    history: [],
    chatState: newChatState(),
  };
}

// Get current entity reference (top of stack)
export function currentRef(state: BrowseState): EntityRef {
  return state.stack[state.stack.length - 1] || { kind: "world" };
}

// Get current burg ID from stack (if any)
export function currentBurgId(state: BrowseState): number | undefined {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const ref = state.stack[i];
    if (ref.kind === "burg") return ref.burgId;
    if (ref.kind === "location") {
      // Location's burg is stored via anchors - handled by caller
      return undefined;
    }
  }
  return undefined;
}

// Get current state ID from stack (if any)
export function currentStateId(state: BrowseState): number | undefined {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const ref = state.stack[i];
    if (ref.kind === "state") return ref.stateId;
    if (ref.kind === "burg") return undefined; // Need to look up burg's state
  }
  return undefined;
}

// Get current location ID (if at a location or NPC within location)
export function currentLocationId(state: BrowseState): string | undefined {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const ref = state.stack[i];
    if (ref.kind === "location") return ref.locationId;
    if (ref.kind === "npc") continue; // Keep looking for parent location
  }
  return undefined;
}

// Navigate to a new entity (push onto stack)
export function navigateTo(state: BrowseState, ref: EntityRef): void {
  // Save current stack to history for back command
  state.history.push([...state.stack]);
  if (state.history.length > 50) state.history.shift(); // Limit history size

  state.stack.push(ref);

  // Update chat state for LLM context
  if (ref.kind === "burg") {
    state.chatState.currentBurgId = ref.burgId;
  } else if (ref.kind === "location") {
    state.chatState.currentLocationId = ref.locationId;
  } else if (ref.kind === "npc") {
    state.focusedNpcId = ref.npcId;
    state.chatState.currentNpcId = ref.npcId;
  }
}

// Navigate up one level (pop from stack)
export function navigateUp(state: BrowseState): boolean {
  if (state.stack.length <= 1) return false; // Can't go above root

  // Save current stack to history
  state.history.push([...state.stack]);
  if (state.history.length > 50) state.history.shift();

  const popped = state.stack.pop();

  // Clear focused NPC if we're leaving an NPC or location
  if (popped?.kind === "npc" || popped?.kind === "location") {
    state.focusedNpcId = undefined;
    state.chatState.currentNpcId = undefined;
  }

  // Update chat state based on where we are now
  const cur = currentRef(state);
  if (cur.kind === "burg") {
    state.chatState.currentBurgId = cur.burgId;
    state.chatState.currentLocationId = undefined;
  } else if (cur.kind === "location") {
    state.chatState.currentLocationId = cur.locationId;
  } else if (cur.kind === "state" || cur.kind === "world") {
    state.chatState.currentBurgId = undefined;
    state.chatState.currentLocationId = undefined;
  }

  return true;
}

// Navigate back to previous location (from history)
export function navigateBack(state: BrowseState): boolean {
  if (state.history.length === 0) return false;

  const prevStack = state.history.pop()!;
  state.stack = prevStack;
  state.focusedNpcId = undefined;

  // Update chat state based on new stack
  const cur = currentRef(state);
  if (cur.kind === "burg") {
    state.chatState.currentBurgId = cur.burgId;
    state.chatState.currentLocationId = undefined;
    state.chatState.currentNpcId = undefined;
  } else if (cur.kind === "location") {
    state.chatState.currentLocationId = cur.locationId;
    state.chatState.currentNpcId = undefined;
  } else if (cur.kind === "npc") {
    state.focusedNpcId = cur.npcId;
    state.chatState.currentNpcId = cur.npcId;
  }

  return true;
}

// Set navigation to a specific stack (replaces current)
export function setStack(state: BrowseState, newStack: EntityRef[]): void {
  state.history.push([...state.stack]);
  if (state.history.length > 50) state.history.shift();

  state.stack = newStack.length > 0 ? newStack : [{ kind: "world" }];
  state.focusedNpcId = undefined;

  // Update chat state
  const cur = currentRef(state);
  if (cur.kind === "burg") {
    state.chatState.currentBurgId = cur.burgId;
    state.chatState.currentLocationId = undefined;
    state.chatState.currentNpcId = undefined;
  } else if (cur.kind === "location") {
    state.chatState.currentLocationId = cur.locationId;
    state.chatState.currentNpcId = undefined;
  } else if (cur.kind === "npc") {
    state.focusedNpcId = cur.npcId;
    state.chatState.currentNpcId = cur.npcId;
  } else {
    state.chatState.currentBurgId = undefined;
    state.chatState.currentLocationId = undefined;
    state.chatState.currentNpcId = undefined;
  }
}

// Resolve entity ref to display name
export function refToName(ref: EntityRef, world: AzgaarWorld, canon: CanonStore): string {
  switch (ref.kind) {
    case "world":
      return "~";
    case "state": {
      const s = world.getState(ref.stateId);
      return s?.name || `state:${ref.stateId}`;
    }
    case "burg": {
      const b = world.getBurg(ref.burgId);
      return b?.name || `burg:${ref.burgId}`;
    }
    case "location": {
      const loc = canon.getEntity(ref.locationId);
      return loc?.name || ref.locationId;
    }
    case "npc": {
      const npc = canon.getEntity(ref.npcId);
      return npc?.name || ref.npcId;
    }
    case "faction": {
      const f = canon.getEntity(ref.factionId);
      return f?.name || ref.factionId;
    }
    case "culture": {
      const c = world.getCulture(ref.cultureId);
      return c?.name || `culture:${ref.cultureId}`;
    }
    case "religion": {
      const r = world.getReligion(ref.religionId);
      return r?.name || `religion:${ref.religionId}`;
    }
  }
}

// Get the path as a string (like pwd)
export function stackToPath(state: BrowseState, world: AzgaarWorld, canon: CanonStore): string {
  return state.stack.map(ref => refToName(ref, world, canon)).join(" / ");
}

// Check if we're at an NPC (for /talk context)
export function isAtNpc(state: BrowseState): boolean {
  const cur = currentRef(state);
  return cur.kind === "npc";
}

// Get entity details for current position
export function getCurrentEntity(
  state: BrowseState,
  world: AzgaarWorld,
  canon: CanonStore
): { kind: string; entity: any; id?: string | number } | undefined {
  const cur = currentRef(state);

  switch (cur.kind) {
    case "world":
      return { kind: "world", entity: { name: "World Root" } };
    case "state": {
      const s = world.getState(cur.stateId);
      return s ? { kind: "state", entity: s, id: cur.stateId } : undefined;
    }
    case "burg": {
      const b = world.getBurg(cur.burgId);
      return b ? { kind: "burg", entity: b, id: cur.burgId } : undefined;
    }
    case "location": {
      const loc = canon.getEntity(cur.locationId);
      return loc ? { kind: "location", entity: loc, id: cur.locationId } : undefined;
    }
    case "npc": {
      const npc = canon.getEntity(cur.npcId);
      return npc ? { kind: "npc", entity: npc, id: cur.npcId } : undefined;
    }
    case "faction": {
      const f = canon.getEntity(cur.factionId);
      return f ? { kind: "faction", entity: f, id: cur.factionId } : undefined;
    }
    case "culture": {
      const c = world.getCulture(cur.cultureId);
      return c ? { kind: "culture", entity: c, id: cur.cultureId } : undefined;
    }
    case "religion": {
      const r = world.getReligion(cur.religionId);
      return r ? { kind: "religion", entity: r, id: cur.religionId } : undefined;
    }
  }
}
