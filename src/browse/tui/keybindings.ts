/**
 * Keybinding handler for azbrowse TUI
 *
 * Mode-aware key handling for normal, command, and modal modes.
 */

import type { TuiState, TuiAction, KeypressResult, InputMode } from "./types";
import { getSelectedNode } from "./state";
import { nodeIdToRef } from "./tree";

// Special key codes
const ESCAPE = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const DELETE = "\x08";
const TAB = "\t";

// Control keys
const CTRL_C = "\x03";
const CTRL_D = "\x04";

// Arrow keys (escape sequences)
const UP_ARROW = "\x1b[A";
const DOWN_ARROW = "\x1b[B";
const RIGHT_ARROW = "\x1b[C";
const LEFT_ARROW = "\x1b[D";

// Page keys
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

/**
 * Parse raw key buffer into a key string
 */
export function parseKeyBuffer(buffer: Buffer): string {
  const str = buffer.toString();

  // Check for escape sequences (arrow keys, etc.)
  if (str.length >= 3 && str.startsWith("\x1b[")) {
    if (str[2] === "A") return UP_ARROW;
    if (str[2] === "B") return DOWN_ARROW;
    if (str[2] === "C") return RIGHT_ARROW;
    if (str[2] === "D") return LEFT_ARROW;
    if (str[2] === "5" && str[3] === "~") return PAGE_UP;
    if (str[2] === "6" && str[3] === "~") return PAGE_DOWN;
    if (str[2] === "H") return HOME;
    if (str[2] === "F") return END;
  }

  // Plain escape key
  if (str.length === 1 && str === ESCAPE) {
    return ESCAPE;
  }

  // Return first character for simple keys
  return str[0] || "";
}

/**
 * Handle keypress and return actions to dispatch
 */
export function handleKeypress(key: string, state: TuiState): KeypressResult {
  switch (state.mode) {
    case "normal":
      return handleNormalMode(key, state);
    case "command":
      return handleCommandMode(key, state);
    case "modal":
      return handleModalMode(key, state);
    case "search":
      return handleSearchMode(key, state);
    default:
      return { actions: [] };
  }
}

/**
 * Handle keys in normal (navigation) mode
 */
function handleNormalMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];
  let callback: KeypressResult["callback"] = null;
  let entityRef = undefined;

  // Quit
  if (key === "q" || key === CTRL_C || key === CTRL_D) {
    return { actions: [], callback: "quit" };
  }

  // Enter command mode
  if (key === ":") {
    actions.push({ type: "SET_MODE", mode: "command" });
    return { actions };
  }

  // Enter search mode
  if (key === "/") {
    actions.push({ type: "OPEN_SEARCH" });
    return { actions };
  }

  // Navigation in tree
  if (state.focus === "tree") {
    switch (key) {
      case "j":
      case DOWN_ARROW:
        actions.push({ type: "MOVE_SELECTION", direction: "down" });
        // Also sync browse state to new selection
        callback = "sync_browse_state";
        break;

      case "k":
      case UP_ARROW:
        actions.push({ type: "MOVE_SELECTION", direction: "up" });
        // Also sync browse state to new selection
        callback = "sync_browse_state";
        break;

      case "l":
      case RIGHT_ARROW: {
        // Expand node or move to detail panel
        const selected = getSelectedNode(state);
        if (selected) {
          if (selected.hasChildren && !selected.expanded) {
            actions.push({ type: "EXPAND_NODE", id: selected.id });
          } else {
            actions.push({ type: "SET_FOCUS", focus: "detail" });
          }
        }
        break;
      }

      case "h":
      case LEFT_ARROW: {
        // Collapse node or go to parent
        const selected = getSelectedNode(state);
        if (selected) {
          if (selected.expanded) {
            actions.push({ type: "COLLAPSE_NODE", id: selected.id });
          } else if (selected.depth > 0) {
            // Find parent node and select it
            const parentDepth = selected.depth - 1;
            for (let i = state.treeNodes.indexOf(selected) - 1; i >= 0; i--) {
              if (state.treeNodes[i].depth === parentDepth) {
                actions.push({ type: "SELECT_NODE", id: state.treeNodes[i].id });
                break;
              }
            }
          }
        }
        break;
      }

      case ENTER: {
        // Toggle expand/collapse
        const selected = getSelectedNode(state);
        if (selected) {
          if (selected.hasChildren) {
            actions.push({ type: "TOGGLE_NODE", id: selected.id });
          } else {
            // Navigate to entity
            entityRef = nodeIdToRef(selected.id);
            callback = "navigate_to_entity";
          }
        }
        break;
      }

      case "g": {
        // Go to top
        if (state.treeNodes.length > 0) {
          actions.push({ type: "SELECT_NODE", id: state.treeNodes[0].id });
          actions.push({ type: "SET_TREE_SCROLL", offset: 0 });
        }
        break;
      }

      case "G": {
        // Go to bottom
        if (state.treeNodes.length > 0) {
          const lastNode = state.treeNodes[state.treeNodes.length - 1];
          actions.push({ type: "SELECT_NODE", id: lastNode.id });
        }
        break;
      }

      case PAGE_DOWN: {
        const pageSize = Math.floor((state.terminalRows - 4) / 2);
        for (let i = 0; i < pageSize; i++) {
          actions.push({ type: "MOVE_SELECTION", direction: "down" });
        }
        break;
      }

      case PAGE_UP: {
        const pageSize = Math.floor((state.terminalRows - 4) / 2);
        for (let i = 0; i < pageSize; i++) {
          actions.push({ type: "MOVE_SELECTION", direction: "up" });
        }
        break;
      }
    }
  } else if (state.focus === "detail") {
    // Navigation in detail panel with collapsible sections
    switch (key) {
      case "h":
      case LEFT_ARROW:
        actions.push({ type: "SET_FOCUS", focus: "tree" });
        break;

      case "j":
      case DOWN_ARROW:
        // Move to next section
        actions.push({ type: "MOVE_DETAIL_SECTION", direction: "down" });
        break;

      case "k":
      case UP_ARROW:
        // Move to previous section
        actions.push({ type: "MOVE_DETAIL_SECTION", direction: "up" });
        break;

      case " ":  // Space
      case ENTER:
        // Toggle collapse of current section
        callback = "toggle_current_section";
        break;

      case PAGE_DOWN:
        actions.push({ type: "SCROLL_DETAIL", direction: "down", amount: 10 });
        break;

      case PAGE_UP:
        actions.push({ type: "SCROLL_DETAIL", direction: "up", amount: 10 });
        break;

      case "g":
        actions.push({ type: "SET_DETAIL_SCROLL", offset: 0 });
        actions.push({ type: "RESET_DETAIL_SECTIONS" }); // Also reset section index
        break;

      case "G":
        actions.push({ type: "SET_DETAIL_SCROLL", offset: 9999 }); // Will be clamped
        break;
    }
  }

  // Tab switches focus
  if (key === TAB) {
    actions.push({
      type: "SET_FOCUS",
      focus: state.focus === "tree" ? "detail" : "tree",
    });
  }

  // Number keys for direct panel focus
  if (key === "1") {
    actions.push({ type: "SET_FOCUS", focus: "tree" });
  }
  if (key === "2") {
    actions.push({ type: "SET_FOCUS", focus: "detail" });
  }

  return { actions, callback, entityRef };
}

/**
 * Handle keys in command mode (typing after ':')
 */
function handleCommandMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  // Escape - cancel command
  if (key === ESCAPE) {
    actions.push({ type: "CLEAR_COMMAND" });
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions };
  }

  // Enter - execute command
  if (key === ENTER) {
    if (state.commandBuffer.trim()) {
      actions.push({ type: "ADD_TO_HISTORY", command: state.commandBuffer });
    }
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions, callback: "execute_command" };
  }

  // Backspace
  if (key === BACKSPACE || key === DELETE) {
    if (state.commandBuffer.length === 0) {
      // Exit command mode if buffer is empty
      actions.push({ type: "SET_MODE", mode: "normal" });
    } else {
      actions.push({ type: "BACKSPACE_COMMAND" });
    }
    return { actions };
  }

  // History navigation (up/down)
  if (key === UP_ARROW) {
    actions.push({ type: "HISTORY_UP" });
    return { actions };
  }
  if (key === DOWN_ARROW) {
    actions.push({ type: "HISTORY_DOWN" });
    return { actions };
  }

  // Cursor movement (left/right)
  if (key === LEFT_ARROW) {
    actions.push({ type: "MOVE_CURSOR", direction: "left" });
    return { actions };
  }
  if (key === RIGHT_ARROW) {
    actions.push({ type: "MOVE_CURSOR", direction: "right" });
    return { actions };
  }

  // Home/End for cursor
  if (key === HOME) {
    actions.push({ type: "MOVE_CURSOR_TO", position: "start" });
    return { actions };
  }
  if (key === END) {
    actions.push({ type: "MOVE_CURSOR_TO", position: "end" });
    return { actions };
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CLEAR_COMMAND" });
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions };
  }

  // Regular character - insert at cursor position
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    actions.push({ type: "INSERT_COMMAND", char: key });
  }

  return { actions };
}

/**
 * Handle keys in modal mode
 */
function handleModalMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  if (!state.modal) {
    // No modal, return to normal
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions };
  }

  // Escape - close modal
  if (key === ESCAPE) {
    actions.push({ type: "CLOSE_MODAL" });
    return { actions };
  }

  // Handle approval modal (has choices but not complete)
  if (state.modal.approvalChoices?.length && !state.modal.isComplete) {
    switch (key) {
      case "j":
      case DOWN_ARROW:
        actions.push({ type: "APPROVAL_SELECT", direction: "down" });
        break;

      case "k":
      case UP_ARROW:
        actions.push({ type: "APPROVAL_SELECT", direction: "up" });
        break;

      case ENTER: {
        // Get selected approval choice
        const selectedIdx = state.modal.approvalSelectedIndex ?? 0;
        const choice = state.modal.approvalChoices[selectedIdx];
        if (choice) {
          if (choice.value === "cancel") {
            actions.push({ type: "CLOSE_MODAL" });
          } else if (choice.value === "create") {
            // Return callback to execute generation
            return { actions, callback: "execute_approved_generation" };
          } else if (choice.value === "apply") {
            // Return callback to execute modification
            return { actions, callback: "execute_approved_modification" };
          }
        }
        break;
      }
    }
    return { actions };
  }

  // If modal is complete, allow navigation
  if (state.modal.isComplete && state.modal.createdEntities.length > 0) {
    switch (key) {
      case "j":
      case DOWN_ARROW:
        actions.push({ type: "MODAL_SELECT", direction: "down" });
        break;

      case "k":
      case UP_ARROW:
        actions.push({ type: "MODAL_SELECT", direction: "up" });
        break;

      case ENTER: {
        // Navigate to selected entity
        const entity = state.modal.createdEntities[state.modal.selectedIndex];
        if (entity) {
          actions.push({ type: "CLOSE_MODAL" });
          // Return callback to navigate
          return {
            actions,
            callback: "navigate_to_entity",
            entityRef: { kind: entity.kind as any, [`${entity.kind}Id`]: entity.id },
          };
        }
        break;
      }
    }
  }

  return { actions };
}

/**
 * Handle keys in search mode
 */
function handleSearchMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  // Escape - close search
  if (key === ESCAPE) {
    actions.push({ type: "CLOSE_SEARCH" });
    return { actions };
  }

  // Enter - navigate to selected result
  if (key === ENTER) {
    if (state.search?.results.length) {
      return { actions, callback: "navigate_to_search_result" };
    }
    actions.push({ type: "CLOSE_SEARCH" });
    return { actions };
  }

  // Backspace
  if (key === BACKSPACE || key === DELETE) {
    if (state.search?.query.length === 0) {
      actions.push({ type: "CLOSE_SEARCH" });
    } else {
      actions.push({ type: "BACKSPACE_SEARCH" });
    }
    return { actions };
  }

  // Navigation in results (j/k or arrows)
  if (key === "j" || key === DOWN_ARROW) {
    actions.push({ type: "SEARCH_SELECT", direction: "down" });
    return { actions };
  }
  if (key === "k" || key === UP_ARROW) {
    actions.push({ type: "SEARCH_SELECT", direction: "up" });
    return { actions };
  }

  // Page navigation
  if (key === PAGE_DOWN) {
    for (let i = 0; i < 5; i++) {
      actions.push({ type: "SEARCH_SELECT", direction: "down" });
    }
    return { actions };
  }
  if (key === PAGE_UP) {
    for (let i = 0; i < 5; i++) {
      actions.push({ type: "SEARCH_SELECT", direction: "up" });
    }
    return { actions };
  }

  // Cursor movement
  if (key === LEFT_ARROW) {
    actions.push({ type: "MOVE_SEARCH_CURSOR", direction: "left" });
    return { actions };
  }
  if (key === RIGHT_ARROW) {
    actions.push({ type: "MOVE_SEARCH_CURSOR", direction: "right" });
    return { actions };
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CLOSE_SEARCH" });
    return { actions };
  }

  // Regular character - insert into query
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    actions.push({ type: "INSERT_SEARCH_CHAR", char: key });
  }

  return { actions };
}

/**
 * Check if we're in a mode that captures all input
 */
export function isInputCaptured(state: TuiState): boolean {
  return state.mode === "command" || state.mode === "modal" || state.mode === "search";
}

/**
 * Get help text for current mode
 */
export function getModeHelpText(mode: InputMode, focus: string): string {
  switch (mode) {
    case "normal":
      if (focus === "tree") {
        return "j/k: move  Enter: expand/select  l: expand/→  h: collapse/←  /: search  :: command  q: quit";
      } else {
        return "j/k: section  Space: toggle  h: ← tree  /: search  :: command  q: quit";
      }
    case "command":
      return "Enter: execute  Esc: cancel  ←/→: cursor  ↑/↓: history";
    case "modal":
      return "j/k: select  Enter: confirm  Esc: close";
    case "search":
      return "Type to search  j/k: select  Enter: go  Esc: close";
    default:
      return "";
  }
}
