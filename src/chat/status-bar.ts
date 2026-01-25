/**
 * Persistent status bar for terminal display.
 * Shows token usage and other stats at the bottom of the screen.
 */

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type StatusBarState = {
  sessionTokens: TokenUsage;
  currentTool: string | null;
  toolStartTime: number | null;
  provider: string;
  model: string;
};

const CSI = "\x1b[";
const SAVE_CURSOR = `${CSI}s`;
const RESTORE_CURSOR = `${CSI}u`;

export class StatusBar {
  private state: StatusBarState;
  private enabled: boolean;
  private rows: number;
  private resizeHandler: (() => void) | null = null;

  constructor(provider: string, model: string, enabled = true) {
    this.enabled = enabled && process.stdout.isTTY === true;
    this.rows = process.stdout.rows || 24;
    this.state = {
      sessionTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      currentTool: null,
      toolStartTime: null,
      provider,
      model,
    };

    if (this.enabled) {
      this.setupScrollRegion();
      this.resizeHandler = () => this.handleResize();
      process.stdout.on("resize", this.resizeHandler);
    }
  }

  /** Set up scroll region to exclude bottom line */
  private setupScrollRegion() {
    this.rows = process.stdout.rows || 24;
    // Set scroll region to rows 1 through (rows-1), leaving bottom line for status
    process.stdout.write(
      SAVE_CURSOR +
      `${CSI}1;${this.rows - 1}r` +  // Set scroll region
      RESTORE_CURSOR
    );
    this.render();
  }

  /** Handle terminal resize */
  private handleResize() {
    if (!this.enabled) return;
    // Clear old status bar position first
    const oldRows = this.rows;
    const width = process.stdout.columns || 80;
    process.stdout.write(
      SAVE_CURSOR +
      `${CSI}${oldRows};1H` +
      " ".repeat(width) +
      RESTORE_CURSOR
    );
    // Reconfigure scroll region for new size
    this.setupScrollRegion();
  }

  /** Add tokens to session total */
  addTokens(usage: Partial<TokenUsage>) {
    if (usage.promptTokens) this.state.sessionTokens.promptTokens += usage.promptTokens;
    if (usage.completionTokens) this.state.sessionTokens.completionTokens += usage.completionTokens;
    if (usage.totalTokens) this.state.sessionTokens.totalTokens += usage.totalTokens;
    this.render();
  }

  /** Mark tool as started */
  toolStart(name: string) {
    this.state.currentTool = name;
    this.state.toolStartTime = Date.now();
    this.render();
  }

  /** Mark tool as completed, return elapsed time */
  toolEnd(): number {
    const elapsed = this.state.toolStartTime ? Date.now() - this.state.toolStartTime : 0;
    this.state.currentTool = null;
    this.state.toolStartTime = null;
    this.render();
    return elapsed;
  }

  /** Update provider/model display */
  setProvider(provider: string, model: string) {
    this.state.provider = provider;
    this.state.model = model;
    this.render();
  }

  /** Get current session tokens */
  getTokens(): TokenUsage {
    return { ...this.state.sessionTokens };
  }

  /** Reset session tokens */
  resetTokens() {
    this.state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.render();
  }

  /** Format token count with K suffix for large numbers */
  private formatTokens(n: number): string {
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
    return String(n);
  }

  /** Render the status bar */
  render() {
    if (!this.enabled) return;

    const { sessionTokens, currentTool, toolStartTime, provider, model } = this.state;
    const totalStr = this.formatTokens(sessionTokens.totalTokens);
    const promptStr = this.formatTokens(sessionTokens.promptTokens);
    const compStr = this.formatTokens(sessionTokens.completionTokens);

    let toolStatus = "";
    if (currentTool && toolStartTime) {
      const elapsed = ((Date.now() - toolStartTime) / 1000).toFixed(1);
      toolStatus = `  ${currentTool} (${elapsed}s)`;
    }

    const width = process.stdout.columns || 80;
    const line = `tokens: ${totalStr} (${promptStr}/${compStr})  ${provider}/${model}${toolStatus}`;
    const padded = line.slice(0, width).padEnd(width);

    // Move to bottom, print status, move back
    const rows = process.stdout.rows || 24;
    process.stdout.write(
      SAVE_CURSOR +
      `${CSI}${rows};1H` +  // Move to last row
      `${CSI}7m` +          // Reverse video (inverted colors)
      padded +
      `${CSI}0m` +          // Reset attributes
      RESTORE_CURSOR
    );
  }

  /** Clear the status bar and restore full scroll region */
  clear() {
    if (!this.enabled) return;
    const rows = process.stdout.rows || 24;
    const width = process.stdout.columns || 80;
    // Clear status bar line and restore full scroll region
    process.stdout.write(
      SAVE_CURSOR +
      `${CSI}${rows};1H` +
      " ".repeat(width) +
      `${CSI}1;${rows}r` +  // Restore full scroll region
      RESTORE_CURSOR
    );
    // Remove resize handler
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  /** Enable/disable status bar */
  setEnabled(enabled: boolean) {
    if (!enabled && this.enabled) {
      this.clear();
    }
    this.enabled = enabled && process.stdout.isTTY === true;
    if (enabled && this.enabled) {
      this.resizeHandler = () => this.handleResize();
      process.stdout.on("resize", this.resizeHandler);
      this.setupScrollRegion();
    }
  }
}

// Global singleton for easy access
let globalStatusBar: StatusBar | null = null;

export function initStatusBar(provider: string, model: string): StatusBar {
  globalStatusBar = new StatusBar(provider, model);
  return globalStatusBar;
}

export function getStatusBar(): StatusBar | null {
  return globalStatusBar;
}
