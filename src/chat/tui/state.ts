import type { TuiState, TuiAction, FeedItem, NavigationMode } from "./types";

/**
 * Create initial TUI state
 */
export function createInitialState(): TuiState {
  return {
    mode: "normal",
    feedItems: [],
    highlightedItemId: null,
    npcListIndex: 0,
    selectedNpcId: null,
    npcDetailTab: "description",
    pendingToolCalls: {},
  };
}

/**
 * State reducer for TUI actions
 */
export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "ADD_FEED_ITEM":
      return {
        ...state,
        feedItems: [...state.feedItems, action.item],
      };

    case "UPDATE_FEED_ITEM": {
      const index = state.feedItems.findIndex((item) => item.id === action.id);
      if (index === -1) return state;
      const newItems = [...state.feedItems];
      newItems[index] = { ...newItems[index], ...action.updates };
      return { ...state, feedItems: newItems };
    }

    case "SET_MODE":
      return { ...state, mode: action.mode };

    case "HIGHLIGHT_ITEM": {
      // Clear previous highlight and set new one
      const newItems = state.feedItems.map((item) => ({
        ...item,
        highlighted: item.id === action.id,
      }));
      return {
        ...state,
        feedItems: newItems,
        highlightedItemId: action.id,
      };
    }

    case "TOGGLE_COLLAPSED": {
      const index = state.feedItems.findIndex((item) => item.id === action.id);
      if (index === -1) return state;
      const newItems = [...state.feedItems];
      newItems[index] = { ...newItems[index], collapsed: !newItems[index].collapsed };
      return { ...state, feedItems: newItems };
    }

    case "SET_NPC_LIST_INDEX":
      return { ...state, npcListIndex: action.index };

    case "SET_SELECTED_NPC":
      return { ...state, selectedNpcId: action.id };

    case "SET_NPC_DETAIL_TAB":
      return { ...state, npcDetailTab: action.tab };

    case "NAVIGATE_FEED": {
      const navigableItems = state.feedItems.filter(isNavigable);
      if (navigableItems.length === 0) return state;

      const currentIndex = state.highlightedItemId
        ? navigableItems.findIndex((item) => item.id === state.highlightedItemId)
        : -1;

      let newIndex: number;
      if (action.direction === "down") {
        newIndex = currentIndex < navigableItems.length - 1 ? currentIndex + 1 : 0;
      } else {
        newIndex = currentIndex > 0 ? currentIndex - 1 : navigableItems.length - 1;
      }

      const newHighlightedId = navigableItems[newIndex]?.id ?? null;
      const newItems = state.feedItems.map((item) => ({
        ...item,
        highlighted: item.id === newHighlightedId,
      }));

      return {
        ...state,
        feedItems: newItems,
        highlightedItemId: newHighlightedId,
      };
    }

    case "ADD_PENDING_TOOL":
      return {
        ...state,
        pendingToolCalls: {
          ...state.pendingToolCalls,
          [action.id]: {
            name: action.name,
            args: action.args,
            startTime: Date.now(),
          },
        },
      };

    case "RESOLVE_PENDING_TOOL": {
      const { [action.id]: removed, ...remaining } = state.pendingToolCalls;
      // Find and update the corresponding feed item
      const newItems = state.feedItems.map((item) => {
        if (item.id === action.id) {
          return {
            ...item,
            toolResult: action.result,
            elapsedMs: action.elapsedMs,
          };
        }
        return item;
      });
      return {
        ...state,
        feedItems: newItems,
        pendingToolCalls: remaining,
      };
    }

    case "CLEAR_FEED":
      return {
        ...state,
        feedItems: [],
        highlightedItemId: null,
        pendingToolCalls: {},
      };

    default:
      return state;
  }
}

/**
 * Check if a feed item is navigable (can be highlighted/selected)
 */
export function isNavigable(item: FeedItem): boolean {
  // All items except scene_header are navigable
  return item.type !== "scene_header";
}

/**
 * Get the currently highlighted item
 */
export function getHighlightedItem(state: TuiState): FeedItem | undefined {
  return state.feedItems.find((item) => item.id === state.highlightedItemId);
}

/**
 * Get NPCs from the most recent npc_list feed item
 */
export function getCurrentNpcs(state: TuiState): FeedItem | undefined {
  // Find most recent npc_list item
  for (let i = state.feedItems.length - 1; i >= 0; i--) {
    if (state.feedItems[i].type === "npc_list") {
      return state.feedItems[i];
    }
  }
  return undefined;
}

/**
 * Get the NPC at the current list index
 */
export function getSelectedNpc(state: TuiState): { id: string; name: string; summary: string; tags: string[]; detailsMd?: string; payload?: Record<string, any> } | undefined {
  const npcListItem = getCurrentNpcs(state);
  if (!npcListItem?.npcs || state.npcListIndex >= npcListItem.npcs.length) {
    return undefined;
  }
  return npcListItem.npcs[state.npcListIndex];
}
