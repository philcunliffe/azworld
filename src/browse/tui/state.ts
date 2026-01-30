/**
 * State management for azbrowse TUI
 *
 * Redux-like reducer pattern for deterministic state updates.
 */

import type { TuiState, TuiAction, TreeNode, ModalState, InputMode, FocusArea, ApprovalChoice, ModelInfo, TokenCounts, SearchResult, SearchState, OnboardingState, OnboardingStep, HelpState, TabId, FieldSelectionState, EntityEditField } from "./types";
import type { EntityPlan } from "../gen-agent";

/**
 * Create initial TUI state
 */
export function createInitialTuiState(): TuiState {
  return {
    mode: "normal",
    focus: "tree",

    // Tab state for left panel
    activeTab: "world",

    // Tree state
    treeNodes: [],
    selectedNodeId: null,
    treeScrollOffset: 0,
    expandedNodes: new Set<string>(),

    // Detail panel
    detailScrollOffset: 0,
    detailExpandedSections: new Set<string>(),  // Empty = all collapsed by default
    detailSectionIndex: 0,
    detailSectionCount: 0,
    detailLinkIndex: 0,  // Selected link within Links section

    // Command mode
    commandBuffer: "",
    commandCursorPos: 0,
    commandHistory: [],
    commandHistoryIndex: -1,

    // Modal
    modal: null,

    // Search modal
    search: null,

    // Onboarding modal
    onboarding: null,

    // Help modal
    help: null,

    // Field selection modal
    fieldSelection: null,

    // Terminal dimensions
    terminalRows: process.stdout.rows || 24,
    terminalCols: process.stdout.columns || 80,

    // Model info for footer display
    modelInfo: null,

    // Token tracking
    tokenCounts: {
      planner: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      generation: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    },
  };
}

/**
 * Create initial modal state
 */
function createInitialModal(title: string): ModalState {
  return {
    visible: true,
    title,
    isComplete: false,
    createdEntities: [],
    selectedIndex: 0,
  };
}

/**
 * Create initial onboarding state
 */
function createInitialOnboardingState(): OnboardingState {
  return {
    visible: true,
    currentStep: "worldVibe",
    settings: {},
    generate: {
      contentTypes: {
        religions: false,
        cultures: false,
        states: false,
      },
      scope: "world",
      selectedStateIds: [],
    },
    inputBuffer: "",
    inputCursorPos: 0,
    selectedIndex: 0,
    scrollOffset: 0,
    checkedIndices: new Set<number>(),
    stateList: [],
  };
}

/**
 * Get step configuration for onboarding
 */
const ONBOARDING_STEPS: OnboardingStep[] = [
  "worldVibe",
  "culturalTouchpoints",
  "campaignArc",
  "userNotes",
  "contentTone",
  "rating",
  "contentTypes",
  "scopeSelection",
  "stateSelection",
  "confirm",
];

/**
 * Check if an onboarding step is a text input step
 */
function isTextInputStep(step: OnboardingStep): boolean {
  return ["worldVibe", "culturalTouchpoints", "campaignArc", "userNotes"].includes(step);
}

/**
 * Check if an onboarding step is a multi-checkbox step
 */
function isMultiCheckboxStep(step: OnboardingStep): boolean {
  return ["contentTypes", "stateSelection"].includes(step);
}

/**
 * Get help content lines for the help modal
 */
export function getHelpContent(): string[] {
  return [
    "NAVIGATION",
    "  j / ↓      Move down in tree/list",
    "  k / ↑      Move up in tree/list",
    "  h / ←      Collapse node / go to parent / go to tree",
    "  l / →      Expand node / go to detail panel",
    "  g          Jump to top",
    "  G          Jump to bottom",
    "  PgUp/PgDn  Scroll by page",
    "  Tab        Switch focus between tree and detail",
    "  Space      Toggle expand/collapse",
    "  Enter      Toggle expand or navigate to entity",
    "",
    "TABS",
    "  1          World tab (hierarchical tree)",
    "  2          Factions tab (from canon)",
    "  3          Religions tab (from Azgaar)",
    "  4          Cultures tab (from Azgaar)",
    "",
    "COMMANDS",
    "  :          Enter command mode",
    "  /          Open search modal",
    "  ?          Open this help modal",
    "  t          Enter talk mode (when on NPC)",
    "  q          Quit",
    "",
    "COMMAND MODE",
    "  :help      Show this help",
    "  :loc NAME  Navigate to location",
    "  :state ID  Navigate to state",
    "  :npc NAME  Navigate to NPC",
    "  :ls        List children of current entity",
    "  :info      Show entity info",
    "  :search Q  Search for entities",
    "",
    "GENERATION",
    "  :gen location HINTS    Plan location generation",
    "  :gen npc HINTS         Plan NPC generation",
    "  :gen faction HINTS     Plan faction generation",
    "  :mod INSTRUCTIONS      Modify current entity",
    "",
    "TALK MODE",
    "  :talk NAME             Enter talk mode with NPC",
    "  :back                  Exit talk mode",
    "",
    "SETTINGS",
    "  :init                  Open campaign settings wizard",
    "  :tokens                Toggle token count display",
    "  :model                 Show all models (chat, gen, talk)",
    "  :talkmodel             Show/set talk model",
    "",
    "MODAL NAVIGATION",
    "  j / k      Select entity (in approval modal)",
    "  n          Edit entity name",
    "  r          Edit entity reason",
    "  p          Edit entity custom prompt",
    "  e          Edit entire plan in $EDITOR",
    "  Enter      Approve / Save edit",
    "  Esc        Cancel / Close modal",
    "  Ctrl+J/K   Scroll plan details",
    "  PgUp/PgDn  Scroll by page",
    "  g / G      Jump to top/bottom",
  ];
}

/**
 * Get selection options for a step
 */
