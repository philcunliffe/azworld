import type { CanonStore, CanonEntity } from "../../canon/canon";
import type { TuiState, TuiCallbacks, NavigationMode, FeedItem } from "./types";
import { createInitialState, tuiReducer, getHighlightedItem, getCurrentNpcs, getSelectedNpc } from "./state";
import { fullRender } from "./renderer";
import { handleKeypress, isNavigationActive, parseKeyBuffer } from "./keybindings";
import { copyToClipboard } from "./clipboard";
import {
  createUserInputItem,
  createToolCallItem,
  createToolResultItem,
  createNarrationItem,
  createSceneHeaderItem,
  createNpcListItem,
  createLlmTextItem,
  getCopyableContent,
} from "./feed";

/**
 * TUI Controller - manages the interactive TUI layer
 */
export class TuiController {
  private state: TuiState;
  private canon: CanonStore;
  private callbacks: TuiCallbacks;
  private enabled: boolean;
  private keypressHandler: ((chunk: Buffer) => void) | null = null;
  private pendingToolIds: Map<string, string> = new Map(); // toolName -> feedItemId

  constructor(canon: CanonStore, callbacks: TuiCallbacks, enabled = true) {
    this.canon = canon;
    this.callbacks = callbacks;
    this.enabled = enabled && process.stdout.isTTY === true;
    this.state = createInitialState();
  }

  /**
   * Dispatch an action to update state
   */
  private dispatch(action: Parameters<typeof tuiReducer>[1]): void {
    this.state = tuiReducer(this.state, action);
  }

  /**
   * Get current navigation mode
   */
  getMode(): NavigationMode {
    return this.state.mode;
  }

  /**
   * Check if TUI is in navigation mode (intercepting input)
   */
  isInNavigationMode(): boolean {
    return isNavigationActive(this.state);
  }

  /**
   * Add user input to feed
   */
  addUserInput(text: string): void {
    if (!this.enabled) return;
    const item = createUserInputItem(text);
    this.dispatch({ type: "ADD_FEED_ITEM", item });
    // Don't render incrementally - items are viewed via /nav
  }

  /**
   * Add a tool call to feed (called when tool starts)
   */
  addToolCall(name: string, args: Record<string, any>): string {
    if (!this.enabled) return "";
    const item = createToolCallItem(name, args);
    this.dispatch({ type: "ADD_FEED_ITEM", item });
    this.pendingToolIds.set(name, item.id);
    // Don't render incrementally - items are viewed via /nav
    return item.id;
  }

  /**
   * Add tool result (called when tool completes)
   */
  addToolResult(name: string, result: any, elapsedMs: number): void {
    if (!this.enabled) return;

    // Find the pending tool call and update it
    const itemId = this.pendingToolIds.get(name);
    if (itemId) {
      this.dispatch({
        type: "UPDATE_FEED_ITEM",
        id: itemId,
        updates: { toolResult: result, elapsedMs },
      });
      this.pendingToolIds.delete(name);
      // Don't render incrementally - items are viewed via /nav
    }
  }

  /**
   * Add narration text to feed
   */
  addNarration(text: string): void {
    if (!this.enabled) return;
    const item = createNarrationItem(text);
    this.dispatch({ type: "ADD_FEED_ITEM", item });
    // Narration is rendered by console.log in main loop, not here
  }

  /**
   * Add LLM text response to feed
   */
  addLlmText(text: string): void {
    if (!this.enabled) return;
    const item = createLlmTextItem(text);
    this.dispatch({ type: "ADD_FEED_ITEM", item });
  }

  /**
   * Add scene header to feed
   */
  addSceneHeader(sceneName: string): void {
    if (!this.enabled) return;
    const item = createSceneHeaderItem(sceneName);
    this.dispatch({ type: "ADD_FEED_ITEM", item });
  }

  /**
   * Add scene context with NPCs
   */
  addSceneContext(scene: { location?: CanonEntity; npcs: CanonEntity[] }): void {
    if (!this.enabled) return;

    // Add scene header if location exists
    if (scene.location) {
      this.addSceneHeader(scene.location.name);
    }

    // Add NPC list if there are NPCs
    if (scene.npcs.length > 0) {
      const item = createNpcListItem(scene.npcs);
      this.dispatch({ type: "ADD_FEED_ITEM", item });
    }
  }

