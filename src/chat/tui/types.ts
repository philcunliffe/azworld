import { z } from "zod";

// Navigation modes
export const NavigationModeEnum = z.enum([
  "normal",       // readline input active
  "feed_nav",     // navigating feed items
  "npc_list",     // navigating NPC list
  "npc_detail",   // viewing NPC detail panel
  "expanded_item" // viewing expanded tool call
]);

export type NavigationMode = z.infer<typeof NavigationModeEnum>;

// NPC detail tabs
export const NpcDetailTabEnum = z.enum(["description", "dm_info", "talk"]);
export type NpcDetailTab = z.infer<typeof NpcDetailTabEnum>;

// Feed item types
export const FeedItemTypeEnum = z.enum([
  "user_input",
  "tool_call",
  "tool_result",
  "llm_text",
  "narration",
  "scene_header",
  "npc_list"
]);

export type FeedItemType = z.infer<typeof FeedItemTypeEnum>;

// NPC list item (for navigable NPC menu)
export const NpcListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),           // One-sentence description
  tags: z.array(z.string()),
  detailsMd: z.string().optional(),         // Full description
  payload: z.record(z.any()).optional(),    // DM-only info (motivation, secrets, attitude)
});

export type NpcListItem = z.infer<typeof NpcListItemSchema>;

// Feed item schema
export const FeedItemSchema = z.object({
  id: z.string(),
  type: FeedItemTypeEnum,
  timestamp: z.number(),
  collapsed: z.boolean(),
  highlighted: z.boolean(),
  // Content fields vary by type
  toolName: z.string().optional(),
  toolArgs: z.record(z.any()).optional(),
  toolResult: z.any().optional(),
  elapsedMs: z.number().optional(),
  text: z.string().optional(),
  npcs: z.array(NpcListItemSchema).optional(),
  sceneName: z.string().optional(),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;

// TUI state
export const TuiStateSchema = z.object({
  mode: NavigationModeEnum,
  feedItems: z.array(FeedItemSchema),
  highlightedItemId: z.string().nullable(),
  npcListIndex: z.number(),
  selectedNpcId: z.string().nullable(),
  npcDetailTab: NpcDetailTabEnum,
  // Track tool calls waiting for results
  pendingToolCalls: z.record(z.object({
    name: z.string(),
    args: z.record(z.any()),
    startTime: z.number(),
  })),
});

export type TuiState = z.infer<typeof TuiStateSchema>;

// Callbacks from TUI to main app
export type TuiCallbacks = {
  onTalkToNpc: (npcId: string) => void;
  onCopyToClipboard: (text: string) => void;
  onExitNavigation: () => void;
  onInputSubmit: (text: string) => void;
};

// Action types for state reducer
export type TuiAction =
  | { type: "ADD_FEED_ITEM"; item: FeedItem }
  | { type: "UPDATE_FEED_ITEM"; id: string; updates: Partial<FeedItem> }
  | { type: "SET_MODE"; mode: NavigationMode }
  | { type: "HIGHLIGHT_ITEM"; id: string | null }
  | { type: "TOGGLE_COLLAPSED"; id: string }
  | { type: "SET_NPC_LIST_INDEX"; index: number }
  | { type: "SET_SELECTED_NPC"; id: string | null }
  | { type: "SET_NPC_DETAIL_TAB"; tab: NpcDetailTab }
  | { type: "NAVIGATE_FEED"; direction: "up" | "down" }
  | { type: "ADD_PENDING_TOOL"; id: string; name: string; args: Record<string, any> }
  | { type: "RESOLVE_PENDING_TOOL"; id: string; result: any; elapsedMs: number }
  | { type: "CLEAR_FEED" };