function getStepOptions(step: OnboardingStep): string[] {
  switch (step) {
    case "contentTone":
      return ["1 - Gritty/Dark", "2 - Darker", "3 - Balanced", "4 - Lighter", "5 - Lighthearted"];
    case "rating":
      return ["pg", "teen", "mature", "explicit"];
    case "contentTypes":
      return ["Religions", "Cultures", "States + Leaders"];
    case "scopeSelection":
      return ["Entire World", "Select States"];
    // stateSelection options are dynamic - provided via stateList
    case "confirm":
      return ["Save & Generate", "Save Only", "Cancel"];
    default:
      return [];
  }
}

/**
 * Get next step index
 */
function getNextStepIndex(currentStep: OnboardingStep): number {
  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
  return Math.min(currentIndex + 1, ONBOARDING_STEPS.length - 1);
}

/**
 * Get previous step index
 */
function getPrevStepIndex(currentStep: OnboardingStep): number {
  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
  return Math.max(currentIndex - 1, 0);
}

/**
 * State reducer for TUI actions
 */
export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    // Mode changes
    case "SET_MODE":
      return {
        ...state,
        mode: action.mode,
        // Reset command buffer and cursor when entering command mode
        commandBuffer: action.mode === "command" ? "" : state.commandBuffer,
        commandCursorPos: action.mode === "command" ? 0 : state.commandCursorPos,
        commandHistoryIndex: -1,
      };

    case "SET_FOCUS":
      return { ...state, focus: action.focus };

    case "SET_TAB":
      // Reset scroll and selection when switching tabs
      return {
        ...state,
        activeTab: action.tab,
        treeScrollOffset: 0,
        // Keep selectedNodeId - it will be updated when tree is rebuilt
      };

    // Tree navigation
    case "SELECT_NODE":
      return {
        ...state,
        selectedNodeId: action.id,
        treeNodes: state.treeNodes.map((node) => ({
          ...node,
          isSelected: node.id === action.id,
        })),
      };

    case "MOVE_SELECTION": {
      const visibleNodes = state.treeNodes;
      if (visibleNodes.length === 0) return state;

      const currentIndex = state.selectedNodeId
        ? visibleNodes.findIndex((n) => n.id === state.selectedNodeId)
        : -1;

      let newIndex: number;
      if (action.direction === "down") {
        newIndex = currentIndex < visibleNodes.length - 1 ? currentIndex + 1 : 0;
      } else {
        newIndex = currentIndex > 0 ? currentIndex - 1 : visibleNodes.length - 1;
      }

      const newSelectedId = visibleNodes[newIndex]?.id ?? null;

      // Adjust scroll offset to keep selection visible
      const terminalHeight = state.terminalRows - 3; // Account for header/footer
      const treeHeight = Math.floor(terminalHeight);
      let newScrollOffset = state.treeScrollOffset;

      if (newIndex < newScrollOffset) {
        newScrollOffset = newIndex;
      } else if (newIndex >= newScrollOffset + treeHeight) {
        newScrollOffset = newIndex - treeHeight + 1;
      }

      return {
        ...state,
        selectedNodeId: newSelectedId,
        treeScrollOffset: newScrollOffset,
        treeNodes: visibleNodes.map((node) => ({
          ...node,
          isSelected: node.id === newSelectedId,
        })),
      };
    }

    case "EXPAND_NODE": {
      const newExpanded = new Set(state.expandedNodes);
      newExpanded.add(action.id);
      return {
        ...state,
        expandedNodes: newExpanded,
        treeNodes: state.treeNodes.map((node) =>
          node.id === action.id ? { ...node, expanded: true } : node
        ),
      };
    }

    case "COLLAPSE_NODE": {
      const newExpanded = new Set(state.expandedNodes);
      newExpanded.delete(action.id);
      return {
        ...state,
        expandedNodes: newExpanded,
        treeNodes: state.treeNodes.map((node) =>
          node.id === action.id ? { ...node, expanded: false } : node
        ),
      };
    }

    case "TOGGLE_NODE": {
      const node = state.treeNodes.find((n) => n.id === action.id);
      if (!node) return state;

      const newExpanded = new Set(state.expandedNodes);
      if (node.expanded) {
        newExpanded.delete(action.id);
      } else {
        newExpanded.add(action.id);
      }

      return {
        ...state,
        expandedNodes: newExpanded,
        treeNodes: state.treeNodes.map((n) =>
          n.id === action.id ? { ...n, expanded: !n.expanded } : n
        ),
      };
    }

    case "SET_TREE_NODES":
      return {
        ...state,
        treeNodes: action.nodes,
        // Preserve selection if it still exists
        selectedNodeId: action.nodes.some((n) => n.id === state.selectedNodeId)
          ? state.selectedNodeId
          : action.nodes[0]?.id ?? null,
      };

    case "UPDATE_NODE_CHILDREN": {
      // Find the node and update its children
      const nodeIndex = state.treeNodes.findIndex((n) => n.id === action.id);
      if (nodeIndex === -1) return state;

      const node = state.treeNodes[nodeIndex];
      const updatedNode = { ...node, children: action.children };

      // Insert children after the parent node
      const newNodes = [...state.treeNodes];
      newNodes[nodeIndex] = updatedNode;

      // If expanded, insert children into the flattened list
      if (node.expanded) {
        // Remove old children (nodes with higher depth that come after)
        let removeCount = 0;
        for (let i = nodeIndex + 1; i < newNodes.length; i++) {
          if (newNodes[i].depth > node.depth) {
            removeCount++;
          } else {
            break;
          }
        }
        newNodes.splice(nodeIndex + 1, removeCount, ...action.children);
      }

      return { ...state, treeNodes: newNodes };
    }

    case "SET_TREE_SCROLL":
      return { ...state, treeScrollOffset: Math.max(0, action.offset) };

    // Detail panel
    case "SET_DETAIL_SCROLL":
      return { ...state, detailScrollOffset: Math.max(0, action.offset) };

    case "SCROLL_DETAIL":
      return {
        ...state,
        detailScrollOffset: Math.max(
          0,
          state.detailScrollOffset + (action.direction === "down" ? action.amount : -action.amount)
        ),
      };

    case "TOGGLE_DETAIL_SECTION": {
      // Toggle between expanded/collapsed (sections are collapsed by default)
      const newExpanded = new Set(state.detailExpandedSections);
      if (newExpanded.has(action.sectionKey)) {
        newExpanded.delete(action.sectionKey);  // Collapse
      } else {
        newExpanded.add(action.sectionKey);  // Expand
      }
      return { ...state, detailExpandedSections: newExpanded };
    }

    case "MOVE_DETAIL_SECTION": {
      const maxIndex = Math.max(0, state.detailSectionCount - 1);
      let newIndex: number;
      if (action.direction === "down") {
        newIndex = state.detailSectionIndex < maxIndex ? state.detailSectionIndex + 1 : 0;
      } else {
        newIndex = state.detailSectionIndex > 0 ? state.detailSectionIndex - 1 : maxIndex;
      }
      return { ...state, detailSectionIndex: newIndex };
    }

    case "RESET_DETAIL_SECTIONS":
      return {
        ...state,
        detailExpandedSections: new Set<string>(),  // Reset to all collapsed
        detailSectionIndex: 0,
      };

    case "SET_DETAIL_SECTION_COUNT":
      return {
        ...state,
        detailSectionCount: action.count,
        // Clamp section index if it's now out of bounds
        detailSectionIndex: Math.min(state.detailSectionIndex, Math.max(0, action.count - 1)),
      };

    case "MOVE_DETAIL_LINK":
      // Move link selection within the current section (handled in callback with linkCount)
      return {
        ...state,
        detailLinkIndex: action.direction === "down"
          ? state.detailLinkIndex + 1
          : Math.max(0, state.detailLinkIndex - 1),
      };

    case "RESET_DETAIL_LINK_INDEX":
      return { ...state, detailLinkIndex: 0 };

    // Command mode
    case "SET_COMMAND_BUFFER":
      return { ...state, commandBuffer: action.text, commandCursorPos: action.text.length };

    case "APPEND_COMMAND":
      // Legacy: append at end (for compatibility)
      return {
        ...state,
        commandBuffer: state.commandBuffer + action.char,
        commandCursorPos: state.commandBuffer.length + 1,
      };

    case "INSERT_COMMAND": {
      // Insert at cursor position
      const before = state.commandBuffer.slice(0, state.commandCursorPos);
      const after = state.commandBuffer.slice(state.commandCursorPos);
      return {
        ...state,
        commandBuffer: before + action.char + after,
        commandCursorPos: state.commandCursorPos + 1,
      };
    }

    case "BACKSPACE_COMMAND":
      // Delete char before cursor
      if (state.commandCursorPos === 0) return state;
      return {
        ...state,
        commandBuffer:
          state.commandBuffer.slice(0, state.commandCursorPos - 1) +
          state.commandBuffer.slice(state.commandCursorPos),
        commandCursorPos: state.commandCursorPos - 1,
      };

    case "DELETE_COMMAND":
      // Delete char at cursor (like Delete key)
      if (state.commandCursorPos >= state.commandBuffer.length) return state;
      return {
        ...state,
        commandBuffer:
          state.commandBuffer.slice(0, state.commandCursorPos) +
          state.commandBuffer.slice(state.commandCursorPos + 1),
      };

    case "CLEAR_COMMAND":
      return { ...state, commandBuffer: "", commandCursorPos: 0, commandHistoryIndex: -1 };

    case "MOVE_CURSOR":
      if (action.direction === "left") {
        return {
          ...state,
          commandCursorPos: Math.max(0, state.commandCursorPos - 1),
        };
      } else {
        return {
          ...state,
          commandCursorPos: Math.min(state.commandBuffer.length, state.commandCursorPos + 1),
        };
      }

    case "MOVE_CURSOR_TO":
      return {
        ...state,
        commandCursorPos: action.position === "start" ? 0 : state.commandBuffer.length,
      };

    case "HISTORY_UP": {
      if (state.commandHistory.length === 0) return state;
      const newIndex =
        state.commandHistoryIndex < state.commandHistory.length - 1
          ? state.commandHistoryIndex + 1
          : state.commandHistoryIndex;
      const newBuffer = state.commandHistory[newIndex]?.command ?? state.commandBuffer;
      return {
        ...state,
        commandHistoryIndex: newIndex,
        commandBuffer: newBuffer,
        commandCursorPos: newBuffer.length,
      };
    }

    case "HISTORY_DOWN": {
      if (state.commandHistoryIndex <= 0) {
        return {
          ...state,
          commandHistoryIndex: -1,
          commandBuffer: "",
          commandCursorPos: 0,
        };
      }
      const newIndex = state.commandHistoryIndex - 1;
      const newBuffer = state.commandHistory[newIndex]?.command ?? "";
      return {
        ...state,
        commandHistoryIndex: newIndex,
        commandBuffer: newBuffer,
        commandCursorPos: newBuffer.length,
      };
    }

    case "ADD_TO_HISTORY":
      return {
        ...state,
        commandHistory: [
          { command: action.command, timestamp: Date.now() },
          ...state.commandHistory.slice(0, 99), // Keep last 100 commands
        ],
        commandHistoryIndex: -1,
      };

    // Modal
    case "SHOW_MODAL":
      return {
        ...state,
        mode: "modal",
        modal: createInitialModal(action.title),
      };

    case "UPDATE_MODAL_PROGRESS":
      return state.modal
        ? {
            ...state,
            modal: { ...state.modal, progress: action.progress },
          }
        : state;

    case "ADD_MODAL_ENTITY":
      return state.modal
        ? {
            ...state,
            modal: {
              ...state.modal,
              createdEntities: [...state.modal.createdEntities, action.entity],
            },
          }
        : state;

    case "COMPLETE_MODAL":
      return state.modal
        ? {
            ...state,
            modal: { ...state.modal, isComplete: true, progress: undefined },
          }
        : state;

    case "MODAL_ERROR":
      return state.modal
        ? {
            ...state,
            modal: { ...state.modal, isComplete: true, error: action.error },
          }
        : state;

    case "MODAL_SELECT": {
      if (!state.modal || state.modal.createdEntities.length === 0) return state;
      const count = state.modal.createdEntities.length;
      const newIndex =
        action.direction === "down"
          ? (state.modal.selectedIndex + 1) % count
          : (state.modal.selectedIndex - 1 + count) % count;
      return {
        ...state,
        modal: { ...state.modal, selectedIndex: newIndex },
      };
    }

    case "CLOSE_MODAL":
      return {
        ...state,
        mode: "normal",
        modal: null,
      };

    // Approval modal
    case "SHOW_APPROVAL_MODAL":
      return {
        ...state,
        mode: "modal",
        modal: {
          visible: true,
          title: action.title,
          isComplete: false,
          createdEntities: [],
          selectedIndex: 0,
          approvalChoices: action.choices,
          approvalSelectedIndex: 0,
          pendingPlanText: action.planText,
          planScrollOffset: 0,
          // Entity editing fields
          pendingEntities: action.entities ? [...action.entities] : undefined,
          entitySelectionIndex: 0,
          editingEntityField: null,
          editBuffer: "",
          editCursorPos: 0,
        },
      };

    case "SCROLL_PLAN": {
      if (!state.modal) return state;
      const currentOffset = state.modal.planScrollOffset ?? 0;
      const newOffset = action.direction === "down"
        ? currentOffset + 1
        : Math.max(0, currentOffset - 1);
      return {
        ...state,
        modal: { ...state.modal, planScrollOffset: newOffset },
      };
    }

    case "SCROLL_PLAN_PAGE": {
      if (!state.modal) return state;
      const currentOffset = state.modal.planScrollOffset ?? 0;
      const pageSize = Math.floor(state.terminalRows * 0.4);
      const newOffset = action.direction === "down"
        ? currentOffset + pageSize
        : Math.max(0, currentOffset - pageSize);
      return {
        ...state,
        modal: { ...state.modal, planScrollOffset: newOffset },
      };
    }

    case "APPROVAL_SELECT": {
      if (!state.modal?.approvalChoices?.length) return state;
      const count = state.modal.approvalChoices.length;
      const currentIdx = state.modal.approvalSelectedIndex ?? 0;
      const newIndex =
        action.direction === "down"
          ? (currentIdx + 1) % count
          : (currentIdx - 1 + count) % count;
      return {
        ...state,
        modal: { ...state.modal, approvalSelectedIndex: newIndex },
      };
    }

    // Planning modal (shown while gen agent creates plan)
    case "SHOW_PLANNING_MODAL":
      return {
        ...state,
        mode: "modal",
        modal: {
          visible: true,
          title: action.title,
          isComplete: false,
          createdEntities: [],
          selectedIndex: 0,
          progress: "Analyzing context and planning entities...",
        },
      };

    // Search modal
    case "OPEN_SEARCH":
      return {
        ...state,
        mode: "search",
        search: {
          visible: true,
          query: "",
          cursorPos: 0,
          results: [],
          selectedIndex: 0,
          scrollOffset: 0,
        },
      };

    case "CLOSE_SEARCH":
      return {
        ...state,
        mode: "normal",
        search: null,
      };

    case "INSERT_SEARCH_CHAR": {
      if (!state.search) return state;
      const before = state.search.query.slice(0, state.search.cursorPos);
      const after = state.search.query.slice(state.search.cursorPos);
      return {
        ...state,
        search: {
          ...state.search,
          query: before + action.char + after,
          cursorPos: state.search.cursorPos + 1,
        },
      };
    }

    case "BACKSPACE_SEARCH": {
      if (!state.search || state.search.cursorPos === 0) return state;
      const before = state.search.query.slice(0, state.search.cursorPos - 1);
      const after = state.search.query.slice(state.search.cursorPos);
      return {
        ...state,
        search: {
          ...state.search,
          query: before + after,
          cursorPos: state.search.cursorPos - 1,
        },
      };
    }

    case "SET_SEARCH_RESULTS":
      return state.search
        ? {
            ...state,
            search: {
              ...state.search,
              results: action.results,
              selectedIndex: 0,
              scrollOffset: 0,
            },
          }
        : state;

    case "SEARCH_SELECT": {
      if (!state.search || state.search.results.length === 0) return state;
      const count = state.search.results.length;
      const newIndex =
        action.direction === "down"
          ? (state.search.selectedIndex + 1) % count
          : (state.search.selectedIndex - 1 + count) % count;

      // Adjust scroll to keep selection visible
      const maxVisible = Math.floor((state.terminalRows - 10) / 1);
      let newScroll = state.search.scrollOffset;
      if (newIndex < newScroll) {
        newScroll = newIndex;
      } else if (newIndex >= newScroll + maxVisible) {
        newScroll = newIndex - maxVisible + 1;
      }

      return {
        ...state,
        search: {
          ...state.search,
          selectedIndex: newIndex,
          scrollOffset: newScroll,
        },
      };
    }

    case "MOVE_SEARCH_CURSOR": {
      if (!state.search) return state;
      const newPos =
        action.direction === "left"
          ? Math.max(0, state.search.cursorPos - 1)
          : Math.min(state.search.query.length, state.search.cursorPos + 1);
      return {
        ...state,
        search: { ...state.search, cursorPos: newPos },
      };
    }

    // Onboarding modal
    case "OPEN_ONBOARDING":
      return {
        ...state,
        mode: "onboarding",
        onboarding: createInitialOnboardingState(),
      };

    case "CLOSE_ONBOARDING":
      return {
        ...state,
        mode: "normal",
        onboarding: null,
      };

    case "ONBOARDING_NEXT_STEP": {
      if (!state.onboarding) return state;
      let nextIndex = getNextStepIndex(state.onboarding.currentStep);
      let nextStep = ONBOARDING_STEPS[nextIndex];

      // Skip stateSelection if scope is "world" (already set from previous selection)
      if (nextStep === "stateSelection" && state.onboarding.generate.scope === "world") {
        nextIndex = getNextStepIndex(nextStep);
        nextStep = ONBOARDING_STEPS[nextIndex];
      }

      // Get the existing value for the next step to restore inputBuffer
      let existingValue = "";
      if (isTextInputStep(nextStep)) {
        const s = state.onboarding.settings;
        if (nextStep === "worldVibe") existingValue = s.worldVibe ?? "";
        else if (nextStep === "culturalTouchpoints") existingValue = s.culturalTouchpoints ?? "";
        else if (nextStep === "campaignArc") existingValue = s.campaignArc ?? "";
        else if (nextStep === "userNotes") existingValue = s.userNotes ?? "";
      }

      // For multi-checkbox steps, restore checked state
      let newCheckedIndices = new Set<number>();
      if (nextStep === "contentTypes") {
        const ct = state.onboarding.generate.contentTypes;
        if (ct.religions) newCheckedIndices.add(0);
        if (ct.cultures) newCheckedIndices.add(1);
        if (ct.states) newCheckedIndices.add(2);
      } else if (nextStep === "stateSelection") {
        for (const stateId of state.onboarding.generate.selectedStateIds) {
          const idx = state.onboarding.stateList.findIndex(s => s.id === stateId);
          if (idx >= 0) newCheckedIndices.add(idx);
        }
      }

      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          currentStep: nextStep,
          inputBuffer: existingValue,
          inputCursorPos: existingValue.length,
          checkedIndices: newCheckedIndices,
          selectedIndex: 0,
          scrollOffset: 0,
        },
      };
    }

    case "ONBOARDING_PREV_STEP": {
      if (!state.onboarding) return state;
      let prevIndex = getPrevStepIndex(state.onboarding.currentStep);
      let prevStep = ONBOARDING_STEPS[prevIndex];

      // Skip stateSelection when going back if scope is "world"
      if (prevStep === "stateSelection" && state.onboarding.generate.scope === "world") {
        prevIndex = getPrevStepIndex(prevStep);
        prevStep = ONBOARDING_STEPS[prevIndex];
      }

      // Get the existing value for the previous step to restore inputBuffer
      let existingValue = "";
      if (isTextInputStep(prevStep)) {
        const s = state.onboarding.settings;
        if (prevStep === "worldVibe") existingValue = s.worldVibe ?? "";
        else if (prevStep === "culturalTouchpoints") existingValue = s.culturalTouchpoints ?? "";
        else if (prevStep === "campaignArc") existingValue = s.campaignArc ?? "";
        else if (prevStep === "userNotes") existingValue = s.userNotes ?? "";
      }

      // For multi-checkbox steps, restore checked state
      let newCheckedIndices = new Set<number>();
      if (prevStep === "contentTypes") {
        const ct = state.onboarding.generate.contentTypes;
        if (ct.religions) newCheckedIndices.add(0);
        if (ct.cultures) newCheckedIndices.add(1);
        if (ct.states) newCheckedIndices.add(2);
      } else if (prevStep === "stateSelection") {
        for (const stateId of state.onboarding.generate.selectedStateIds) {
          const idx = state.onboarding.stateList.findIndex(s => s.id === stateId);
          if (idx >= 0) newCheckedIndices.add(idx);
        }
      }

      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          currentStep: prevStep,
          inputBuffer: existingValue,
          inputCursorPos: existingValue.length,
          selectedIndex: 0,
          scrollOffset: 0,
          checkedIndices: newCheckedIndices,
        },
      };
    }

    case "ONBOARDING_CONFIRM_STEP": {
      if (!state.onboarding) return state;
      const step = state.onboarding.currentStep;

      // Save the current step's value to settings/generate
      let newSettings = { ...state.onboarding.settings };
      let newGenerate = { ...state.onboarding.generate };

      if (isTextInputStep(step)) {
        const value = state.onboarding.inputBuffer.trim() || undefined;
        (newSettings as any)[step] = value;
      } else if (step === "contentTone") {
        // Map selection index (0-4) to tone value (1-5)
        newSettings.contentTone = state.onboarding.selectedIndex + 1;
      } else if (step === "rating") {
        const options = getStepOptions(step);
        newSettings.rating = options[state.onboarding.selectedIndex] as "pg" | "teen" | "mature" | "explicit";
      } else if (step === "contentTypes") {
        // Save checked content types from checkedIndices
        const checked = state.onboarding.checkedIndices;
        newGenerate = {
          ...newGenerate,
          contentTypes: {
            religions: checked.has(0),
            cultures: checked.has(1),
            states: checked.has(2),
          },
        };
      } else if (step === "scopeSelection") {
        // Save scope selection
        newGenerate = {
          ...newGenerate,
          scope: state.onboarding.selectedIndex === 0 ? "world" : "selectedStates",
        };
      } else if (step === "stateSelection") {
        // Save selected state IDs from checkedIndices
        const selectedIds: number[] = [];
        for (const idx of state.onboarding.checkedIndices) {
          const stateItem = state.onboarding.stateList[idx];
          if (stateItem) {
            selectedIds.push(stateItem.id);
          }
        }
        newGenerate = {
          ...newGenerate,
          selectedStateIds: selectedIds,
        };
      }

      // Move to next step, potentially skipping stateSelection
      let nextIndex = getNextStepIndex(step);
      let nextStep = ONBOARDING_STEPS[nextIndex];

      // Skip stateSelection if scope is "world" (user selected "Entire World")
      if (nextStep === "stateSelection" && newGenerate.scope === "world") {
        nextIndex = getNextStepIndex(nextStep);
        nextStep = ONBOARDING_STEPS[nextIndex];
      }

      // Get the existing value for the next step to restore inputBuffer
      let existingValue = "";
      if (isTextInputStep(nextStep)) {
        if (nextStep === "worldVibe") existingValue = newSettings.worldVibe ?? "";
        else if (nextStep === "culturalTouchpoints") existingValue = newSettings.culturalTouchpoints ?? "";
        else if (nextStep === "campaignArc") existingValue = newSettings.campaignArc ?? "";
        else if (nextStep === "userNotes") existingValue = newSettings.userNotes ?? "";
      }

      // For multi-checkbox steps, restore checked state
      let newCheckedIndices = new Set<number>();
      if (nextStep === "contentTypes") {
        // Restore from generate.contentTypes
        if (newGenerate.contentTypes.religions) newCheckedIndices.add(0);
        if (newGenerate.contentTypes.cultures) newCheckedIndices.add(1);
        if (newGenerate.contentTypes.states) newCheckedIndices.add(2);
      } else if (nextStep === "stateSelection") {
        // Restore from generate.selectedStateIds
        for (const stateId of newGenerate.selectedStateIds) {
          const idx = state.onboarding.stateList.findIndex(s => s.id === stateId);
          if (idx >= 0) newCheckedIndices.add(idx);
        }
      }

      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          currentStep: nextStep,
          settings: newSettings,
          generate: newGenerate,
          inputBuffer: existingValue,
          inputCursorPos: existingValue.length,
          selectedIndex: 0,
          scrollOffset: 0,
          checkedIndices: newCheckedIndices,
        },
      };
    }

    case "INSERT_ONBOARDING_CHAR": {
      if (!state.onboarding) return state;
      const before = state.onboarding.inputBuffer.slice(0, state.onboarding.inputCursorPos);
      const after = state.onboarding.inputBuffer.slice(state.onboarding.inputCursorPos);
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          inputBuffer: before + action.char + after,
          inputCursorPos: state.onboarding.inputCursorPos + 1,
        },
      };
    }

    case "BACKSPACE_ONBOARDING": {
      if (!state.onboarding || state.onboarding.inputCursorPos === 0) return state;
      const before = state.onboarding.inputBuffer.slice(0, state.onboarding.inputCursorPos - 1);
      const after = state.onboarding.inputBuffer.slice(state.onboarding.inputCursorPos);
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          inputBuffer: before + after,
          inputCursorPos: state.onboarding.inputCursorPos - 1,
        },
      };
    }

    case "MOVE_ONBOARDING_CURSOR": {
      if (!state.onboarding) return state;
      const newPos =
        action.direction === "left"
          ? Math.max(0, state.onboarding.inputCursorPos - 1)
          : Math.min(state.onboarding.inputBuffer.length, state.onboarding.inputCursorPos + 1);
      return {
        ...state,
        onboarding: { ...state.onboarding, inputCursorPos: newPos },
      };
    }

    case "ONBOARDING_SELECT": {
      if (!state.onboarding) return state;

      // Get count based on step type
      let count: number;
      if (state.onboarding.currentStep === "stateSelection") {
        // Use state list length for stateSelection step
        count = state.onboarding.stateList.length;
      } else {
        const options = getStepOptions(state.onboarding.currentStep);
        count = options.length;
      }

      if (count === 0) return state;
      const newIndex =
        action.direction === "down"
          ? (state.onboarding.selectedIndex + 1) % count
          : (state.onboarding.selectedIndex - 1 + count) % count;

      // Also adjust scroll for stateSelection to keep selection visible
      let newScrollOffset = state.onboarding.scrollOffset;
      if (state.onboarding.currentStep === "stateSelection") {
        const visibleHeight = Math.floor(state.terminalRows * 0.4); // approximate visible items
        if (newIndex < newScrollOffset) {
          newScrollOffset = newIndex;
        } else if (newIndex >= newScrollOffset + visibleHeight) {
          newScrollOffset = newIndex - visibleHeight + 1;
        }
      }

      return {
        ...state,
        onboarding: { ...state.onboarding, selectedIndex: newIndex, scrollOffset: newScrollOffset },
      };
    }

    case "SET_ONBOARDING_SELECTION":
      return state.onboarding
        ? {
            ...state,
            onboarding: { ...state.onboarding, selectedIndex: action.index },
          }
        : state;

    case "SCROLL_ONBOARDING": {
      if (!state.onboarding) return state;
      const newOffset = action.direction === "down"
        ? state.onboarding.scrollOffset + 1
        : Math.max(0, state.onboarding.scrollOffset - 1);
      return {
        ...state,
        onboarding: { ...state.onboarding, scrollOffset: newOffset },
      };
    }

    case "SCROLL_ONBOARDING_PAGE": {
      if (!state.onboarding) return state;
      const pageSize = Math.floor(state.terminalRows * 0.4);
      const newOffset = action.direction === "down"
        ? state.onboarding.scrollOffset + pageSize
        : Math.max(0, state.onboarding.scrollOffset - pageSize);
      return {
        ...state,
        onboarding: { ...state.onboarding, scrollOffset: newOffset },
      };
    }

    case "TOGGLE_ONBOARDING_CHECKBOX": {
      if (!state.onboarding) return state;
      const newChecked = new Set(state.onboarding.checkedIndices);
      const idx = state.onboarding.selectedIndex;
      if (newChecked.has(idx)) {
        newChecked.delete(idx);
      } else {
        newChecked.add(idx);
      }
      return {
        ...state,
        onboarding: { ...state.onboarding, checkedIndices: newChecked },
      };
    }

    case "SET_ONBOARDING_STATE_LIST":
      return state.onboarding
        ? {
            ...state,
            onboarding: { ...state.onboarding, stateList: action.states },
          }
        : state;

    // Help modal
    case "OPEN_HELP":
      return {
        ...state,
        mode: "help",
        help: {
          visible: true,
          scrollOffset: 0,
          contentLines: getHelpContent(),
        },
      };

    case "CLOSE_HELP":
      return {
        ...state,
        mode: "normal",
        help: null,
      };

    case "SCROLL_HELP": {
      if (!state.help) return state;
      const maxOffset = Math.max(0, state.help.contentLines.length - Math.floor(state.terminalRows * 0.5));
      const newOffset = action.direction === "down"
        ? Math.min(state.help.scrollOffset + 1, maxOffset)
        : Math.max(state.help.scrollOffset - 1, 0);
      return {
        ...state,
        help: { ...state.help, scrollOffset: newOffset },
      };
    }

    case "SCROLL_HELP_PAGE": {
      if (!state.help) return state;
      const pageSize = Math.floor(state.terminalRows * 0.4);
      const maxOffset = Math.max(0, state.help.contentLines.length - Math.floor(state.terminalRows * 0.5));
      const newOffset = action.direction === "down"
        ? Math.min(state.help.scrollOffset + pageSize, maxOffset)
        : Math.max(state.help.scrollOffset - pageSize, 0);
      return {
        ...state,
        help: { ...state.help, scrollOffset: newOffset },
      };
    }

    // Terminal
    case "RESIZE":
      return {
        ...state,
        terminalRows: action.rows,
        terminalCols: action.cols,
      };

    // Model info and token tracking
    case "SET_MODEL_INFO":
      return {
        ...state,
        modelInfo: action.modelInfo,
      };

    case "ADD_PLANNER_TOKENS":
      return {
        ...state,
        tokenCounts: {
          ...state.tokenCounts,
          planner: {
            promptTokens: state.tokenCounts.planner.promptTokens + (action.usage.promptTokens ?? 0),
            completionTokens: state.tokenCounts.planner.completionTokens + (action.usage.completionTokens ?? 0),
            totalTokens: state.tokenCounts.planner.totalTokens + (action.usage.totalTokens ?? 0),
          },
        },
      };

    case "ADD_GENERATION_TOKENS":
      return {
        ...state,
        tokenCounts: {
          ...state.tokenCounts,
          generation: {
            promptTokens: state.tokenCounts.generation.promptTokens + (action.usage.promptTokens ?? 0),
            completionTokens: state.tokenCounts.generation.completionTokens + (action.usage.completionTokens ?? 0),
            totalTokens: state.tokenCounts.generation.totalTokens + (action.usage.totalTokens ?? 0),
          },
        },
      };

    case "RESET_TOKEN_COUNTS":
      return {
        ...state,
        tokenCounts: {
          planner: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          generation: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      };

    // Field selection modal
    case "OPEN_FIELD_SELECTION":
      return {
        ...state,
        mode: "fieldSelection",
        fieldSelection: {
          visible: true,
          entityId: action.entityId,
          entityType: action.entityType,
          entityName: action.entityName,
          coreFields: action.coreFields,
          payloadFields: action.payloadFields,
          selectedFields: new Set<string>(),
          selectedIndex: 0,
          scrollOffset: 0,
          hint: action.hint,
          hintCursorPos: action.hint.length,
        },
      };

    case "CLOSE_FIELD_SELECTION":
      return {
        ...state,
        mode: "normal",
        fieldSelection: null,
      };

    case "FIELD_SELECTION_MOVE": {
      if (!state.fieldSelection) return state;
      const totalFields = state.fieldSelection.coreFields.length + state.fieldSelection.payloadFields.length;
      if (totalFields === 0) return state;

      const newIndex =
        action.direction === "down"
          ? (state.fieldSelection.selectedIndex + 1) % totalFields
          : (state.fieldSelection.selectedIndex - 1 + totalFields) % totalFields;

      return {
        ...state,
        fieldSelection: { ...state.fieldSelection, selectedIndex: newIndex },
      };
    }

    case "TOGGLE_FIELD_SELECTION": {
      if (!state.fieldSelection) return state;
      const allFields = [...state.fieldSelection.coreFields, ...state.fieldSelection.payloadFields];
      const selectedField = allFields[state.fieldSelection.selectedIndex];
      if (!selectedField) return state;

      const newSelected = new Set(state.fieldSelection.selectedFields);
      if (newSelected.has(selectedField)) {
        newSelected.delete(selectedField);
      } else {
        newSelected.add(selectedField);
      }

      return {
        ...state,
        fieldSelection: { ...state.fieldSelection, selectedFields: newSelected },
      };
    }

    case "INSERT_FIELD_HINT_CHAR": {
      if (!state.fieldSelection) return state;
      const before = state.fieldSelection.hint.slice(0, state.fieldSelection.hintCursorPos);
      const after = state.fieldSelection.hint.slice(state.fieldSelection.hintCursorPos);
      return {
        ...state,
        fieldSelection: {
          ...state.fieldSelection,
          hint: before + action.char + after,
          hintCursorPos: state.fieldSelection.hintCursorPos + 1,
        },
      };
    }

    case "BACKSPACE_FIELD_HINT": {
      if (!state.fieldSelection || state.fieldSelection.hintCursorPos === 0) return state;
      const before = state.fieldSelection.hint.slice(0, state.fieldSelection.hintCursorPos - 1);
      const after = state.fieldSelection.hint.slice(state.fieldSelection.hintCursorPos);
      return {
        ...state,
        fieldSelection: {
          ...state.fieldSelection,
          hint: before + after,
          hintCursorPos: state.fieldSelection.hintCursorPos - 1,
        },
      };
    }

    case "MOVE_FIELD_HINT_CURSOR": {
      if (!state.fieldSelection) return state;
      const newPos =
        action.direction === "left"
          ? Math.max(0, state.fieldSelection.hintCursorPos - 1)
          : Math.min(state.fieldSelection.hint.length, state.fieldSelection.hintCursorPos + 1);
      return {
        ...state,
        fieldSelection: { ...state.fieldSelection, hintCursorPos: newPos },
      };
    }

    // Entity editing in approval modal
    case "SELECT_ENTITY": {
      if (!state.modal?.pendingEntities?.length) return state;
      const count = state.modal.pendingEntities.length;
      const currentIdx = state.modal.entitySelectionIndex ?? 0;
      const newIndex =
        action.direction === "down"
          ? (currentIdx + 1) % count
          : (currentIdx - 1 + count) % count;
      return {
        ...state,
        modal: { ...state.modal, entitySelectionIndex: newIndex },
      };
    }

    case "START_ENTITY_EDIT": {
      if (!state.modal?.pendingEntities?.length) return state;
      const entities = state.modal.pendingEntities as EntityPlan[];
      const entityIdx = state.modal.entitySelectionIndex ?? 0;
      const entity = entities[entityIdx];
      if (!entity) return state;

      // Get current value for the field
      let currentValue = "";
      if (action.field === "name") {
        currentValue = entity.name;
      } else if (action.field === "reason") {
        currentValue = entity.reason;
      } else if (action.field === "customPrompt") {
        currentValue = entity.customPrompt || "";
      }

      return {
        ...state,
        mode: "entityEdit",
        modal: {
          ...state.modal,
          editingEntityField: action.field,
          editBuffer: currentValue,
          editCursorPos: currentValue.length,
        },
      };
    }

    case "CANCEL_ENTITY_EDIT":
      return state.modal
        ? {
            ...state,
            mode: "modal",
            modal: {
              ...state.modal,
              editingEntityField: null,
              editBuffer: "",
              editCursorPos: 0,
            },
          }
        : state;

    case "SAVE_ENTITY_EDIT": {
      if (!state.modal?.pendingEntities?.length || !state.modal.editingEntityField) return state;
      const entities = [...(state.modal.pendingEntities as EntityPlan[])];
      const entityIdx = state.modal.entitySelectionIndex ?? 0;
      const entity = entities[entityIdx];
      if (!entity) return state;

      // Update the field
      const field = state.modal.editingEntityField;
      const newValue = state.modal.editBuffer ?? "";
      if (field === "name") {
        const oldName = entity.name;
        entities[entityIdx] = { ...entity, name: newValue };

        // Update connectsTo references in other entities that point to this entity
        if (oldName !== newValue) {
          for (let i = 0; i < entities.length; i++) {
            if (i === entityIdx) continue;
            const otherEntity = entities[i];
            if (otherEntity.connectsTo?.length) {
              const updatedConnections = otherEntity.connectsTo.map(conn =>
                conn.name === oldName ? { ...conn, name: newValue } : conn
              );
              // Only update if something changed
              if (updatedConnections.some((conn, idx) => conn !== otherEntity.connectsTo[idx])) {
                entities[i] = { ...otherEntity, connectsTo: updatedConnections };
              }
            }
          }
        }
      } else if (field === "reason") {
        entities[entityIdx] = { ...entity, reason: newValue };
      } else if (field === "customPrompt") {
        entities[entityIdx] = { ...entity, customPrompt: newValue || undefined };
      }

      return {
        ...state,
        mode: "modal",
        modal: {
          ...state.modal,
          pendingEntities: entities,
          editingEntityField: null,
          editBuffer: "",
          editCursorPos: 0,
        },
      };
    }

    case "INSERT_ENTITY_EDIT_CHAR": {
      if (!state.modal) return state;
      const before = (state.modal.editBuffer ?? "").slice(0, state.modal.editCursorPos ?? 0);
      const after = (state.modal.editBuffer ?? "").slice(state.modal.editCursorPos ?? 0);
      return {
        ...state,
        modal: {
          ...state.modal,
          editBuffer: before + action.char + after,
          editCursorPos: (state.modal.editCursorPos ?? 0) + 1,
        },
      };
    }

    case "BACKSPACE_ENTITY_EDIT": {
      if (!state.modal || (state.modal.editCursorPos ?? 0) === 0) return state;
      const cursorPos = state.modal.editCursorPos ?? 0;
      const before = (state.modal.editBuffer ?? "").slice(0, cursorPos - 1);
      const after = (state.modal.editBuffer ?? "").slice(cursorPos);
      return {
        ...state,
        modal: {
          ...state.modal,
          editBuffer: before + after,
          editCursorPos: cursorPos - 1,
        },
      };
    }

    case "MOVE_ENTITY_EDIT_CURSOR": {
      if (!state.modal) return state;
      const cursorPos = state.modal.editCursorPos ?? 0;
      const bufferLen = (state.modal.editBuffer ?? "").length;
      const newPos =
        action.direction === "left"
          ? Math.max(0, cursorPos - 1)
          : Math.min(bufferLen, cursorPos + 1);
      return {
        ...state,
        modal: { ...state.modal, editCursorPos: newPos },
      };
    }

    default:
      return state;
  }
}

/**
 * Get the currently selected tree node
 */
export function getSelectedNode(state: TuiState): TreeNode | undefined {
  return state.treeNodes.find((n) => n.id === state.selectedNodeId);
}

/**
 * Check if a node is expanded
 */
export function isNodeExpanded(state: TuiState, nodeId: string): boolean {
  return state.expandedNodes.has(nodeId);
}

/**
 * Get visible tree nodes (accounting for scroll)
 */
export function getVisibleTreeNodes(state: TuiState, maxVisible: number): TreeNode[] {
  return state.treeNodes.slice(state.treeScrollOffset, state.treeScrollOffset + maxVisible);
}

/**
 * Dispatch helper - applies action and returns new state
 */
export function dispatch(state: TuiState, action: TuiAction): TuiState {
  return tuiReducer(state, action);
}

/**
 * Batch dispatch - applies multiple actions in sequence
 */
export function dispatchAll(state: TuiState, actions: TuiAction[]): TuiState {
  return actions.reduce((s, action) => tuiReducer(s, action), state);
}

// Export onboarding helpers for use by modal renderer
export { ONBOARDING_STEPS, getStepOptions, isTextInputStep, isMultiCheckboxStep };
