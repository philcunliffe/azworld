/**
 * TUI Controller for azbrowse
 *
 * Full-screen terminal user interface with tree navigation and detail panels.
 */

import type { TuiState, TuiAction, TuiCallbacks, TreeNode, EntityKind, ApprovalChoice } from "./types";
import type { EntityRef, BrowseState } from "../state";
import type { AzgaarWorld } from "../../world/azgaar";
import type { CanonStore } from "../../canon/canon";
import type { GenPlan, ModPlan } from "../gen-agent";

import { createInitialTuiState, tuiReducer, dispatchAll, getSelectedNode } from "./state";
import { calculateLayout, isTerminalTooSmall, getMinSizeMessage, type LayoutDimensions } from "./layout";
import { buildTree, getTreeChildren, nodeIdToRef, refToNodeId, expandPathToNode, findPathToNode } from "./tree";
import { renderTreePanelWithBorder } from "./panels/tree-panel";
import { renderDetailPanelWithBorder, getCurrentSectionKey } from "./panels/detail-panel";
import { overlayModal } from "./panels/modal";
import { overlaySearchModal } from "./panels/search-modal";
import { performSearch } from "./search";
import { handleKeypress, parseKeyBuffer, getModeHelpText } from "./keybindings";
import {
  CSI,
  RESET,
  BOLD,
  DIM,
  REVERSE,
  FG_CYAN,
  FG_YELLOW,
  FG_GREEN,
  enterAltScreen,
  exitAltScreen,
  hideCursor,
  showCursor,
  moveTo,
  clearScreen,
  padRight,
} from "./renderer";
import { executeCommand, executePendingGeneration, executePendingModification, type CommandContext } from "../commands";
import { currentRef, navigateTo, setStack, stackToPath } from "../state";
import { debugLog } from "../../chat/debug-log";

/**
 * Format token count for display (e.g., 1234 -> "1.2k", 999 -> "999")
 */
function formatTokens(n: number): string {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1) + "m";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "k";
  }
  return String(n);
}

export type TuiControllerOptions = {
  world: AzgaarWorld;
  canon: CanonStore;
  browseState: BrowseState;
  commandContext: CommandContext;
  useColors?: boolean;
  onQuit?: () => void;
  onNavigate?: (ref: EntityRef) => void;
};

/**
 * TUI Controller class
 *
 * Manages the full-screen TUI lifecycle.
 */
export class TuiController {
  private state: TuiState;
  private layout: LayoutDimensions;
  private isRunning = false;
  private stdin: typeof process.stdin;
  private wasRawMode = false;
  private pendingPlan: GenPlan | null = null;  // Generation plan awaiting user approval
  private pendingModPlan: ModPlan | null = null;  // Modification plan awaiting user approval
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;  // Search debounce timer

  constructor(private options: TuiControllerOptions) {
    this.state = createInitialTuiState();
    this.layout = calculateLayout(
      process.stdout.rows || 24,
      process.stdout.columns || 80
    );
    this.stdin = process.stdin;

    // Initialize model info for footer display
    const genLlm = this.options.commandContext.generationLlm || this.options.commandContext.llm;
    this.dispatch({
      type: "SET_MODEL_INFO",
      modelInfo: {
        plannerProvider: this.options.commandContext.llm.provider,
        plannerModel: this.options.commandContext.llm.model,
        generationProvider: genLlm.provider,
        generationModel: genLlm.model,
      },
    });

    // Initialize tree with current navigation state
    this.initializeTree();
  }

  /**
   * Initialize tree from current browse state
   */
  private initializeTree(): void {
    const { world, canon, browseState } = this.options;

    // Expand nodes based on current navigation stack
    const currentNodeId = this.getCurrentNodeId();
    if (currentNodeId) {
      this.state.expandedNodes = expandPathToNode(
        currentNodeId,
        this.state.expandedNodes,
        world,
        canon
      );
    }

    // Always expand world root
    this.state.expandedNodes.add("world");

    // Build tree
    const nodes = buildTree(world, canon, this.state.expandedNodes, currentNodeId);
    this.dispatch({ type: "SET_TREE_NODES", nodes });

    // Select current node
    if (currentNodeId) {
      this.dispatch({ type: "SELECT_NODE", id: currentNodeId });
    }
  }

