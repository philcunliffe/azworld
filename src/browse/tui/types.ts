/**
 * Type definitions for azbrowse TUI
 */

import { z } from "zod";
import type { EntityRef } from "../state";

// Input modes for the TUI
export const InputModeEnum = z.enum([
  "normal",   // vim-style navigation in tree
  "command",  // typing commands after ':'
  "modal",    // viewing generation results modal
]);

export type InputMode = z.infer<typeof InputModeEnum>;

// Focus area within the TUI
export const FocusAreaEnum = z.enum([
  "tree",     // left tree panel
  "detail",   // right detail panel
]);

export type FocusArea = z.infer<typeof FocusAreaEnum>;

// Entity types for color coding
export const EntityKindEnum = z.enum([
  "world",
  "state",
  "burg",
  "location",
  "npc",
  "faction",
  "event",
]);

export type EntityKind = z.infer<typeof EntityKindEnum>;

// Tree node for the navigation tree
export type TreeNode = {
  id: string;                               // Unique identifier (e.g., "world", "state:1", "burg:42")
  ref: EntityRef;                           // EntityRef for navigation
  name: string;                             // Display name
  kind: EntityKind;                         // Entity type for color coding
  expanded: boolean;                        // Is this node expanded?
  hasChildren: boolean;                     // Can this node be expanded?
  children?: TreeNode[];                    // Child nodes (loaded lazily)
  depth: number;                            // Tree depth (0 = root)
  isSelected: boolean;                      // Is this the currently selected node?
  extra?: string;                           // Extra display info (population, tags, etc.)
};

export const TreeNodeSchema: z.ZodType<TreeNode> = z.object({
  id: z.string(),
  ref: z.custom<EntityRef>(),
  name: z.string(),
  kind: EntityKindEnum,
  expanded: z.boolean(),
  hasChildren: z.boolean(),
  children: z.lazy(() => z.array(TreeNodeSchema)).optional(),
  depth: z.number(),
  isSelected: z.boolean(),
  extra: z.string().optional(),
});

// Approval choice for gen command permission prompts
export const ApprovalChoiceSchema = z.object({
  label: z.string(),
  value: z.string(),
  hint: z.string().optional(),
});

export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

// Modal state for generation progress/results
export const ModalStateSchema = z.object({
  visible: z.boolean(),
  title: z.string(),
  progress: z.string().optional(),          // Current progress message
  isComplete: z.boolean(),
  createdEntities: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: EntityKindEnum,
  })),
  selectedIndex: z.number(),                // Selected entity in list
  error: z.string().optional(),
  // Approval modal fields
  approvalChoices: z.array(ApprovalChoiceSchema).optional(),
  approvalSelectedIndex: z.number().optional(),
  pendingPlanText: z.string().optional(),   // Formatted plan text for detail panel
});

export type ModalState = z.infer<typeof ModalStateSchema>;

// Command history entry
export const CommandHistoryEntrySchema = z.object({
  command: z.string(),
  timestamp: z.number(),
});

export type CommandHistoryEntry = z.infer<typeof CommandHistoryEntrySchema>;

// Model info for footer display
export const ModelInfoSchema = z.object({
  plannerProvider: z.string(),
  plannerModel: z.string(),
  generationProvider: z.string(),
  generationModel: z.string(),
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;

// Token counts for each phase
export const TokenCountsSchema = z.object({
  planner: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }),
  generation: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }),
});

export type TokenCounts = z.infer<typeof TokenCountsSchema>;

// Main TUI state
export const TuiStateSchema = z.object({
  mode: InputModeEnum,
  focus: FocusAreaEnum,

  // Tree state
  treeNodes: z.array(TreeNodeSchema),       // Flattened visible tree nodes
  selectedNodeId: z.string().nullable(),    // Currently selected tree node
  treeScrollOffset: z.number(),             // Scroll position in tree
  expandedNodes: z.set(z.string()),         // Set of expanded node IDs

  // Detail panel
  detailScrollOffset: z.number(),           // Scroll position in detail panel
  detailExpandedSections: z.set(z.string()), // Expanded section keys (sections collapsed by default)
  detailSectionIndex: z.number(),           // Active section index for keyboard nav
  detailSectionCount: z.number(),           // Total number of sections (updated on render)

  // Command mode
  commandBuffer: z.string(),                // Current command being typed
  commandCursorPos: z.number(),             // Cursor position within commandBuffer
  commandHistory: z.array(CommandHistoryEntrySchema),
  commandHistoryIndex: z.number(),          // -1 = not browsing history

  // Modal
  modal: ModalStateSchema.nullable(),

  // Screen dimensions (updated on resize)
  terminalRows: z.number(),
  terminalCols: z.number(),

  // Model info for footer display
  modelInfo: ModelInfoSchema.nullable(),

  // Token tracking for planner and generation phases
  tokenCounts: TokenCountsSchema,
});

