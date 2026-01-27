/**
 * State management for azbrowse TUI
 *
 * Redux-like reducer pattern for deterministic state updates.
 */

import type { TuiState, TuiAction, TreeNode, ModalState, InputMode, FocusArea, ApprovalChoice, ModelInfo, TokenCounts, SearchResult, SearchState } from "./types";

/**
 * Create initial TUI state
 */
export function createInitialTuiState(): TuiState {
  return {
    mode: "normal",
    focus: "tree",

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

    // Command mode
    commandBuffer: "",
    commandCursorPos: 0,
    commandHistory: [],
    commandHistoryIndex: -1,

    // Modal
    modal: null,

    // Search modal
    search: null,

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
        },
      };

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
