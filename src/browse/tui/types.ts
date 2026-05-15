/**
 * Type definitions for azbrowse TUI
 */

import { z } from "zod";
import type { EntityRef } from "../state";
import type { EntityPlan } from "../gen-agent";

// Input modes for the TUI
export const InputModeEnum = z.enum([
  "normal",           // vim-style navigation in tree
  "command",          // typing commands after ':'
  "modal",            // viewing generation results modal
  "search",           // global search modal
  "onboarding",       // campaign settings wizard
  "help",             // help modal showing all commands
  "fieldSelection",   // field selection for :gen on existing entity
  "entityEdit",       // editing entity field in approval modal
  "talk",             // NPC talk mode - typing messages to NPC
  "ideas",            // ideas pool panel
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
  "rumor",
  "hook",
  "culture",
  "religion",
  "deity",
  "marker",
]);

export type EntityKind = z.infer<typeof EntityKindEnum>;

// Tab identifiers for left panel
export const TabIdEnum = z.enum([
  "world",      // Hierarchical tree (states → burgs → locations/NPCs)
  "factions",   // Flat alphabetical list from canon DB
  "religions",  // Flat alphabetical list from Azgaar world
  "cultures",   // Flat alphabetical list from Azgaar world
]);

export type TabId = z.infer<typeof TabIdEnum>;

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

// Search result for global search modal
export const SearchResultSchema = z.object({
  id: z.string(),                              // Node ID (e.g., "burg:42", "npc:abc123")
  name: z.string(),                            // Display name
  kind: EntityKindEnum,                        // Entity type for color coding
  score: z.number(),                           // Match score for ranking
  breadcrumb: z.string().optional(),           // Path context (e.g., "Valenwood > Solitude")
  source: z.enum(["world", "canon"]),          // Origin of result
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

// Search modal state
export const SearchStateSchema = z.object({
  visible: z.boolean(),
  query: z.string(),                           // Current search input
  cursorPos: z.number(),                       // Cursor position in query
  results: z.array(SearchResultSchema),
  selectedIndex: z.number(),                   // Currently highlighted result
  scrollOffset: z.number(),                    // Scroll position in results list
});

export type SearchState = z.infer<typeof SearchStateSchema>;

// Help modal state
export const HelpStateSchema = z.object({
  visible: z.boolean(),
  scrollOffset: z.number(),
  contentLines: z.array(z.string()),
});

export type HelpState = z.infer<typeof HelpStateSchema>;

// Field selection modal state for :gen on existing entities
export const FieldSelectionStateSchema = z.object({
  visible: z.boolean(),
  entityId: z.string(),
  entityType: z.string(),
  entityName: z.string(),
  coreFields: z.array(z.string()),      // Core fields available
  payloadFields: z.array(z.string()),   // Payload fields available
  selectedFields: z.set(z.string()),    // Currently selected fields
  selectedIndex: z.number(),            // Current highlight position
  scrollOffset: z.number(),             // Scroll position
  hint: z.string(),                     // User hint text
  hintCursorPos: z.number(),            // Cursor position in hint
});

export type FieldSelectionState = z.infer<typeof FieldSelectionStateSchema>;

// Ideas pool panel state
export const IdeasStatusFilterEnum = z.enum(["pending", "used", "all"]);
export type IdeasStatusFilter = z.infer<typeof IdeasStatusFilterEnum>;

export const IdeaListItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.string(),
  labels: z.array(z.string()),
  labelsStatus: z.string(),
  usedByName: z.string().nullable(),
});
export type IdeaListItem = z.infer<typeof IdeaListItemSchema>;

export const IdeasStateSchema = z.object({
  visible: z.boolean(),
  statusFilter: IdeasStatusFilterEnum,
  items: z.array(IdeaListItemSchema),
  selectedIndex: z.number(),
  scrollOffset: z.number(),
  subMode: z.enum(["list", "add"]),
  inputBuffer: z.string(),
  inputCursorPos: z.number(),
  status: z.string().nullable(),   // transient status line (success/error)
});
export type IdeasState = z.infer<typeof IdeasStateSchema>;

// Entity edit field type
export const EntityEditFieldEnum = z.enum(["name", "reason", "customPrompt"]);
export type EntityEditField = z.infer<typeof EntityEditFieldEnum>;

// Onboarding step identifiers
export const OnboardingStepEnum = z.enum([
  "worldVibe",
  "culturalTouchpoints",
  "campaignArc",
  "userNotes",
  "contentTone",
  "rating",
  "contentTypes",      // Multi-checkbox: Religions, Cultures, States+Leaders
  "scopeSelection",    // Entire World or Select States
  "stateSelection",    // Multi-select list of states (if scope is "selectedStates")
  "confirm",
]);

export type OnboardingStep = z.infer<typeof OnboardingStepEnum>;

