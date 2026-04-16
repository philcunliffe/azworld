/**
 * Keybinding handler for azbrowse TUI
 *
 * Mode-aware key handling for normal, command, and modal modes.
 */

import type { TuiState, TuiAction, KeypressResult, InputMode, EntityEditField } from "./types";
import { getSelectedNode, isTextInputStep, isMultiCheckboxStep } from "./state";
import { nodeIdToRef } from "./tree";
import type { EntityPlan } from "../gen-agent";

// Special key codes
const ESCAPE = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const DELETE = "\x08";
const TAB = "\t";

// Control keys
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_E = "\x05";
const CTRL_S = "\x13";

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
    case "onboarding":
      return handleOnboardingMode(key, state);
    case "help":
      return handleHelpMode(key, state);
    case "fieldSelection":
      return handleFieldSelectionMode(key, state);
    case "entityEdit":
      return handleEntityEditMode(key, state);
    case "talk":
      return handleTalkMode(key, state);
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

  // Open help modal
  if (key === "?") {
    actions.push({ type: "OPEN_HELP" });
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

      case " ":  // Space - toggle expand/collapse only
      case ENTER: {
        // Toggle expand/collapse
        const selected = getSelectedNode(state);
        if (selected) {
          if (selected.hasChildren) {
            actions.push({ type: "TOGGLE_NODE", id: selected.id });
          } else if (key === ENTER) {
            // Navigate to entity (only on Enter, not Space)
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

      case "t": {
        // Enter talk mode with current NPC
        callback = "enter_talk_mode";
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
        // Navigation handled by callback - moves within links or between sections
        callback = "detail_move_down";
        break;

      case "k":
      case UP_ARROW:
        // Navigation handled by callback - moves within links or between sections
        callback = "detail_move_up";
        break;

      case " ":  // Space
        // Toggle collapse of current section
        callback = "toggle_current_section";
        break;

      case ENTER:
        // Navigate to selected link if in a links section, otherwise toggle
        callback = "navigate_to_detail_link";
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

  // Number keys for tab switching (1-4)
  if (key === "1") {
    actions.push({ type: "SET_TAB", tab: "world" });
    callback = "rebuild_tree_for_tab";
  }
  if (key === "2") {
    actions.push({ type: "SET_TAB", tab: "factions" });
    callback = "rebuild_tree_for_tab";
  }
  if (key === "3") {
    actions.push({ type: "SET_TAB", tab: "religions" });
    callback = "rebuild_tree_for_tab";
  }
  if (key === "4") {
    actions.push({ type: "SET_TAB", tab: "cultures" });
    callback = "rebuild_tree_for_tab";
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
    const hasEntities = state.modal.pendingEntities && state.modal.pendingEntities.length > 0;

    // Entity selection with j/k when we have editable entities
    if (hasEntities) {
      if (key === "j" || key === DOWN_ARROW) {
        actions.push({ type: "SELECT_ENTITY", direction: "down" });
        return { actions };
      }
      if (key === "k" || key === UP_ARROW) {
        actions.push({ type: "SELECT_ENTITY", direction: "up" });
        return { actions };
      }

      // Entity field editing
      // 'n' - edit name
      if (key === "n") {
        actions.push({ type: "START_ENTITY_EDIT", field: "name" });
        return { actions };
      }

      // 'r' - edit reason
      if (key === "r") {
        actions.push({ type: "START_ENTITY_EDIT", field: "reason" });
        return { actions };
      }

      // 'p' - edit custom prompt
      if (key === "p") {
        actions.push({ type: "START_ENTITY_EDIT", field: "customPrompt" });
        return { actions };
      }

      // 'e' - edit in $EDITOR
      if (key === "e") {
        return { actions, callback: "open_plan_in_editor" };
      }
    } else {
      // No entities - fall back to plan text scrolling
      if (key === "j" || key === DOWN_ARROW) {
        actions.push({ type: "SCROLL_PLAN", direction: "down" });
        return { actions };
      }
      if (key === "k" || key === UP_ARROW) {
        actions.push({ type: "SCROLL_PLAN", direction: "up" });
        return { actions };
      }
    }

    // Ctrl+J/K for plan scrolling (always available)
    if (key === "\n") {  // Ctrl+J
      actions.push({ type: "SCROLL_PLAN", direction: "down" });
      return { actions };
    }
    if (key === "\x0b") {  // Ctrl+K
      actions.push({ type: "SCROLL_PLAN", direction: "up" });
      return { actions };
    }

    // Page scrolling for plan text
    if (key === PAGE_DOWN) {
      actions.push({ type: "SCROLL_PLAN_PAGE", direction: "down" });
      return { actions };
    }
    if (key === PAGE_UP) {
      actions.push({ type: "SCROLL_PLAN_PAGE", direction: "up" });
      return { actions };
    }

    // Jump to top/bottom for plan text
    if (key === "g") {
      // Scroll to top
      for (let i = 0; i < (state.modal.planScrollOffset ?? 0) + 1; i++) {
        actions.push({ type: "SCROLL_PLAN", direction: "up" });
      }
      return { actions };
    }
    if (key === "G") {
      // Scroll down a lot (will be clamped)
      for (let i = 0; i < 100; i++) {
        actions.push({ type: "SCROLL_PLAN", direction: "down" });
      }
      return { actions };
    }

    // Enter = approve (find the non-cancel choice)
    if (key === ENTER) {
      const choice = state.modal.approvalChoices.find(c => c.value !== "cancel");
      if (choice) {
        if (choice.value === "create") {
          return { actions, callback: "execute_approved_generation" };
        } else if (choice.value === "apply") {
          return { actions, callback: "execute_approved_modification" };
        } else if (choice.value === "simulate") {
          return { actions, callback: "execute_approved_simulation" };
        } else if (choice.value === "generate") {
          // Check modal title to distinguish between world gen and description gen
          if (state.modal.title?.includes("Description")) {
            return { actions, callback: "execute_approved_description_generation" };
          }
          return { actions, callback: "execute_approved_world_generation" };
        } else if (choice.value === "regenerate") {
          return { actions, callback: "execute_field_regeneration" };
        }
      }
      return { actions };
    }

    // Escape already handled above - closes modal
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
 * Handle keys in onboarding mode
 */
function handleOnboardingMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  if (!state.onboarding) {
    // No onboarding state, return to normal
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions };
  }

  const step = state.onboarding.currentStep;
  const isTextStep = isTextInputStep(step);
  const isCheckboxStep = isMultiCheckboxStep(step);
  const isConfirmStep = step === "confirm";

  // Escape - close onboarding
  if (key === ESCAPE) {
    actions.push({ type: "CLOSE_ONBOARDING" });
    return { actions };
  }

  // Tab - skip to next step (except on confirm)
  if (key === TAB && !isConfirmStep) {
    actions.push({ type: "ONBOARDING_NEXT_STEP" });
    return { actions };
  }

  // Space - toggle checkbox in multi-checkbox steps
  if (key === " " && isCheckboxStep) {
    actions.push({ type: "TOGGLE_ONBOARDING_CHECKBOX" });
    return { actions };
  }

  // Enter - confirm current step
  if (key === ENTER) {
    if (isConfirmStep) {
      // On confirm step, check which option is selected
      const selectedIndex = state.onboarding.selectedIndex;
      if (selectedIndex === 0) {
        // "Save & Generate" - trigger callback
        return { actions, callback: "execute_onboarding" };
      } else if (selectedIndex === 1) {
        // "Save Only" - trigger callback (same handler will check generate flags)
        return { actions, callback: "execute_onboarding" };
      } else {
        // "Cancel"
        actions.push({ type: "CLOSE_ONBOARDING" });
        return { actions };
      }
    } else {
      // Regular step - confirm and move to next
      actions.push({ type: "ONBOARDING_CONFIRM_STEP" });
      return { actions };
    }
  }

  // Text input steps
  if (isTextStep) {
    // Backspace
    if (key === BACKSPACE || key === DELETE) {
      if (state.onboarding.inputBuffer.length === 0 && state.onboarding.currentStep !== "worldVibe") {
        // Go back if empty and not on first step
        actions.push({ type: "ONBOARDING_PREV_STEP" });
      } else {
        actions.push({ type: "BACKSPACE_ONBOARDING" });
      }
      return { actions };
    }

    // Cursor movement
    if (key === LEFT_ARROW) {
      actions.push({ type: "MOVE_ONBOARDING_CURSOR", direction: "left" });
      return { actions };
    }
    if (key === RIGHT_ARROW) {
      actions.push({ type: "MOVE_ONBOARDING_CURSOR", direction: "right" });
      return { actions };
    }

    // Regular character - insert
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      actions.push({ type: "INSERT_ONBOARDING_CHAR", char: key });
      return { actions };
    }
  } else {
    // Selection steps (including multi-checkbox steps)
    if (key === "j" || key === DOWN_ARROW) {
      actions.push({ type: "ONBOARDING_SELECT", direction: "down" });
      return { actions };
    }
    if (key === "k" || key === UP_ARROW) {
      actions.push({ type: "ONBOARDING_SELECT", direction: "up" });
      return { actions };
    }

    // Page scrolling for confirm step and stateSelection (long list)
    if (isConfirmStep || step === "stateSelection") {
      if (key === PAGE_DOWN) {
        actions.push({ type: "SCROLL_ONBOARDING_PAGE", direction: "down" });
        return { actions };
      }
      if (key === PAGE_UP) {
        actions.push({ type: "SCROLL_ONBOARDING_PAGE", direction: "up" });
        return { actions };
      }
    }

    // Backspace on selection steps goes back
    if (key === BACKSPACE || key === DELETE) {
      if (state.onboarding.currentStep !== "worldVibe") {
        actions.push({ type: "ONBOARDING_PREV_STEP" });
      }
      return { actions };
    }
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CLOSE_ONBOARDING" });
    return { actions };
  }

  return { actions };
}

/**
 * Handle keys in help mode
 */
function handleHelpMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  // Escape or q - close help
  if (key === ESCAPE || key === "q") {
    actions.push({ type: "CLOSE_HELP" });
    return { actions };
  }

  // Scroll by line
  if (key === "j" || key === DOWN_ARROW) {
    actions.push({ type: "SCROLL_HELP", direction: "down" });
    return { actions };
  }
  if (key === "k" || key === UP_ARROW) {
    actions.push({ type: "SCROLL_HELP", direction: "up" });
    return { actions };
  }

  // Scroll by page
  if (key === PAGE_DOWN) {
    actions.push({ type: "SCROLL_HELP_PAGE", direction: "down" });
    return { actions };
  }
  if (key === PAGE_UP) {
    actions.push({ type: "SCROLL_HELP_PAGE", direction: "up" });
    return { actions };
  }

  // Jump to top
  if (key === "g") {
    if (state.help) {
      // Set scroll to 0 via SCROLL_HELP actions (scroll up a lot)
      for (let i = 0; i < (state.help.scrollOffset + 1); i++) {
        actions.push({ type: "SCROLL_HELP", direction: "up" });
      }
    }
    return { actions };
  }

  // Jump to bottom
  if (key === "G") {
    if (state.help) {
      // Scroll down to the end
      for (let i = 0; i < state.help.contentLines.length; i++) {
        actions.push({ type: "SCROLL_HELP", direction: "down" });
      }
    }
    return { actions };
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CLOSE_HELP" });
    return { actions };
  }

  return { actions };
}

/**
 * Handle keys in field selection mode
 */
function handleFieldSelectionMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  if (!state.fieldSelection) {
    actions.push({ type: "SET_MODE", mode: "normal" });
    return { actions };
  }

  // Escape - close field selection
  if (key === ESCAPE) {
    actions.push({ type: "CLOSE_FIELD_SELECTION" });
    return { actions };
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CLOSE_FIELD_SELECTION" });
    return { actions };
  }

  // Navigation (j/k or arrows)
  if (key === "j" || key === DOWN_ARROW) {
    actions.push({ type: "FIELD_SELECTION_MOVE", direction: "down" });
    return { actions };
  }
  if (key === "k" || key === UP_ARROW) {
    actions.push({ type: "FIELD_SELECTION_MOVE", direction: "up" });
    return { actions };
  }

  // Space - toggle field selection
  if (key === " ") {
    actions.push({ type: "TOGGLE_FIELD_SELECTION" });
    return { actions };
  }

  // Enter - confirm selection
  if (key === ENTER) {
    // Only proceed if at least one field is selected
    if (state.fieldSelection.selectedFields.size > 0) {
      return { actions, callback: "confirm_field_selection" };
    }
    return { actions };
  }

  // Tab key - toggle between hint input and field list
  // (for now we stay in the field list, hint is always editable)

  // Backspace - delete from hint
  if (key === BACKSPACE || key === DELETE) {
    actions.push({ type: "BACKSPACE_FIELD_HINT" });
    return { actions };
  }

  // Arrow keys for hint cursor
  if (key === LEFT_ARROW) {
    actions.push({ type: "MOVE_FIELD_HINT_CURSOR", direction: "left" });
    return { actions };
  }
  if (key === RIGHT_ARROW) {
    actions.push({ type: "MOVE_FIELD_HINT_CURSOR", direction: "right" });
    return { actions };
  }

  // Regular character - insert into hint (only alphanumeric and common punctuation)
  // Skip j/k as they're for navigation
  if (key.length === 1 && key.charCodeAt(0) >= 32 && key !== "j" && key !== "k") {
    actions.push({ type: "INSERT_FIELD_HINT_CHAR", char: key });
    return { actions };
  }

  return { actions };
}

/**
 * Handle keys in entity edit mode (editing name/reason/customPrompt in approval modal)
 */
function handleEntityEditMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  if (!state.modal?.editingEntityField) {
    actions.push({ type: "SET_MODE", mode: "modal" });
    return { actions };
  }

  // Escape - cancel edit
  if (key === ESCAPE) {
    actions.push({ type: "CANCEL_ENTITY_EDIT" });
    return { actions };
  }

  // Ctrl+C - cancel
  if (key === CTRL_C) {
    actions.push({ type: "CANCEL_ENTITY_EDIT" });
    return { actions };
  }

  // Enter - save edit
  if (key === ENTER) {
    actions.push({ type: "SAVE_ENTITY_EDIT" });
    return { actions };
  }

  // Backspace
  if (key === BACKSPACE || key === DELETE) {
    actions.push({ type: "BACKSPACE_ENTITY_EDIT" });
    return { actions };
  }

  // Cursor movement
  if (key === LEFT_ARROW) {
    actions.push({ type: "MOVE_ENTITY_EDIT_CURSOR", direction: "left" });
    return { actions };
  }
  if (key === RIGHT_ARROW) {
    actions.push({ type: "MOVE_ENTITY_EDIT_CURSOR", direction: "right" });
    return { actions };
  }

  // Regular character - insert
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    actions.push({ type: "INSERT_ENTITY_EDIT_CHAR", char: key });
    return { actions };
  }

  return { actions };
}

