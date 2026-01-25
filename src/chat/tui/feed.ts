import type { FeedItem, NpcListItem } from "./types";
import type { CanonEntity } from "../../canon/canon";

/**
 * Generate a unique ID for feed items
 */
function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a feed item for user input
 */
export function createUserInputItem(text: string): FeedItem {
  return {
    id: makeId("input"),
    type: "user_input",
    timestamp: Date.now(),
    collapsed: false,  // User input is not collapsed
    highlighted: false,
    text,
  };
}

/**
 * Create a feed item for a tool call
 */
export function createToolCallItem(name: string, args: Record<string, any>): FeedItem {
  return {
    id: makeId("tool"),
    type: "tool_call",
    timestamp: Date.now(),
    collapsed: true,  // Tool calls collapsed by default
    highlighted: false,
    toolName: name,
    toolArgs: args,
  };
}

/**
 * Create a feed item for a tool result
 */
export function createToolResultItem(name: string, result: any, elapsedMs: number): FeedItem {
  return {
    id: makeId("result"),
    type: "tool_result",
    timestamp: Date.now(),
    collapsed: true,  // Results collapsed by default
    highlighted: false,
    toolName: name,
    toolResult: result,
    elapsedMs,
  };
}

/**
 * Create a feed item for LLM text response
 */
export function createLlmTextItem(text: string): FeedItem {
  return {
    id: makeId("llm"),
    type: "llm_text",
    timestamp: Date.now(),
    collapsed: false,
    highlighted: false,
    text,
  };
}

/**
 * Create a feed item for narration
 */
export function createNarrationItem(text: string): FeedItem {
  return {
    id: makeId("narration"),
    type: "narration",
    timestamp: Date.now(),
    collapsed: false,
    highlighted: false,
    text,
  };
}

/**
 * Create a feed item for scene header
 */
export function createSceneHeaderItem(sceneName: string): FeedItem {
  return {
    id: makeId("scene"),
    type: "scene_header",
    timestamp: Date.now(),
    collapsed: false,
    highlighted: false,
    sceneName,
  };
}

/**
 * Convert a CanonEntity (NPC) to an NpcListItem
 */
export function entityToNpcListItem(entity: CanonEntity): NpcListItem {
  return {
    id: entity.id,
    name: entity.name,
    summary: entity.summary || "No description",
    tags: entity.tags || [],
    detailsMd: entity.details_md || undefined,
    payload: entity.payload || undefined,
  };
}

/**
 * Create a feed item for NPC list
 */
export function createNpcListItem(npcs: CanonEntity[]): FeedItem {
  return {
    id: makeId("npcs"),
    type: "npc_list",
    timestamp: Date.now(),
    collapsed: true,  // Collapsed by default, expands to full list
    highlighted: false,
    npcs: npcs.map(entityToNpcListItem),
  };
}

/**
 * Update a tool call item with its result
 * Returns a new item with result attached
 */
export function attachToolResult(
  item: FeedItem,
  result: any,
  elapsedMs: number
): FeedItem {
  if (item.type !== "tool_call") {
    return item;
  }
  return {
    ...item,
    toolResult: result,
    elapsedMs,
  };
}

/**
 * Check if a feed item is expandable (has detail view)
 */
export function isExpandable(item: FeedItem): boolean {
  switch (item.type) {
    case "tool_call":
      return true; // Can expand to show args and result
    case "npc_list":
      return true; // Can expand to navigate NPCs
    case "narration":
    case "llm_text":
      return item.text !== undefined && item.text.length > 80;
    default:
      return false;
  }
}

/**
 * Check if a feed item is copyable
 */
export function isCopyable(item: FeedItem): boolean {
  switch (item.type) {
    case "user_input":
    case "narration":
    case "llm_text":
      return !!item.text;
    case "tool_call":
      return true; // Can copy args/result as JSON
    case "tool_result":
      return true;
    default:
      return false;
  }
}

/**
 * Get the copyable content from a feed item
 */
export function getCopyableContent(item: FeedItem): string {
  switch (item.type) {
    case "user_input":
    case "narration":
    case "llm_text":
      return item.text || "";
    case "tool_call": {
      const content: any = {
        tool: item.toolName,
        args: item.toolArgs,
      };
      if (item.toolResult !== undefined) {
        content.result = item.toolResult;
      }
      if (item.elapsedMs !== undefined) {
        content.elapsedMs = item.elapsedMs;
      }
      return JSON.stringify(content, null, 2);
    }
    case "tool_result":
      return JSON.stringify(item.toolResult, null, 2);
    default:
      return "";
  }
}