// State item for state selection list
export const StateListItemSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export type StateListItem = z.infer<typeof StateListItemSchema>;

// Onboarding state for campaign settings wizard
export const OnboardingStateSchema = z.object({
  visible: z.boolean(),
  currentStep: OnboardingStepEnum,
  settings: z.object({
    worldVibe: z.string().optional(),
    culturalTouchpoints: z.string().optional(),
    campaignArc: z.string().optional(),
    userNotes: z.string().optional(),
    contentTone: z.number().min(1).max(5).optional(),
    rating: z.enum(["pg", "teen", "mature", "explicit"]).optional(),
  }),
  generate: z.object({
    contentTypes: z.object({
      religions: z.boolean(),
      pantheons: z.boolean(),
      cultures: z.boolean(),
      states: z.boolean(),
    }),
    scope: z.enum(["world", "selectedStates"]),
    selectedStateIds: z.array(z.number()),
  }),
  inputBuffer: z.string(),                    // Text input for current step
  inputCursorPos: z.number(),                 // Cursor position in input
  selectedIndex: z.number(),                  // For selection steps (tone, rating, booleans)
  scrollOffset: z.number(),                   // Scroll position for confirm step
  checkedIndices: z.set(z.number()),          // For multi-checkbox steps (contentTypes, stateSelection)
  stateList: z.array(StateListItemSchema),    // Cached state list for stateSelection step
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

// Modal state for generation progress/results
export const ModalStateSchema = z.object({
  visible: z.boolean(),
  title: z.string(),
  message: z.string().optional(),
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
  planScrollOffset: z.number().optional(),  // Scroll position in plan text
  // Entity editing fields for approval modal
  pendingEntities: z.array(z.any()).optional(),  // Editable copy of plan.entities (EntityPlan[])
  entitySelectionIndex: z.number().optional(),   // Currently selected entity (0-based)
  editingEntityField: EntityEditFieldEnum.nullable().optional(),  // Which field is being edited
  editBuffer: z.string().optional(),             // Current edit text
  editCursorPos: z.number().optional(),          // Cursor position in edit buffer
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

  // Tab state for left panel
  activeTab: TabIdEnum,                     // Currently active tab

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
  detailLinkIndex: z.number(),              // Selected link index within current section (for Links sections)

  // Command mode
  commandBuffer: z.string(),                // Current command being typed
  commandCursorPos: z.number(),             // Cursor position within commandBuffer
  commandHistory: z.array(CommandHistoryEntrySchema),
  commandHistoryIndex: z.number(),          // -1 = not browsing history

  // Modal
  modal: ModalStateSchema.nullable(),

  // Search modal
  search: SearchStateSchema.nullable(),

  // Onboarding modal
  onboarding: OnboardingStateSchema.nullable(),

  // Help modal
  help: HelpStateSchema.nullable(),

  // Field selection modal
  fieldSelection: FieldSelectionStateSchema.nullable(),

  // Ideas pool panel
  ideas: IdeasStateSchema.nullable(),

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
  | { type: "SET_TAB"; tab: TabId }

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
  | { type: "MOVE_DETAIL_LINK"; direction: "up" | "down" }
  | { type: "RESET_DETAIL_LINK_INDEX" }

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
  | { type: "SHOW_MESSAGE_MODAL"; title: string; message: string }
  | { type: "UPDATE_MODAL_PROGRESS"; progress: string }
  | { type: "ADD_MODAL_ENTITY"; entity: { id: string; name: string; kind: EntityKind } }
  | { type: "COMPLETE_MODAL" }
  | { type: "MODAL_ERROR"; error: string }
  | { type: "MODAL_SELECT"; direction: "up" | "down" }
  | { type: "CLOSE_MODAL" }
  // Approval modal
  | { type: "SHOW_APPROVAL_MODAL"; title: string; choices: ApprovalChoice[]; planText: string; entities?: EntityPlan[] }
  | { type: "APPROVAL_SELECT"; direction: "up" | "down" }
  | { type: "SCROLL_PLAN"; direction: "up" | "down" }
  | { type: "SCROLL_PLAN_PAGE"; direction: "up" | "down" }
  // Planning modal (shown while gen agent creates plan)
  | { type: "SHOW_PLANNING_MODAL"; title: string }

  // Search modal
  | { type: "OPEN_SEARCH" }
  | { type: "CLOSE_SEARCH" }
  | { type: "INSERT_SEARCH_CHAR"; char: string }
  | { type: "BACKSPACE_SEARCH" }
  | { type: "SET_SEARCH_RESULTS"; results: SearchResult[] }
  | { type: "SEARCH_SELECT"; direction: "up" | "down" }
  | { type: "MOVE_SEARCH_CURSOR"; direction: "left" | "right" }

  // Onboarding modal
  | { type: "OPEN_ONBOARDING" }
  | { type: "CLOSE_ONBOARDING" }
  | { type: "ONBOARDING_NEXT_STEP" }
  | { type: "ONBOARDING_PREV_STEP" }
  | { type: "ONBOARDING_CONFIRM_STEP" }
  | { type: "INSERT_ONBOARDING_CHAR"; char: string }
  | { type: "BACKSPACE_ONBOARDING" }
  | { type: "MOVE_ONBOARDING_CURSOR"; direction: "left" | "right" }
  | { type: "ONBOARDING_SELECT"; direction: "up" | "down" }
  | { type: "SET_ONBOARDING_SELECTION"; index: number }
  | { type: "SCROLL_ONBOARDING"; direction: "up" | "down" }
  | { type: "SCROLL_ONBOARDING_PAGE"; direction: "up" | "down" }
  | { type: "TOGGLE_ONBOARDING_CHECKBOX" }  // Toggle checkbox at current selectedIndex
  | { type: "SET_ONBOARDING_STATE_LIST"; states: Array<{ id: number; name: string }> }

  // Help modal
  | { type: "OPEN_HELP" }
  | { type: "CLOSE_HELP" }
  | { type: "SCROLL_HELP"; direction: "up" | "down" }
  | { type: "SCROLL_HELP_PAGE"; direction: "up" | "down" }

  // Field selection modal
  | { type: "OPEN_FIELD_SELECTION"; entityId: string; entityType: string; entityName: string; coreFields: string[]; payloadFields: string[]; hint: string }
  | { type: "CLOSE_FIELD_SELECTION" }
  | { type: "FIELD_SELECTION_MOVE"; direction: "up" | "down" }
  | { type: "TOGGLE_FIELD_SELECTION" }
  | { type: "INSERT_FIELD_HINT_CHAR"; char: string }
  | { type: "BACKSPACE_FIELD_HINT" }
  | { type: "MOVE_FIELD_HINT_CURSOR"; direction: "left" | "right" }

  // Ideas pool panel
  | { type: "OPEN_IDEAS" }
  | { type: "CLOSE_IDEAS" }
  | { type: "SET_IDEAS_ITEMS"; items: IdeaListItem[] }
  | { type: "SET_IDEAS_FILTER"; filter: IdeasStatusFilter }
  | { type: "IDEAS_MOVE"; direction: "up" | "down" }
  | { type: "IDEAS_START_ADD" }
  | { type: "IDEAS_CANCEL_ADD" }
  | { type: "INSERT_IDEAS_CHAR"; char: string }
  | { type: "BACKSPACE_IDEAS_INPUT" }
  | { type: "MOVE_IDEAS_CURSOR"; direction: "left" | "right" }
  | { type: "CLEAR_IDEAS_INPUT" }
  | { type: "SET_IDEAS_STATUS"; status: string | null }

  // Entity editing in approval modal
  | { type: "SELECT_ENTITY"; direction: "up" | "down" }
  | { type: "START_ENTITY_EDIT"; field: EntityEditField }
  | { type: "CANCEL_ENTITY_EDIT" }
  | { type: "SAVE_ENTITY_EDIT" }
  | { type: "INSERT_ENTITY_EDIT_CHAR"; char: string }
  | { type: "BACKSPACE_ENTITY_EDIT" }
  | { type: "MOVE_ENTITY_EDIT_CURSOR"; direction: "left" | "right" }

  // Terminal
  | { type: "RESIZE"; rows: number; cols: number }

  // Model info and token tracking
  | { type: "SET_MODEL_INFO"; modelInfo: ModelInfo }
  | { type: "ADD_PLANNER_TOKENS"; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { type: "ADD_GENERATION_TOKENS"; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { type: "RESET_TOKEN_COUNTS" };

// Link item for navigable links in detail sections
export type DetailLink = {
  id: string;           // Entity ID (for canon entities) or node ID (e.g., "burg:42")
  name: string;         // Display name
  kind: EntityKind;     // Entity type for color coding
  relationType?: string; // Relation type (e.g., "leads", "member_of")
};

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
  callback?: "execute_command" | "navigate_to_entity" | "sync_browse_state" | "quit" | "execute_approved_generation" | "execute_approved_modification" | "execute_approved_simulation" | "execute_approved_world_generation" | "execute_approved_description_generation" | "toggle_current_section" | "navigate_to_search_result" | "execute_onboarding" | "navigate_to_detail_link" | "detail_move_down" | "detail_move_up" | "rebuild_tree_for_tab" | "confirm_field_selection" | "execute_field_regeneration" | "open_plan_in_editor" | "enter_talk_mode" | "exit_talk_mode" | "send_talk_message" | "open_ideas_panel" | "load_ideas" | "submit_idea" | "delete_selected_idea" | "mark_selected_idea_used" | "relabel_selected_idea" | null;
  entityRef?: EntityRef;
};