export type TuiState = z.infer<typeof TuiStateSchema>;

// Action types for state reducer
export type TuiAction =
  // Mode changes
  | { type: "SET_MODE"; mode: InputMode }
  | { type: "SET_FOCUS"; focus: FocusArea }

  // Tree navigation
  | { type: "SELECT_NODE"; id: string }
  | { type: "MOVE_SELECTION"; direction: "up" | "down" }
  | { type: "EXPAND_NODE"; id: string }
  | { type: "COLLAPSE_NODE"; id: string }
  | { type: "TOGGLE_NODE"; id: string }
  | { type: "SET_TREE_NODES"; nodes: TreeNode[] }
  | { type: "UPDATE_NODE_CHILDREN"; id: string; children: TreeNode[] }
  | { type: "SET_TREE_SCROLL"; offset: number }

  // Detail panel
  | { type: "SET_DETAIL_SCROLL"; offset: number }
  | { type: "SCROLL_DETAIL"; direction: "up" | "down"; amount: number }
  | { type: "TOGGLE_DETAIL_SECTION"; sectionKey: string }
  | { type: "MOVE_DETAIL_SECTION"; direction: "up" | "down" }
  | { type: "RESET_DETAIL_SECTIONS" }
  | { type: "SET_DETAIL_SECTION_COUNT"; count: number }

  // Command mode
  | { type: "SET_COMMAND_BUFFER"; text: string }
  | { type: "APPEND_COMMAND"; char: string }
  | { type: "INSERT_COMMAND"; char: string }  // Insert at cursor position
  | { type: "BACKSPACE_COMMAND" }
  | { type: "DELETE_COMMAND" }                // Delete char at cursor (like Delete key)
  | { type: "CLEAR_COMMAND" }
  | { type: "MOVE_CURSOR"; direction: "left" | "right" }
  | { type: "MOVE_CURSOR_TO"; position: "start" | "end" }
  | { type: "HISTORY_UP" }
  | { type: "HISTORY_DOWN" }
  | { type: "ADD_TO_HISTORY"; command: string }

  // Modal
  | { type: "SHOW_MODAL"; title: string }
  | { type: "UPDATE_MODAL_PROGRESS"; progress: string }
  | { type: "ADD_MODAL_ENTITY"; entity: { id: string; name: string; kind: EntityKind } }
  | { type: "COMPLETE_MODAL" }
  | { type: "MODAL_ERROR"; error: string }
  | { type: "MODAL_SELECT"; direction: "up" | "down" }
  | { type: "CLOSE_MODAL" }
  // Approval modal
  | { type: "SHOW_APPROVAL_MODAL"; title: string; choices: ApprovalChoice[]; planText: string }
  | { type: "APPROVAL_SELECT"; direction: "up" | "down" }
  // Planning modal (shown while gen agent creates plan)
  | { type: "SHOW_PLANNING_MODAL"; title: string }

  // Terminal
  | { type: "RESIZE"; rows: number; cols: number }

  // Model info and token tracking
  | { type: "SET_MODEL_INFO"; modelInfo: ModelInfo }
  | { type: "ADD_PLANNER_TOKENS"; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { type: "ADD_GENERATION_TOKENS"; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { type: "RESET_TOKEN_COUNTS" };

// Callbacks from TUI to main app
export type TuiCallbacks = {
  // Navigation
  onNavigate: (ref: EntityRef) => void;

  // Commands
  onCommand: (command: string) => Promise<{
    output?: string;
    error?: string;
    quit?: boolean;
    enterTalkMode?: boolean;
    exitTalkMode?: boolean;
  }>;

  // Tree operations
  onLoadChildren: (ref: EntityRef) => Promise<TreeNode[]>;

  // Generation
  onGenerationStart: (type: string, hints: string) => void;
  onGenerationComplete: (entities: Array<{ id: string; name: string; kind: EntityKind }>) => void;
};

// Keypress result from keybinding handler
export type KeypressResult = {
  actions: TuiAction[];
  callback?: "execute_command" | "navigate_to_entity" | "sync_browse_state" | "quit" | "execute_approved_generation" | "execute_approved_modification" | "toggle_current_section" | null;
  entityRef?: EntityRef;
};