  /**
   * Get node ID from current browse state
   */
  private getCurrentNodeId(): string | null {
    const ref = currentRef(this.options.browseState);
    return refToNodeId(ref);
  }

  /**
   * Dispatch action to update state
   */
  private dispatch(action: TuiAction): void {
    this.state = tuiReducer(this.state, action);
  }

  /**
   * Dispatch multiple actions
   */
  private dispatchMany(actions: TuiAction[]): void {
    this.state = dispatchAll(this.state, actions);
  }

  /**
   * Start the TUI
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Check terminal size
    if (isTerminalTooSmall(process.stdout.rows || 24, process.stdout.columns || 80)) {
      console.error(getMinSizeMessage());
      return;
    }

    // Enter alternate screen and hide cursor
    process.stdout.write(enterAltScreen());
    process.stdout.write(hideCursor());

    // Setup raw mode
    if (process.stdin.isTTY) {
      this.wasRawMode = process.stdin.isRaw;
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Handle resize
    const handleResize = () => {
      this.layout = calculateLayout(
        process.stdout.rows || 24,
        process.stdout.columns || 80
      );
      this.dispatch({
        type: "RESIZE",
        rows: this.layout.terminalRows,
        cols: this.layout.terminalCols,
      });
      this.render();
    };
    process.stdout.on("resize", handleResize);

    // Handle input
    const handleInput = async (data: Buffer) => {
      await this.handleInput(data);
    };
    process.stdin.on("data", handleInput);

    // Initial render
    this.render();

    // Wait for quit
    return new Promise((resolve) => {
      const checkQuit = setInterval(() => {
        if (!this.isRunning) {
          clearInterval(checkQuit);

          // Cleanup
          process.stdin.removeListener("data", handleInput);
          process.stdout.removeListener("resize", handleResize);

          if (process.stdin.isTTY) {
            process.stdin.setRawMode(this.wasRawMode);
          }
          process.stdin.pause();

          // Exit alternate screen and show cursor
          process.stdout.write(showCursor());
          process.stdout.write(exitAltScreen());

          resolve();
        }
      }, 100);
    });
  }

  /**
   * Stop the TUI
   */
  stop(): void {
    this.isRunning = false;
    this.options.onQuit?.();
  }

  /**
   * Handle keyboard input
   */
  private async handleInput(data: Buffer): Promise<void> {
    const key = parseKeyBuffer(data);
    const result = handleKeypress(key, this.state);

    // Apply actions
    if (result.actions.length > 0) {
      this.dispatchMany(result.actions);
    }

    // Handle callbacks
    if (result.callback === "quit") {
      this.stop();
      return;
    }

    if (result.callback === "execute_command") {
      await this.executeCommand(this.state.commandBuffer);
      this.dispatch({ type: "CLEAR_COMMAND" });
    }

    if (result.callback === "navigate_to_entity" && result.entityRef) {
      this.navigateToEntity(result.entityRef);
    }

    if (result.callback === "sync_browse_state") {
      // Sync browse state to match tree selection (after MOVE_SELECTION action is applied)
      this.syncBrowseStateToSelection();
    }

    if (result.callback === "execute_approved_generation") {
      await this.executeApprovedGeneration();
    }

    if (result.callback === "execute_approved_modification") {
      this.executeApprovedModification();
    }

    if (result.callback === "toggle_current_section") {
      const sectionKey = getCurrentSectionKey(this.state, this.options.world, this.options.canon);
      if (sectionKey) {
        this.dispatch({ type: "TOGGLE_DETAIL_SECTION", sectionKey });
      }
    }

    if (result.callback === "navigate_to_search_result") {
      this.navigateToSearchResult();
    }

    // Trigger search with debounce when query changes
    if (result.actions.some(a =>
      a.type === "INSERT_SEARCH_CHAR" ||
      a.type === "BACKSPACE_SEARCH"
    )) {
      this.scheduleSearch();
    }

    // Rebuild tree if nodes were expanded/collapsed
    if (result.actions.some(a => a.type === "EXPAND_NODE" || a.type === "COLLAPSE_NODE" || a.type === "TOGGLE_NODE")) {
      await this.rebuildTree();
    }

    this.render();
  }