  /**
   * Enter navigation mode
   */
  enterNavigationMode(): void {
    if (!this.enabled) return;

    this.dispatch({ type: "SET_MODE", mode: "feed_nav" });

    // Highlight last navigable item
    const navigableItems = this.state.feedItems.filter(
      (item) => item.type !== "scene_header"
    );
    if (navigableItems.length > 0) {
      const lastItem = navigableItems[navigableItems.length - 1];
      this.dispatch({ type: "HIGHLIGHT_ITEM", id: lastItem.id });
    }

    this.fullRender();
  }

  /**
   * Exit navigation mode
   */
  exitNavigationMode(): void {
    this.dispatch({ type: "SET_MODE", mode: "normal" });
    this.dispatch({ type: "HIGHLIGHT_ITEM", id: null });
    this.callbacks.onExitNavigation();
  }

  /**
   * Full render of TUI (used when entering navigation or mode changes)
   */
  fullRender(): void {
    if (!this.enabled) return;
    fullRender(this.state);
  }

  /**
   * Handle a keypress in navigation mode
   * Returns true if the key was handled
   */
  handleKeypress(key: Buffer): boolean {
    if (!this.isInNavigationMode()) return false;

    const keyStr = parseKeyBuffer(key);
    const result = handleKeypress(keyStr, this.state);

    // Apply state changes
    for (const action of result.actions) {
      this.dispatch(action);
    }

    // Handle callbacks
    if (result.callback === "talk" && result.npcId) {
      this.callbacks.onTalkToNpc(result.npcId);
    } else if (result.callback === "copy" && result.copyText) {
      this.copyToClipboard(result.copyText);
    } else if (result.callback === "exit_nav") {
      this.callbacks.onExitNavigation();
    }

    // Re-render after state changes
    if (result.actions.length > 0) {
      this.fullRender();
    }

    return true;
  }

  /**
   * Copy text to clipboard and show feedback
   */
  private async copyToClipboard(text: string): Promise<void> {
    const success = await copyToClipboard(text);
    if (success) {
      // Brief feedback
      process.stdout.write("\x1b[32m(Copied to clipboard)\x1b[0m\n");
    } else {
      process.stdout.write("\x1b[31m(Failed to copy)\x1b[0m\n");
    }
  }

  /**
   * Set up raw mode input handling for navigation
   */
  setupRawMode(): void {
    if (!this.enabled || !process.stdin.isTTY) return;

    this.keypressHandler = (chunk: Buffer) => {
      if (this.isInNavigationMode()) {
        this.handleKeypress(chunk);
      }
    };

    process.stdin.on("data", this.keypressHandler);
  }

  /**
   * Clean up raw mode handling
   */
  cleanup(): void {
    if (this.keypressHandler) {
      process.stdin.off("data", this.keypressHandler);
      this.keypressHandler = null;
    }
  }

  /**
   * Get current feed items (for debugging/testing)
   */
  getFeedItems(): FeedItem[] {
    return [...this.state.feedItems];
  }

  /**
   * Clear the feed
   */
  clearFeed(): void {
    this.dispatch({ type: "CLEAR_FEED" });
  }

  /**
   * Check if TUI is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable/disable TUI
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled && process.stdout.isTTY === true;
  }

  /**
   * Get the currently highlighted item
   */
  getHighlightedItem(): FeedItem | undefined {
    return getHighlightedItem(this.state);
  }

  /**
   * Get the current NPC list
   */
  getCurrentNpcs(): FeedItem | undefined {
    return getCurrentNpcs(this.state);
  }

  /**
   * Get selected NPC from detail view
   */
  getSelectedNpc(): ReturnType<typeof getSelectedNpc> {
    return getSelectedNpc(this.state);
  }
}

// Re-export types and utilities
export type { TuiState, TuiCallbacks, NavigationMode, FeedItem, NpcListItem } from "./types";
export { copyToClipboard } from "./clipboard";
