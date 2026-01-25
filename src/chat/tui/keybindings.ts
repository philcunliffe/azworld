import type { TuiState, NavigationMode, NpcDetailTab, TuiAction } from "./types";
import { getCurrentNpcs, getSelectedNpc } from "./state";

// Special key codes
const ESCAPE = "\x1b";
const CTRL_N = "\x0e";
const ENTER = "\r";
const TAB = "\t";

// Arrow keys (escape sequences)
const UP_ARROW = "\x1b[A";
const DOWN_ARROW = "\x1b[B";

/**
 * Result of handling a keypress
 */
export type KeypressResult = {
  actions: TuiAction[];
  callback?: "talk" | "copy" | "exit_nav" | null;
  npcId?: string;
  copyText?: string;
};

/**
 * Parse key sequence and return actions to dispatch
 */
export function handleKeypress(
  key: string,
  state: TuiState
): KeypressResult {
  const actions: TuiAction[] = [];
  let callback: KeypressResult["callback"] = null;
  let npcId: string | undefined;
  let copyText: string | undefined;

  switch (state.mode) {
    case "normal":
      // In normal mode, only Ctrl+N enters navigation
      if (key === CTRL_N || key === "n") {
        actions.push({ type: "SET_MODE", mode: "feed_nav" });
        // Auto-highlight last item when entering nav mode
        const lastItem = state.feedItems[state.feedItems.length - 1];
        if (lastItem) {
          actions.push({ type: "HIGHLIGHT_ITEM", id: lastItem.id });
        }
      }
      break;

    case "feed_nav":
      if (key === "j" || key === DOWN_ARROW) {
        actions.push({ type: "NAVIGATE_FEED", direction: "down" });
      } else if (key === "k" || key === UP_ARROW) {
        actions.push({ type: "NAVIGATE_FEED", direction: "up" });
      } else if (key === ENTER) {
        // Expand/select highlighted item
        const highlighted = state.feedItems.find((i) => i.highlighted);
        if (highlighted) {
          if (highlighted.type === "tool_call") {
            // Toggle expanded state
            actions.push({ type: "TOGGLE_COLLAPSED", id: highlighted.id });
            if (highlighted.collapsed) {
              actions.push({ type: "SET_MODE", mode: "expanded_item" });
            }
          } else if (highlighted.type === "npc_list") {
            actions.push({ type: "TOGGLE_COLLAPSED", id: highlighted.id });
            actions.push({ type: "SET_NPC_LIST_INDEX", index: 0 });
            actions.push({ type: "SET_MODE", mode: "npc_list" });
          } else if (highlighted.text) {
            // Copy text content
            copyText = highlighted.text;
            callback = "copy";
          }
        }
      } else if (key === ESCAPE || key === "q") {
        actions.push({ type: "SET_MODE", mode: "normal" });
        actions.push({ type: "HIGHLIGHT_ITEM", id: null });
        callback = "exit_nav";
      } else if (key === "c") {
        // Copy highlighted item
        const highlighted = state.feedItems.find((i) => i.highlighted);
        if (highlighted?.text) {
          copyText = highlighted.text;
          callback = "copy";
        }
      }
      break;

    case "npc_list": {
      const npcItem = getCurrentNpcs(state);
      const npcCount = npcItem?.npcs?.length ?? 0;

      if (key === "j" || key === DOWN_ARROW) {
        const newIndex = (state.npcListIndex + 1) % npcCount;
        actions.push({ type: "SET_NPC_LIST_INDEX", index: newIndex });
      } else if (key === "k" || key === UP_ARROW) {
        const newIndex = (state.npcListIndex - 1 + npcCount) % npcCount;
        actions.push({ type: "SET_NPC_LIST_INDEX", index: newIndex });
      } else if (key === ENTER) {
        // Open NPC detail
        const npc = getSelectedNpc(state);
        if (npc) {
          actions.push({ type: "SET_SELECTED_NPC", id: npc.id });
          actions.push({ type: "SET_NPC_DETAIL_TAB", tab: "description" });
          actions.push({ type: "SET_MODE", mode: "npc_detail" });
        }
      } else if (key === ESCAPE) {
        // Back to feed nav
        actions.push({ type: "SET_MODE", mode: "feed_nav" });
      } else if (key === "t") {
        // Quick talk to selected NPC
        const npc = getSelectedNpc(state);
        if (npc) {
          npcId = npc.id;
          callback = "talk";
          actions.push({ type: "SET_MODE", mode: "normal" });
        }
      }
      break;
    }

    case "npc_detail": {
      if (key === TAB) {
        // Cycle through tabs
        const tabs: NpcDetailTab[] = ["description", "dm_info", "talk"];
        const currentIndex = tabs.indexOf(state.npcDetailTab);
        const nextIndex = (currentIndex + 1) % tabs.length;
        actions.push({ type: "SET_NPC_DETAIL_TAB", tab: tabs[nextIndex] });
      } else if (key === "t") {
        // Start talking to NPC
        if (state.selectedNpcId) {
          npcId = state.selectedNpcId;
          callback = "talk";
          actions.push({ type: "SET_MODE", mode: "normal" });
        }
      } else if (key === "c") {
        // Copy NPC info
        const npc = getSelectedNpc(state);
        if (npc) {
          const info = [
            `Name: ${npc.name}`,
            `Summary: ${npc.summary}`,
            npc.detailsMd ? `\nDescription:\n${npc.detailsMd}` : "",
            npc.tags.length ? `\nTags: ${npc.tags.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          copyText = info;
          callback = "copy";
        }
      } else if (key === ESCAPE) {
        // Back to NPC list
        actions.push({ type: "SET_SELECTED_NPC", id: null });
        actions.push({ type: "SET_MODE", mode: "npc_list" });
      }
      break;
    }

    case "expanded_item": {
      if (key === "c") {
        // Copy expanded content
        const highlighted = state.feedItems.find((i) => i.id === state.highlightedItemId);
        if (highlighted) {
          if (highlighted.type === "tool_call") {
            const content: any = {
              tool: highlighted.toolName,
              args: highlighted.toolArgs,
            };
            if (highlighted.toolResult !== undefined) {
              content.result = highlighted.toolResult;
            }
            copyText = JSON.stringify(content, null, 2);
          } else if (highlighted.text) {
            copyText = highlighted.text;
          }
          callback = "copy";
        }
      } else if (key === ESCAPE) {
        // Back to feed nav, collapse the item
        actions.push({ type: "TOGGLE_COLLAPSED", id: state.highlightedItemId! });
        actions.push({ type: "SET_MODE", mode: "feed_nav" });
      }
      break;
    }
  }

  return { actions, callback, npcId, copyText };
}

/**
 * Check if we should intercept input (navigation mode active)
 */
export function isNavigationActive(state: TuiState): boolean {
  return state.mode !== "normal";
}

/**
 * Get the raw keypress from buffer
 * Handles escape sequences for arrow keys
 */
export function parseKeyBuffer(buffer: Buffer): string {
  const str = buffer.toString();

  // Check for escape sequences (arrow keys are ESC [ A/B/C/D)
  if (str.length >= 3 && str.startsWith("\x1b[")) {
    if (str[2] === "A") return UP_ARROW;
    if (str[2] === "B") return DOWN_ARROW;
    // Left/Right arrows if needed
    if (str[2] === "C") return "\x1b[C";  // Right
    if (str[2] === "D") return "\x1b[D";  // Left
  }

  // Plain escape key (single byte 0x1b)
  if (str.length === 1 && str === ESCAPE) {
    return ESCAPE;
  }

  // ESC followed by other chars - treat as escape
  if (str.startsWith(ESCAPE) && str.length >= 1) {
    // Could be a partial escape sequence, treat as escape
    return ESCAPE;
  }

  // Return first character for simple keys
  return str[0] || "";
}