  /**
   * Execute a command
   */
  private async executeCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) return;

    // Check for special TUI commands
    if (trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
      this.stop();
      return;
    }

    // Check if this is a gen command (but not simplegen) - show planning modal immediately
    const isGenCommand = /^gen\s+(location|npc|faction)/i.test(trimmed);
    // Check if this is a mod command - show planning modal immediately
    const isModCommand = /^mod\s+/i.test(trimmed);

    if (isGenCommand) {
      // Reset token counts for new generation command
      this.dispatch({ type: "RESET_TOKEN_COUNTS" });
      this.dispatch({ type: "SHOW_PLANNING_MODAL", title: "Creating Generation Plan" });
      this.render();
    } else if (isModCommand) {
      // Reset token counts for new modification command
      this.dispatch({ type: "RESET_TOKEN_COUNTS" });
      this.dispatch({ type: "SHOW_PLANNING_MODAL", title: "Creating Modification Plan" });
      this.render();
    }

    try {
      // Create TUI-aware command context
      const tuiContext: CommandContext = {
        ...this.options.commandContext,
        tuiMode: true,  // Signal gen/mod commands to return plans instead of console output
        onEntityStart: (name, index, total) => {
          this.updateGenerationProgress(`[${index + 1}/${total}] Generating: ${name}...`);
        },
        onEntityComplete: (entity, index, total, tokens, elapsedMs) => {
          if (entity.id) {
            // Map entity type to EntityKind
            const kindMap: Record<string, EntityKind> = {
              location: "location",
              npc: "npc",
              faction: "faction",
              event: "event",
            };
            const kind = kindMap[entity.type] || "location";
            this.addGeneratedEntity(entity.id, entity.name, kind);
          }
        },
        // Track planner tokens during planning phase
        onTokens: (isGenCommand || isModCommand) ? (usage) => {
          this.dispatch({ type: "ADD_PLANNER_TOKENS", usage });
          this.render();
        } : this.options.commandContext.onTokens,
      };

      // Execute via command context
      const result = await executeCommand(trimmed, tuiContext);

      if (result.quit) {
        this.stop();
        return;
      }

      if (result.error) {
        // Show error in modal (only if we're still in modal mode, i.e., user didn't cancel)
        if ((isGenCommand || isModCommand) && this.state.mode !== "modal") {
          // User cancelled during planning, don't show error modal
        } else {
          this.dispatch({ type: "SHOW_MODAL", title: "Error" });
          this.dispatch({ type: "MODAL_ERROR", error: result.error });
        }
      } else if (result.pendingGeneration) {
        // Show approval modal for gen command (only if we're still in modal mode, i.e., user didn't cancel)
        if ((isGenCommand || isModCommand) && this.state.mode !== "modal") {
          // User cancelled during planning, don't show approval modal
        } else {
          this.pendingPlan = result.pendingGeneration.plan;
          const planText = result.pendingGeneration.formattedPlan;
          // Debug: log if plan text is unexpectedly empty
          if (!planText) {
            debugLog(`[TUI] formattedPlan is empty/undefined. hasFormattedPlan: ${"formattedPlan" in result.pendingGeneration}, type: ${typeof planText}`);
          }
          this.dispatch({
            type: "SHOW_APPROVAL_MODAL",
            title: "Generation Plan",
            choices: [
              { label: "Create", value: "create", hint: "Generate the planned entities" },
              { label: "Cancel", value: "cancel", hint: "Abort without creating anything" },
            ],
            planText: planText || "(Plan text missing - see debug log)",
          });
        }
      } else if (result.pendingModification) {
        // Show approval modal for mod command
        this.pendingModPlan = result.pendingModification.plan;
        const planText = result.pendingModification.formattedPlan;
        if (!planText) {
          debugLog(`[TUI] mod formattedPlan is empty/undefined`);
        }
        this.dispatch({
          type: "SHOW_APPROVAL_MODAL",
          title: "Modification Plan",
          choices: [
            { label: "Apply", value: "apply", hint: "Apply the modifications" },
            { label: "Cancel", value: "cancel", hint: "Abort without changing anything" },
          ],
          planText: planText || "(Plan text missing - see debug log)",
        });
      }

      // Sync tree state after command - rebuild first, then sync selection
      await this.rebuildTree();

      // Sync tree selection to match browse state (e.g., after "loc FOO" command)
      this.syncTreeSelectionToBrowseState();

    } catch (e: any) {
      this.dispatch({ type: "SHOW_MODAL", title: "Error" });
      this.dispatch({ type: "MODAL_ERROR", error: e?.message || String(e) });
    }
  }

  /**
   * Execute pending generation after user approval
   */
  private async executeApprovedGeneration(): Promise<void> {
    if (!this.pendingPlan) return;

    const plan = this.pendingPlan;
    this.pendingPlan = null;

    // Switch modal to progress mode
    this.dispatch({ type: "SHOW_MODAL", title: "Generating..." });

    try {
      // Create context with TUI callbacks
      const tuiContext: CommandContext = {
        ...this.options.commandContext,
        tuiMode: true,
        onEntityStart: (name, index, total) => {
          this.updateGenerationProgress(`[${index + 1}/${total}] Generating: ${name}...`);
        },
        onEntityComplete: (entity, index, total, tokens, elapsedMs) => {
          if (entity.id) {
            const kindMap: Record<string, EntityKind> = {
              location: "location",
              npc: "npc",
              faction: "faction",
              event: "event",
            };
            const kind = kindMap[entity.type] || "location";
            this.addGeneratedEntity(entity.id, entity.name, kind);
          }
        },
        // Track generation tokens during generation phase
        onTokens: (usage) => {
          this.dispatch({ type: "ADD_GENERATION_TOKENS", usage });
          this.render();
        },
      };

      const result = await executePendingGeneration(plan, tuiContext);

      if (result.error) {
        this.dispatch({ type: "MODAL_ERROR", error: result.error });
      } else {
        this.completeGeneration();
        await this.rebuildTree();
        this.syncTreeSelectionToBrowseState();
      }
    } catch (e: any) {
      this.dispatch({ type: "MODAL_ERROR", error: e?.message || String(e) });
    }
  }

  /**
   * Execute pending modification after user approval
   */
  private executeApprovedModification(): void {
    if (!this.pendingModPlan) return;

    const plan = this.pendingModPlan;
    this.pendingModPlan = null;

    try {
      const result = executePendingModification(plan, this.options.commandContext);

      if (result.error) {
        this.dispatch({ type: "SHOW_MODAL", title: "Error" });
        this.dispatch({ type: "MODAL_ERROR", error: result.error });
      } else {
        // Close modal and show success
        this.dispatch({ type: "CLOSE_MODAL" });
        // Rebuild tree to reflect any name changes
        this.rebuildTree();
      }
    } catch (e: any) {
      this.dispatch({ type: "SHOW_MODAL", title: "Error" });
      this.dispatch({ type: "MODAL_ERROR", error: e?.message || String(e) });
    }
  }

  /**
   * Schedule a search with debouncing
   */
  private scheduleSearch(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    this.searchDebounceTimer = setTimeout(() => {
      this.executeSearch();
    }, 150); // 150ms debounce
  }

  /**
   * Execute the search and update results
   */
  private executeSearch(): void {
    const query = this.state.search?.query || "";
    const results = performSearch(
      query,
      this.options.world,
      this.options.canon,
      20
    );

    this.dispatch({ type: "SET_SEARCH_RESULTS", results });
    this.render();
  }

  /**
   * Navigate to the selected search result
   */
  private navigateToSearchResult(): void {
    if (!this.state.search?.results.length) return;

    const result = this.state.search.results[this.state.search.selectedIndex];
    if (!result) return;

    // Close search modal
    this.dispatch({ type: "CLOSE_SEARCH" });

    // Parse result ID to EntityRef and navigate
    const ref = nodeIdToRef(result.id);
    this.navigateToEntity(ref);
  }

  /**
   * Navigate to an entity (used when pressing Enter on a node)
   */
  private navigateToEntity(ref: EntityRef): void {
    navigateTo(this.options.browseState, ref);
    this.options.onNavigate?.(ref);

    // Update tree selection
    const nodeId = refToNodeId(ref);
    this.state.expandedNodes = expandPathToNode(
      nodeId,
      this.state.expandedNodes,
      this.options.world,
      this.options.canon
    );
    this.rebuildTree();
    this.dispatch({ type: "SELECT_NODE", id: nodeId });
  }

  /**
   * Sync browse state to match current tree selection
   * Called after MOVE_SELECTION to keep browse context in sync with tree highlight
   */
  private syncBrowseStateToSelection(): void {
    const selected = getSelectedNode(this.state);
    if (!selected) return;

    // Only update if it's actually different to avoid history spam
    const currentBrowseRef = currentRef(this.options.browseState);
    if (refToNodeId(currentBrowseRef) === selected.id) return;

    // Build the correct path from root to selected node
    const { world, canon } = this.options;
    const pathNodeIds = findPathToNode(selected.id, world, canon);
    const newStack = pathNodeIds.map(nodeId => nodeIdToRef(nodeId));

    // Replace the entire stack with the correct path
    setStack(this.options.browseState, newStack);

    const ref = nodeIdToRef(selected.id);
    this.options.onNavigate?.(ref);
  }

  /**
   * Sync tree selection to match current browse state
   * Called after executing commands that change navigation
   */
  private syncTreeSelectionToBrowseState(): void {
    const ref = currentRef(this.options.browseState);
    const nodeId = refToNodeId(ref);

    // Only update if different
    if (this.state.selectedNodeId !== nodeId) {
      // Expand path to make sure node is visible
      this.state.expandedNodes = expandPathToNode(
        nodeId,
        this.state.expandedNodes,
        this.options.world,
        this.options.canon
      );
      this.rebuildTree();
      this.dispatch({ type: "SELECT_NODE", id: nodeId });
    }
  }

  /**
   * Rebuild the tree from scratch
   */
  private async rebuildTree(): Promise<void> {
    const { world, canon } = this.options;
    const nodes = buildTree(world, canon, this.state.expandedNodes, this.state.selectedNodeId);
    this.dispatch({ type: "SET_TREE_NODES", nodes });
  }

  /**
   * Show generation modal
   */
  showGenerationModal(title: string): void {
    this.dispatch({ type: "SHOW_MODAL", title });
    this.render();
  }

  /**
   * Update generation progress
   */
  updateGenerationProgress(message: string): void {
    this.dispatch({ type: "UPDATE_MODAL_PROGRESS", progress: message });
    this.render();
  }

  /**
   * Add entity to modal
   */
  addGeneratedEntity(id: string, name: string, kind: EntityKind): void {
    this.dispatch({ type: "ADD_MODAL_ENTITY", entity: { id, name, kind } });
    this.render();
  }

  /**
   * Complete generation modal
   */
  completeGeneration(): void {
    this.dispatch({ type: "COMPLETE_MODAL" });
    this.rebuildTree();
    this.render();
  }

  /**
   * Render the full screen
   */
  private render(): void {
    if (!this.isRunning) return;

    const { world, canon } = this.options;
    const lines: string[] = [];

    // Header
    const headerLeft = ` azbrowse`;
    const headerRight = `${this.options.browseState ? stackToPath(this.options.browseState, world, canon) : "~"} `;
    const headerPadding = this.layout.terminalCols - headerLeft.length - headerRight.length;
    lines.push(
      `${BOLD}${FG_CYAN}${headerLeft}${RESET}${" ".repeat(Math.max(0, headerPadding))}${DIM}${headerRight}${RESET}`
    );

    // Render panels side by side
    const treeLines = renderTreePanelWithBorder(this.state, this.layout, this.state.focus === "tree");
    const detailResult = renderDetailPanelWithBorder(this.state, this.layout, world, canon, this.state.focus === "detail");
    const detailLines = detailResult.lines;

    // Update section count if changed
    if (detailResult.sectionCount !== this.state.detailSectionCount) {
      this.dispatch({ type: "SET_DETAIL_SECTION_COUNT", count: detailResult.sectionCount });
    }

    // Combine panels horizontally
    for (let i = 0; i < Math.max(treeLines.length, detailLines.length); i++) {
      const treeLine = treeLines[i] || " ".repeat(this.layout.treeWidth);
      const detailLine = detailLines[i] || " ".repeat(this.layout.detailWidth);
      lines.push(treeLine + detailLine);
    }

    // Footer - status bar with model info and token counts
    const mode = this.state.mode;
    const modeIndicator = mode === "command" ? `${FG_YELLOW}COMMAND${RESET}` :
                          mode === "modal" ? `${FG_GREEN}MODAL${RESET}` :
                          mode === "search" ? `${FG_YELLOW}SEARCH${RESET}` :
                          `${FG_CYAN}NORMAL${RESET}`;
    const modeText = mode === "command" ? "COMMAND" :
                     mode === "modal" ? "MODAL" :
                     mode === "search" ? "SEARCH" :
                     "NORMAL";
    const helpText = getModeHelpText(this.state.mode, this.state.focus);

    // Format model info with token counts
    let modelInfoStr = "";
    let modelInfoVisualLen = 0;
    if (this.state.modelInfo) {
      const { plannerModel, generationModel } = this.state.modelInfo;
      const { planner, generation } = this.state.tokenCounts;

      // Truncate model names for narrow terminals
      const maxModelLen = Math.max(8, Math.floor((this.layout.terminalCols - 50) / 4));
      const pModel = plannerModel.length > maxModelLen ? plannerModel.slice(0, maxModelLen - 1) + "…" : plannerModel;
      const gModel = generationModel.length > maxModelLen ? generationModel.slice(0, maxModelLen - 1) + "…" : generationModel;
      const pTokens = formatTokens(planner.totalTokens);
      const gTokens = formatTokens(generation.totalTokens);

      modelInfoStr = `${DIM}P:${RESET}${pModel}${DIM}[${pTokens}]${RESET}  ${DIM}G:${RESET}${gModel}${DIM}[${gTokens}]${RESET}`;
      // Visual length: "P:" + model + "[" + tokens + "]" + "  " + "G:" + model + "[" + tokens + "]"
      modelInfoVisualLen = 2 + pModel.length + 1 + pTokens.length + 1 + 2 + 2 + gModel.length + 1 + gTokens.length + 1;
    }

    // Calculate available space and padding
    // Layout: " MODE  <padding1>  modelInfo  <padding2>  helpText "
    const usedSpace = 1 + modeText.length + 1 + modelInfoVisualLen + helpText.length + 1;
    const availablePadding = Math.max(0, this.layout.terminalCols - usedSpace);
    const padding1 = Math.floor(availablePadding / 2);
    const padding2 = availablePadding - padding1;

    lines.push(
      ` ${modeIndicator}${" ".repeat(Math.max(1, padding1))}${modelInfoStr}${" ".repeat(Math.max(1, padding2))}${DIM}${helpText}${RESET} `
    );

    // Command line
    if (this.state.mode === "command") {
      // Show command with block cursor at cursor position
      const before = this.state.commandBuffer.slice(0, this.state.commandCursorPos);
      const cursorChar = this.state.commandBuffer[this.state.commandCursorPos] ?? " ";
      const after = this.state.commandBuffer.slice(this.state.commandCursorPos + 1);
      // Use reverse video for cursor character
      lines.push(`:${before}${REVERSE}${cursorChar}${RESET}${after}`);
    } else {
      lines.push("");
    }

    // Apply modal overlay if visible
    let screenLines = lines;
    if (this.state.modal?.visible) {
      screenLines = overlayModal(lines, this.state.modal, this.layout);
    }

    // Apply search modal overlay if visible
    if (this.state.search?.visible) {
      screenLines = overlaySearchModal(screenLines, this.state.search, this.layout);
    }

    // Render to screen
    let output = clearScreen();
    for (let i = 0; i < this.layout.terminalRows; i++) {
      const line = screenLines[i] ?? "";
      output += moveTo(i + 1, 1) + padRight(line, this.layout.terminalCols);
    }

    // Position cursor for command mode
    if (this.state.mode === "command") {
      // Position at cursor location (+1 for ':' prefix, +1 for 1-based column)
      output += moveTo(this.layout.terminalRows, 2 + this.state.commandCursorPos);
      output += showCursor();
    } else {
      output += hideCursor();
    }

    process.stdout.write(output);
  }
}

/**
 * Create and start TUI controller
 */
export async function startTui(options: TuiControllerOptions): Promise<void> {
  const controller = new TuiController(options);
  await controller.start();
}

// Re-export types
export * from "./types";
export * from "./state";
export * from "./layout";
export * from "./tree";