/**
 * Handle keys in talk mode (NPC conversation)
 */
function handleTalkMode(key: string, state: TuiState): KeypressResult {
  const actions: TuiAction[] = [];

  // Escape - exit talk mode
  if (key === ESCAPE) {
    return { actions, callback: "exit_talk_mode" };
  }

  // Ctrl+C - exit talk mode
  if (key === CTRL_C) {
    return { actions, callback: "exit_talk_mode" };
  }

  // Enter - send message to NPC
  if (key === ENTER) {
    if (state.commandBuffer.trim()) {
      return { actions, callback: "send_talk_message" };
    }
    return { actions };
  }

  // Backspace
  if (key === BACKSPACE || key === DELETE) {
    actions.push({ type: "BACKSPACE_COMMAND" });
    return { actions };
  }

  // Cursor movement
  if (key === LEFT_ARROW) {
    actions.push({ type: "MOVE_CURSOR", direction: "left" });
    return { actions };
  }
  if (key === RIGHT_ARROW) {
    actions.push({ type: "MOVE_CURSOR", direction: "right" });
    return { actions };
  }

  // Home/End
  if (key === HOME) {
    actions.push({ type: "MOVE_CURSOR_TO", position: "start" });
    return { actions };
  }
  if (key === END) {
    actions.push({ type: "MOVE_CURSOR_TO", position: "end" });
    return { actions };
  }

  // Regular character - insert into message
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    actions.push({ type: "INSERT_COMMAND", char: key });
  }

  return { actions };
}

