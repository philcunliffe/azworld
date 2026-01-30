/**
 * TUI Controller for azbrowse
 *
 * Full-screen terminal user interface with tree navigation and detail panels.
 */

import type { TuiState, TuiAction, TuiCallbacks, TreeNode, EntityKind, ApprovalChoice, FieldSelectionState } from "./types";
import type { EntityRef, BrowseState } from "../state";
import type { AzgaarWorld } from "../../world/azgaar";
import type { CanonStore } from "../../canon/canon";
import type { GenPlan, ModPlan, FieldRegenPlan } from "../gen-agent";

import { createInitialTuiState, tuiReducer, dispatchAll, getSelectedNode } from "./state";
import { calculateLayout, isTerminalTooSmall, getMinSizeMessage, type LayoutDimensions } from "./layout";
import { buildTree, getTreeChildren, nodeIdToRef, refToNodeId, expandPathToNode, findPathToNode, buildFactionsList, buildReligionsList, buildCulturesList } from "./tree";
import { renderTreePanelWithBorder } from "./panels/tree-panel";
import { renderDetailPanelWithBorder, getCurrentSectionKey, getCurrentSectionLinks, isCurrentSectionLinksExpanded } from "./panels/detail-panel";
import { overlayModal } from "./panels/modal";
import { overlaySearchModal } from "./panels/search-modal";
import { overlayOnboardingModal } from "./panels/onboarding-modal";
import { overlayHelpModal } from "./panels/help-modal";
import { overlayFieldSelectionModal } from "./panels/field-selection-modal";
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
import { executeCommand, executePendingGeneration, executePendingModification, planFieldRegen, executePendingFieldRegeneration, executePendingDescriptionGeneration, type CommandContext } from "../commands";
import type { DescriptionPlan } from "../gen-agent";
import { currentRef, navigateTo, setStack, stackToPath } from "../state";
import { debugLog } from "../../chat/debug-log";
import { saveCampaignSettings, type GenerationFlags } from "../../chat/campaign-settings";
import {
  planReligionGeneration,
  planCultureGeneration,
  planStateGeneration,
  executePhasePlan,
  formatPhasePlan,
  type WorldGenContext,
  type PhasePlan,
} from "../world-init-gen";
import type { CampaignSettings } from "../../chat/schema";

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
  private pendingFieldRegenPlan: FieldRegenPlan | null = null;  // Field regeneration plan awaiting user approval
  private pendingDescriptionPlan: DescriptionPlan | null = null;  // Description plan awaiting approval
  private pendingPhasePlan: PhasePlan | null = null;  // Phase-specific plan awaiting approval
  private pendingPhaseCtx: WorldGenContext | null = null;  // Context for phase generation
  private pendingPhaseFlags: GenerationFlags | null = null;  // Flags for which phases to run
  private pendingPhaseCampaignSettings: CampaignSettings | null = null;  // Campaign settings for phases
  private pendingStateFilter: number[] | undefined = undefined;  // State filter for generation
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;  // Search debounce timer
  private talkMode = false;  // NPC talk mode
  private talkScene: import("../../chat/director").SceneContext | undefined;  // Scene context for talk mode

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

    if (result.callback === "execute_approved_world_generation") {
      await this.executeApprovedWorldGeneration();
    }

    if (result.callback === "execute_approved_description_generation") {
      await this.executeApprovedDescriptionGeneration();
    }

    if (result.callback === "toggle_current_section") {
      const sectionKey = getCurrentSectionKey(this.state, this.options.world, this.options.canon);
      if (sectionKey) {
        this.dispatch({ type: "TOGGLE_DETAIL_SECTION", sectionKey });
      }
    }

    if (result.callback === "navigate_to_detail_link") {
      // Check if current section has links and is expanded
      if (isCurrentSectionLinksExpanded(this.state, this.options.world, this.options.canon)) {
        const links = getCurrentSectionLinks(this.state, this.options.world, this.options.canon);
        if (links?.length) {
          // Clamp link index and navigate
          const linkIndex = Math.min(this.state.detailLinkIndex, links.length - 1);
          const link = links[linkIndex];
          if (link) {
            this.navigateToLink(link);
          }
        }
      } else {
        // Not on a links section or not expanded - toggle the section instead
        const sectionKey = getCurrentSectionKey(this.state, this.options.world, this.options.canon);
        if (sectionKey) {
          this.dispatch({ type: "TOGGLE_DETAIL_SECTION", sectionKey });
        }
      }
    }

    if (result.callback === "detail_move_down") {
      // Check if current section has links and is expanded
      if (isCurrentSectionLinksExpanded(this.state, this.options.world, this.options.canon)) {
        const links = getCurrentSectionLinks(this.state, this.options.world, this.options.canon);
        if (links?.length) {
          // Move within links, or to next section if at end
          if (this.state.detailLinkIndex < links.length - 1) {
            this.dispatch({ type: "MOVE_DETAIL_LINK", direction: "down" });
          } else {
            // At last link - move to next section
            this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "down" });
            this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
          }
        } else {
          // No links, move to next section
          this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "down" });
          this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
        }
      } else {
        // Not on expanded links section - move between sections
        this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "down" });
        this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
      }
    }

    if (result.callback === "detail_move_up") {
      // Check if current section has links and is expanded
      if (isCurrentSectionLinksExpanded(this.state, this.options.world, this.options.canon)) {
        const links = getCurrentSectionLinks(this.state, this.options.world, this.options.canon);
        if (links?.length) {
          // Move within links, or to previous section if at start
          if (this.state.detailLinkIndex > 0) {
            this.dispatch({ type: "MOVE_DETAIL_LINK", direction: "up" });
          } else {
            // At first link - move to previous section
            this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "up" });
            this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
          }
        } else {
          // No links, move to previous section
          this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "up" });
          this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
        }
      } else {
        // Not on expanded links section - move between sections
        this.dispatch({ type: "MOVE_DETAIL_SECTION", direction: "up" });
        this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
      }
    }

    if (result.callback === "navigate_to_search_result") {
      this.navigateToSearchResult();
    }

    if (result.callback === "execute_onboarding") {
      await this.executeOnboarding();
    }

    if (result.callback === "rebuild_tree_for_tab") {
      this.rebuildTreeForTab();
    }

    if (result.callback === "confirm_field_selection") {
      await this.confirmFieldSelection();
    }

    if (result.callback === "execute_field_regeneration") {
      await this.executeFieldRegeneration();
    }

    if (result.callback === "open_plan_in_editor") {
      await this.openPlanInEditor();
    }

    if (result.callback === "enter_talk_mode") {
      await this.handleEnterTalkMode();
    }

    if (result.callback === "exit_talk_mode") {
      this.exitTalkMode();
    }

    if (result.callback === "send_talk_message") {
      const message = this.state.commandBuffer;
      this.dispatch({ type: "CLEAR_COMMAND" });
      await this.sendTalkMessage(message);
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

    // Load state list when entering stateSelection step (via confirm, next/tab, or going back)
    if (result.actions.some(a =>
        a.type === "ONBOARDING_CONFIRM_STEP" ||
        a.type === "ONBOARDING_NEXT_STEP" ||
        a.type === "ONBOARDING_PREV_STEP"
      ) && this.state.onboarding?.currentStep === "stateSelection") {
      this.loadOnboardingStateList();
    }

    this.render();
  }

  /**
   * Load state list for onboarding stateSelection step
   */
  private loadOnboardingStateList(): void {
    const states = this.options.world.listStates().map(s => ({
      id: s.id,
      name: s.name,
    }));
    this.dispatch({ type: "SET_ONBOARDING_STATE_LIST", states });
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

    // Handle :help command by opening help modal
    if (trimmed === "help" || trimmed === "?" || trimmed === "/help") {
      this.dispatch({ type: "OPEN_HELP" });
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
            entities: result.pendingGeneration.plan.entities,
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
      } else if (result.runOnboarding) {
        // Open onboarding wizard
        this.dispatch({ type: "OPEN_ONBOARDING" });
      } else if (result.showFieldSelection) {
        // Open field selection modal for :gen on existing entity
        const { entityId, entityType, entityName, hint, coreFields, payloadFields } = result.showFieldSelection;
        this.dispatch({
          type: "OPEN_FIELD_SELECTION",
          entityId,
          entityType,
          entityName,
          coreFields,
          payloadFields,
          hint,
        });
      } else if (result.pendingDescriptionGeneration) {
        // Show approval modal for description generation
        this.pendingDescriptionPlan = result.pendingDescriptionGeneration.plan;
        const planText = result.pendingDescriptionGeneration.formattedPlan;
        this.dispatch({
          type: "SHOW_APPROVAL_MODAL",
          title: "Description Generation Plan",
          choices: [
            { label: "Generate", value: "generate", hint: "Generate the description" },
            { label: "Cancel", value: "cancel", hint: "Abort without generating" },
          ],
          planText: planText || "(Plan text missing)",
        });
      } else if (result.enterTalkMode) {
        // Enter talk mode with current NPC
        await this.enterTalkModeWithNpc();
        return;
      } else if (result.exitTalkMode) {
        // Exit talk mode
        this.exitTalkMode();
        return;
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

    // Copy edited entities back to the plan
    if (this.state.modal?.pendingEntities) {
      this.pendingPlan = {
        ...this.pendingPlan,
        entities: this.state.modal.pendingEntities as any,
      };
    }

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
   * Execute pending description generation after user approval
   */
  private async executeApprovedDescriptionGeneration(): Promise<void> {
    if (!this.pendingDescriptionPlan) return;

    const plan = this.pendingDescriptionPlan;
    this.pendingDescriptionPlan = null;

    // Switch modal to progress mode
    this.dispatch({ type: "SHOW_MODAL", title: "Generating Description..." });

    try {
      // Create context with TUI callbacks
      const tuiContext: CommandContext = {
        ...this.options.commandContext,
        tuiMode: true,
        onEntityStart: (name, index, total) => {
          this.updateGenerationProgress(`Generating: ${name}...`);
        },
        onEntityComplete: (entity, index, total, tokens, elapsedMs) => {
          if (entity.id) {
            this.addGeneratedEntity(entity.id, entity.name, "location");  // Use "location" as EntityKind for meta
          }
        },
        onTokens: (usage) => {
          this.dispatch({ type: "ADD_GENERATION_TOKENS", usage });
          this.render();
        },
      };

      const result = await executePendingDescriptionGeneration(plan, tuiContext);

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
   * Execute onboarding wizard completion - starts phase-by-phase generation
   */
  private async executeOnboarding(): Promise<void> {
    if (!this.state.onboarding) return;

    const { settings, generate } = this.state.onboarding;
    const selectedIndex = this.state.onboarding.selectedIndex;

    // Close the onboarding modal first
    this.dispatch({ type: "CLOSE_ONBOARDING" });

    // Check if user selected "Cancel" (index 2)
    if (selectedIndex === 2) {
      return;
    }

    // Save campaign settings if any were provided
    const hasSettings = Object.values(settings).some(v => v !== undefined);
    if (hasSettings) {
      try {
        saveCampaignSettings(this.options.canon, settings as CampaignSettings);
        // Update the command context with new settings
        this.options.commandContext.campaignSettings = settings as CampaignSettings;
      } catch (e: any) {
        this.dispatch({ type: "SHOW_MODAL", title: "Error" });
        this.dispatch({ type: "MODAL_ERROR", error: `Failed to save settings: ${e?.message || String(e)}` });
        return;
      }
    }

    // Check if user selected "Save Only" (index 1)
    if (selectedIndex === 1) {
      return;
    }

    // User selected "Save & Generate" (index 0) - start phase-by-phase generation
    const { contentTypes, scope, selectedStateIds } = generate;
    const hasGeneration = contentTypes.religions || contentTypes.cultures || contentTypes.states;
    if (!hasGeneration) {
      return;
    }

    // Convert new generate structure to GenerationFlags format
    const legacyFlags: GenerationFlags = {
      religions: contentTypes.religions,
      cultures: contentTypes.cultures,
      states: contentTypes.states,
    };

    // Store flags and settings for use across phases
    this.pendingPhaseFlags = legacyFlags;
    this.pendingPhaseCampaignSettings = settings as CampaignSettings;

    // Set state filter if user selected specific states
    if (scope === "selectedStates" && selectedStateIds.length > 0) {
      this.pendingStateFilter = selectedStateIds;
    } else {
      this.pendingStateFilter = undefined;
    }

    // Reset token counts for new generation session
    this.dispatch({ type: "RESET_TOKEN_COUNTS" });

    // Start with the first selected phase
    await this.startNextPhase();
  }

  /**
   * Determine and start the next phase based on remaining flags
   */
  private async startNextPhase(): Promise<void> {
    if (!this.pendingPhaseFlags) {
      // All done
      return;
    }

    const flags = this.pendingPhaseFlags;

    // Determine next phase: religions -> cultures -> states
    let nextPhase: "religions" | "cultures" | "states" | null = null;
    if (flags.religions) {
      nextPhase = "religions";
    } else if (flags.cultures) {
      nextPhase = "cultures";
    } else if (flags.states) {
      nextPhase = "states";
    }

    if (!nextPhase) {
      // All phases complete
      this.pendingPhaseFlags = null;
      this.pendingPhaseCampaignSettings = null;
      return;
    }

    // Plan this phase
    await this.planPhase(nextPhase);
  }

  /**
   * Plan a specific phase and show approval modal
   */
  private async planPhase(phase: "religions" | "cultures" | "states"): Promise<void> {
    const phaseTitle = phase.charAt(0).toUpperCase() + phase.slice(1);
    this.dispatch({ type: "SHOW_PLANNING_MODAL", title: `Planning ${phaseTitle}` });
    this.render();

    const plannerLlm = this.options.commandContext.llm;
    const planCtx: WorldGenContext = {
      world: this.options.world,
      canon: this.options.canon,
      llm: plannerLlm,
      campaignSettings: this.pendingPhaseCampaignSettings || undefined,
      stateFilter: this.pendingStateFilter,  // Pass state filter for filtering
      onProgress: (message) => {
        this.updateGenerationProgress(message);
      },
      onPlanProgress: (message) => {
        this.updateGenerationProgress(message);
      },
      onTokens: (usage) => {
        this.dispatch({ type: "ADD_PLANNER_TOKENS", usage: usage as any });
        this.render();
      },
    };

    let plan: PhasePlan;
    try {
      debugLog(`[TUI] Planning ${phase}...`);
      if (phase === "religions") {
        plan = await planReligionGeneration(planCtx);
      } else if (phase === "cultures") {
        plan = await planCultureGeneration(planCtx);
      } else {
        plan = await planStateGeneration(planCtx);
      }
      debugLog(`[TUI] ${phase} plan returned, entities: ${plan.entities.length}`);
    } catch (e: any) {
      debugLog(`[TUI] ${phase} planning failed: ${e?.message || String(e)}`);
      this.dispatch({ type: "MODAL_ERROR", error: `Planning failed: ${e?.message || String(e)}` });
      this.render();
      return;
    }

    // Store the plan for later execution
    this.pendingPhasePlan = plan;

    // Create generation context for execution
    const genLlm = this.options.commandContext.generationLlm || this.options.commandContext.llm;
    this.pendingPhaseCtx = {
      world: this.options.world,
      canon: this.options.canon,
      llm: genLlm,
      campaignSettings: this.pendingPhaseCampaignSettings || undefined,
      stateFilter: this.pendingStateFilter,  // Pass state filter for filtering
      onProgress: (message) => {
        this.updateGenerationProgress(message);
      },
      onPlanProgress: (message) => {
        this.updateGenerationProgress(message);
      },
      onEntityStart: (name, index, total) => {
        this.updateGenerationProgress(`[${index + 1}/${total}] Generating: ${name}...`);
      },
      onEntityComplete: (name, index, total, tokens, elapsedMs) => {
        // Track completed entities
      },
      onTokens: (usage) => {
        this.dispatch({ type: "ADD_GENERATION_TOKENS", usage: usage as any });
        this.render();
      },
    };

    // Show approval modal
    const planText = formatPhasePlan(plan, false);
    this.dispatch({
      type: "SHOW_APPROVAL_MODAL",
      title: `${phaseTitle} Generation Plan`,
      choices: [
        { label: "Generate", value: "generate", hint: `Generate ${phase}` },
        { label: "Skip", value: "skip", hint: `Skip ${phase}, continue to next` },
        { label: "Cancel All", value: "cancel", hint: "Stop generation entirely" },
      ],
      planText,
    });
    this.render();
  }

  /**
   * Execute approved phase generation and move to next phase
   */
  private async executeApprovedWorldGeneration(): Promise<void> {
    if (!this.pendingPhasePlan || !this.pendingPhaseCtx || !this.pendingPhaseFlags) return;

    const plan = this.pendingPhasePlan;
    const genCtx = this.pendingPhaseCtx;
    const flags = this.pendingPhaseFlags;

    // Check which action was selected
    const selectedIndex = this.state.modal?.approvalSelectedIndex ?? 0;

    // Clear pending plan (but keep flags and settings for next phase)
    this.pendingPhasePlan = null;
    this.pendingPhaseCtx = null;

    // Handle "Cancel All" (index 2)
    if (selectedIndex === 2) {
      this.pendingPhaseFlags = null;
      this.pendingPhaseCampaignSettings = null;
      this.dispatch({ type: "CLOSE_MODAL" });
      return;
    }

    // Mark this phase as done in flags
    const currentPhase = plan.phase;
    if (currentPhase === "religions") {
      this.pendingPhaseFlags = { ...flags, religions: false };
    } else if (currentPhase === "cultures") {
      this.pendingPhaseFlags = { ...flags, cultures: false };
    } else if (currentPhase === "states") {
      this.pendingPhaseFlags = { ...flags, states: false };
    }

    // Handle "Skip" (index 1) - just move to next phase
    if (selectedIndex === 1) {
      this.dispatch({ type: "CLOSE_MODAL" });
      await this.startNextPhase();
      return;
    }

    // Handle "Generate" (index 0) - execute this phase
    const phaseTitle = currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1);
    this.dispatch({ type: "SHOW_MODAL", title: `Generating ${phaseTitle}` });
    this.render();

    try {
      const result = await executePhasePlan(genCtx, plan);

      debugLog(`[TUI] ${currentPhase} generation complete: ${result.created} entities`);

      if (result.errors.length > 0) {
        debugLog(`[TUI] ${currentPhase} had ${result.errors.length} errors`);
      }

      // Rebuild tree to show new entities
      await this.rebuildTree();

      // Check if there are more phases
      const hasMorePhases = this.pendingPhaseFlags &&
        (this.pendingPhaseFlags.religions || this.pendingPhaseFlags.cultures || this.pendingPhaseFlags.states);

      if (hasMorePhases) {
        // Close modal and start next phase
        this.dispatch({ type: "CLOSE_MODAL" });
        await this.startNextPhase();
      } else {
        // All done
        this.dispatch({ type: "COMPLETE_MODAL" });
        this.pendingPhaseFlags = null;
        this.pendingPhaseCampaignSettings = null;
      }

    } catch (e: any) {
      this.dispatch({ type: "MODAL_ERROR", error: e?.message || String(e) });
      // Clear state on error
      this.pendingPhaseFlags = null;
      this.pendingPhaseCampaignSettings = null;
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
   * Navigate to a link from the detail panel Links section
   */
  private navigateToLink(link: { id: string; name: string; kind: EntityKind }): void {
    // Build a node ID from the link
    let nodeId: string;
    if (link.kind === "npc") {
      nodeId = `npc:${link.id}`;
    } else if (link.kind === "location") {
      nodeId = `location:${link.id}`;
    } else if (link.kind === "faction") {
      nodeId = `faction:${link.id}`;
    } else if (link.kind === "burg") {
      nodeId = `burg:${link.id}`;
    } else if (link.kind === "state") {
      nodeId = `state:${link.id}`;
    } else {
      nodeId = `${link.kind}:${link.id}`;
    }

    // Parse to ref and navigate
    const ref = nodeIdToRef(nodeId);
    this.dispatch({ type: "SET_FOCUS", focus: "tree" });
    this.dispatch({ type: "RESET_DETAIL_LINK_INDEX" });
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
   * Rebuild the tree from scratch based on active tab
   */
  private async rebuildTree(): Promise<void> {
    this.rebuildTreeForTab();
  }

  /**
   * Rebuild tree for current active tab
   */
  private rebuildTreeForTab(): void {
    const { world, canon } = this.options;
    const activeTab = this.state.activeTab;
    let nodes: TreeNode[];

    switch (activeTab) {
      case "world":
        nodes = buildTree(world, canon, this.state.expandedNodes, this.state.selectedNodeId);
        break;
      case "factions":
        nodes = buildFactionsList(canon, this.state.selectedNodeId);
        break;
      case "religions":
        nodes = buildReligionsList(world, this.state.selectedNodeId);
        break;
      case "cultures":
        nodes = buildCulturesList(world, this.state.selectedNodeId);
        break;
      default:
        nodes = buildTree(world, canon, this.state.expandedNodes, this.state.selectedNodeId);
    }

    this.dispatch({ type: "SET_TREE_NODES", nodes });

    // Select first node if none selected after tab switch
    if (!this.state.selectedNodeId && nodes.length > 0) {
      this.dispatch({ type: "SELECT_NODE", id: nodes[0].id });
    }
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
   * Confirm field selection and show planning modal
   */
  private async confirmFieldSelection(): Promise<void> {
    const fieldSelection = this.state.fieldSelection;
    if (!fieldSelection || fieldSelection.selectedFields.size === 0) {
      // No fields selected - just close
      this.dispatch({ type: "CLOSE_FIELD_SELECTION" });
      return;
    }

    // Close field selection modal
    this.dispatch({ type: "CLOSE_FIELD_SELECTION" });

    // Reset token counts for new generation
    this.dispatch({ type: "RESET_TOKEN_COUNTS" });
    this.dispatch({ type: "SHOW_PLANNING_MODAL", title: "Creating Regeneration Plan" });
    this.render();

    try {
      // Create context with TUI callbacks
      const tuiContext: CommandContext = {
        ...this.options.commandContext,
        tuiMode: true,
        onTokens: (usage) => {
          this.dispatch({ type: "ADD_PLANNER_TOKENS", usage });
          this.render();
        },
      };

      // Plan the field regeneration
      const result = await planFieldRegen(
        fieldSelection.entityId,
        Array.from(fieldSelection.selectedFields),
        fieldSelection.hint,
        tuiContext
      );

      if (result.error) {
        this.dispatch({ type: "MODAL_ERROR", error: result.error });
        return;
      }

      if (result.pendingFieldRegeneration) {
        this.pendingFieldRegenPlan = result.pendingFieldRegeneration.plan;
        const planText = result.pendingFieldRegeneration.formattedPlan;

        this.dispatch({
          type: "SHOW_APPROVAL_MODAL",
          title: "Field Regeneration Plan",
          choices: [
            { label: "Regenerate", value: "regenerate", hint: "Regenerate the selected fields" },
            { label: "Cancel", value: "cancel", hint: "Abort without regenerating" },
          ],
          planText: planText || "(Plan text missing)",
        });
      }
    } catch (e: any) {
      this.dispatch({ type: "MODAL_ERROR", error: e?.message || String(e) });
    }
  }

  /**
   * Open the generation plan in $EDITOR for editing
   */
  private async openPlanInEditor(): Promise<void> {
    if (!this.state.modal?.pendingEntities) return;

    const entities = this.state.modal.pendingEntities as any[];
    const { spawnSync } = await import("child_process");
    const { writeFileSync, readFileSync, unlinkSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    // Get editor from environment
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";

    // Create temp file with JSON
    const tempFile = join(tmpdir(), `azbrowse-plan-${Date.now()}.json`);
    const planJson = JSON.stringify(entities, null, 2);
    writeFileSync(tempFile, planJson, "utf-8");

    // Exit alternate screen temporarily for editor
    process.stdout.write(exitAltScreen());
    process.stdout.write(showCursor());

    // Restore terminal for editor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Spawn editor and wait for completion
    try {
      const result = spawnSync(editor, [tempFile], {
        stdio: "inherit",
        shell: true,
      });

      // Read back the edited file
      if (result.status === 0) {
        try {
          const editedJson = readFileSync(tempFile, "utf-8");
          const editedEntities = JSON.parse(editedJson);

          // Validate it's still an array
          if (Array.isArray(editedEntities)) {
            // Update the modal state with edited entities
            this.state = {
              ...this.state,
              modal: {
                ...this.state.modal!,
                pendingEntities: editedEntities,
              },
            };
          }
        } catch (e: any) {
          debugLog(`[TUI] Failed to parse edited JSON: ${e?.message || String(e)}`);
        }
      }
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }

      // Restore TUI
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdout.write(enterAltScreen());
      process.stdout.write(hideCursor());
      this.render();
    }
  }

  /**
   * Execute field regeneration after user approval
   */
  private async executeFieldRegeneration(): Promise<void> {
    if (!this.pendingFieldRegenPlan) return;

    const plan = this.pendingFieldRegenPlan;
    this.pendingFieldRegenPlan = null;

    // Switch modal to progress mode
    this.dispatch({ type: "SHOW_MODAL", title: "Regenerating Fields..." });

    try {
      // Create context with TUI callbacks
      const tuiContext: CommandContext = {
        ...this.options.commandContext,
        tuiMode: true,
        onTokens: (usage) => {
          this.dispatch({ type: "ADD_GENERATION_TOKENS", usage });
          this.render();
        },
      };

      const result = await executePendingFieldRegeneration(plan, tuiContext);

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
   * Handle enter talk mode (t hotkey)
   */
  private async handleEnterTalkMode(): Promise<void> {
    // Check if the currently selected tree node is an NPC
    const selected = getSelectedNode(this.state);
    if (selected && selected.kind === "npc") {
      // First sync browse state to the NPC, then execute talk command
      this.syncBrowseStateToSelection();
      await this.executeCommand("talk");
    } else {
      // Show error message via modal
      this.dispatch({ type: "SHOW_MODAL", title: "Cannot Talk" });
      this.dispatch({ type: "MODAL_ERROR", error: "Select an NPC first to enter talk mode" });
    }
  }

  /**
   * Enter talk mode with the current NPC
   */
  private async enterTalkModeWithNpc(): Promise<void> {
    this.talkMode = true;
    this.dispatch({ type: "CLEAR_COMMAND" });  // Clear command buffer for talk input

    // Get NPC info for display
    const ref = currentRef(this.options.browseState);
    if (ref.kind === "npc") {
      const npc = this.options.canon.getEntity(ref.npcId);
      if (npc) {
        // Show a modal with the NPC name as a "conversation header"
        // Note: SHOW_MODAL sets mode to "modal", so we set talk mode AFTER
        this.dispatch({ type: "SHOW_MODAL", title: `Talking to ${npc.name}` });
        this.dispatch({ type: "UPDATE_MODAL_PROGRESS", progress: "(Type your message and press Enter to speak. Press Esc to exit.)" });
      }
    }

    // Set talk mode AFTER showing modal (since SHOW_MODAL sets mode to "modal")
    this.dispatch({ type: "SET_MODE", mode: "talk" });
  }

  /**
   * Exit talk mode
   */
  private exitTalkMode(): void {
    this.talkMode = false;
    this.talkScene = undefined;
    this.dispatch({ type: "CLOSE_MODAL" });
    this.dispatch({ type: "SET_MODE", mode: "normal" });
  }

  /**
   * Send a message in talk mode and get NPC response
   */
  private async sendTalkMessage(message: string): Promise<void> {
    if (!message.trim()) return;

    debugLog(`[TUI Talk] sendTalkMessage called with: "${message}"`);

    const ref = currentRef(this.options.browseState);
    if (ref.kind !== "npc") {
      debugLog(`[TUI Talk] Not at NPC, exiting talk mode`);
      this.exitTalkMode();
      return;
    }

    const npc = this.options.canon.getEntity(ref.npcId);
    if (!npc) {
      debugLog(`[TUI Talk] NPC not found: ${ref.npcId}`);
      this.exitTalkMode();
      return;
    }

    debugLog(`[TUI Talk] Talking to NPC: ${npc.name} (${npc.id})`);

    // Import npcTurn function
    const { npcTurn } = await import("../../chat/npc");

    // Show thinking indicator
    this.dispatch({ type: "UPDATE_MODAL_PROGRESS", progress: `You: "${message}"\n\n${npc.name} is thinking...` });
    this.render();

    try {
      // Use talk LLM if available, otherwise fall back to generation LLM or main LLM
      const talkLlm = this.options.commandContext.talkLlm ||
                      this.options.commandContext.generationLlm ||
                      this.options.commandContext.llm;

      debugLog(`[TUI Talk] Using LLM: ${talkLlm.provider}/${talkLlm.model}`);
      debugLog(`[TUI Talk] chatState.currentNpcId: ${this.options.browseState.chatState.currentNpcId}`);

      // Call npcTurn to get NPC response
      // Note: npcTurn gets the NPC from state.currentNpcId which is already set via navigateTo
      debugLog(`[TUI Talk] Calling npcTurn...`);
      const response = await npcTurn({
        llm: this.options.commandContext.llm,
        talkLlm,
        world: this.options.world,
        canon: this.options.canon,
        state: this.options.browseState.chatState,
        userText: message,
        campaignSettings: this.options.commandContext.campaignSettings,
      });

      debugLog(`[TUI Talk] npcTurn returned: ${response.slice(0, 100)}...`);

      // Show the conversation
      const conversationText = `You: "${message}"\n\n${npc.name}: ${response}\n\n(Type another message or press Esc to exit)`;
      this.dispatch({ type: "UPDATE_MODAL_PROGRESS", progress: conversationText });
      this.render();  // Re-render to show the response
    } catch (e: any) {
      debugLog(`[TUI Talk] Error: ${e?.message || String(e)}`);
      this.dispatch({ type: "UPDATE_MODAL_PROGRESS", progress: `Error: ${e?.message || String(e)}\n\n(Press Esc to exit)` });
      this.render();  // Re-render to show the error
    }
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
                          mode === "onboarding" ? `${FG_GREEN}SETUP${RESET}` :
                          mode === "talk" ? `${FG_GREEN}TALK${RESET}` :
                          `${FG_CYAN}NORMAL${RESET}`;
    const modeText = mode === "command" ? "COMMAND" :
                     mode === "modal" ? "MODAL" :
                     mode === "search" ? "SEARCH" :
                     mode === "onboarding" ? "SETUP" :
                     mode === "talk" ? "TALK" :
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
    } else if (this.state.mode === "talk") {
      // Show talk input with block cursor
      const before = this.state.commandBuffer.slice(0, this.state.commandCursorPos);
      const cursorChar = this.state.commandBuffer[this.state.commandCursorPos] ?? " ";
      const after = this.state.commandBuffer.slice(this.state.commandCursorPos + 1);
      lines.push(`> ${before}${REVERSE}${cursorChar}${RESET}${after}`);
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

    // Apply onboarding modal overlay if visible
    if (this.state.onboarding?.visible) {
      screenLines = overlayOnboardingModal(screenLines, this.state.onboarding, this.layout);
    }

    // Apply help modal overlay if visible
    if (this.state.help?.visible) {
      screenLines = overlayHelpModal(screenLines, this.state.help, this.layout);
    }

    // Apply field selection modal overlay if visible
    if (this.state.fieldSelection?.visible) {
      screenLines = overlayFieldSelectionModal(screenLines, this.state.fieldSelection, this.layout);
    }

    // Render to screen
    let output = clearScreen();
    for (let i = 0; i < this.layout.terminalRows; i++) {
      const line = screenLines[i] ?? "";
      output += moveTo(i + 1, 1) + padRight(line, this.layout.terminalCols);
    }

    // Position cursor for command mode or talk mode
    if (this.state.mode === "command") {
      // Position at cursor location (+1 for ':' prefix, +1 for 1-based column)
      output += moveTo(this.layout.terminalRows, 2 + this.state.commandCursorPos);
      output += showCursor();
    } else if (this.state.mode === "talk") {
      // Position at cursor location (+2 for '> ' prefix, +1 for 1-based column)
      output += moveTo(this.layout.terminalRows, 3 + this.state.commandCursorPos);
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