/**
 * Check if we're in a mode that captures all input
 */
export function isInputCaptured(state: TuiState): boolean {
  return state.mode === "command" || state.mode === "modal" || state.mode === "search" || state.mode === "onboarding" || state.mode === "help" || state.mode === "fieldSelection" || state.mode === "entityEdit" || state.mode === "talk";
}

/**
 * Get help text for current mode
 */
export function getModeHelpText(mode: InputMode, focus: string): string {
  switch (mode) {
    case "normal":
      if (focus === "tree") {
        return "j/k: move  t: talk  1-4: tabs  /: search  ?: help  :: command  q: quit";
      } else {
        return "j/k: section  Space: toggle  h: ← tree  /: search  ?: help  :: command  q: quit";
      }
    case "command":
      return "Enter: execute  Esc: cancel  ←/→: cursor  ↑/↓: history";
    case "modal":
      return "j/k: select  n/r/p: edit fields  e: $EDITOR  Enter: approve  Esc: close";
    case "search":
      return "Type to search  j/k: select  Enter: go  Esc: close";
    case "onboarding":
      return "Enter: confirm  Tab: skip  Esc: cancel";
    case "help":
      return "j/k: scroll  PgUp/PgDn: page  g/G: top/bottom  Esc/q: close";
    case "fieldSelection":
      return "j/k: move  Space: toggle  Enter: generate  Esc: cancel";
    case "entityEdit":
      return "Type to edit  Enter: save  Esc: cancel";
    case "talk":
      return "Type message  Enter: send  Esc: exit talk mode";
    default:
      return "";
  }
}
