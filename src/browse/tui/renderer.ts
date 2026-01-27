/**
 * ANSI rendering utilities for azbrowse TUI
 *
 * Provides colors, box drawing, text utilities, and screen management.
 */

import type { EntityKind } from "./types";

// ANSI escape sequences
export const CSI = "\x1b[";
export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;
export const ITALIC = `${CSI}3m`;
export const UNDERLINE = `${CSI}4m`;
export const REVERSE = `${CSI}7m`;

// Colors (256-color mode for better terminal support)
export const FG_GRAY = `${CSI}38;5;245m`;
export const FG_WHITE = `${CSI}38;5;255m`;
export const FG_CYAN = `${CSI}38;5;39m`;
export const FG_GREEN = `${CSI}38;5;40m`;
export const FG_YELLOW = `${CSI}38;5;220m`;
export const FG_MAGENTA = `${CSI}38;5;205m`;
export const FG_BLUE = `${CSI}38;5;75m`;
export const FG_RED = `${CSI}38;5;196m`;

export const BG_HIGHLIGHT = `${CSI}48;5;236m`;
export const BG_SELECTION = `${CSI}48;5;24m`;
export const BG_MODAL = `${CSI}48;5;234m`;

// Box drawing characters
export const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  verticalRight: "├",
  verticalLeft: "┤",
  horizontalDown: "┬",
  horizontalUp: "┴",
  cross: "┼",
  // Double line
  doubleHorizontal: "═",
  doubleVertical: "║",
  doubleTopLeft: "╔",
  doubleTopRight: "╗",
  doubleBottomLeft: "╚",
  doubleBottomRight: "╝",
};

// Tree characters
export const TREE = {
  branch: "├",
  lastBranch: "└",
  vertical: "│",
  horizontal: "─",
  expanded: "▾",
  collapsed: "▸",
  leaf: "•",
};

// Entity type color mapping
export const ENTITY_COLORS: Record<EntityKind, string> = {
  world: FG_WHITE,
  state: FG_BLUE,
  burg: FG_CYAN,
  location: FG_GREEN,
  npc: FG_YELLOW,
  faction: FG_MAGENTA,
  event: FG_RED,
};

/**
 * Get color for entity type
 */
export function getEntityColor(kind: EntityKind): string {
  return ENTITY_COLORS[kind] || FG_WHITE;
}

/**
 * Strip ANSI codes from string for length calculation
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Get visible length of string (excluding ANSI codes)
 */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Truncate string to fit width, adding ellipsis if needed
 */
export function truncate(str: string, maxLen: number): string {
  const visible = stripAnsi(str);
  if (visible.length <= maxLen) return str;

  // Simple truncation - doesn't preserve ANSI codes across truncation
  const stripped = visible.slice(0, maxLen - 1) + "…";
  return stripped;
}

/**
 * Pad string to width (accounting for ANSI codes)
 */
export function padRight(str: string, width: number): string {
  const visible = visibleLength(str);
  if (visible >= width) return str;
  return str + " ".repeat(width - visible);
}

/**
 * Pad string to center within width
 */
export function padCenter(str: string, width: number): string {
  const visible = visibleLength(str);
  if (visible >= width) return str;
  const leftPad = Math.floor((width - visible) / 2);
  const rightPad = width - visible - leftPad;
  return " ".repeat(leftPad) + str + " ".repeat(rightPad);
}

/**
 * Slice string by visible position, preserving ANSI codes
 * Returns characters from visible position start to end (exclusive)
 */
export function sliceByVisible(str: string, start: number, end?: number): string {
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  let result = "";
  let visiblePos = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const actualEnd = end ?? Infinity;

  // Track pending ANSI codes that should be applied at the start of the result
  let pendingAnsi = "";

  while ((match = ansiRegex.exec(str)) !== null) {
    // Process text before this ANSI code
    const textBefore = str.slice(lastIndex, match.index);
    for (const char of textBefore) {
      if (visiblePos >= start && visiblePos < actualEnd) {
        // If this is the first visible char, prepend any pending ANSI codes
        if (result === "" && pendingAnsi) {
          result += pendingAnsi;
          pendingAnsi = "";
        }
        result += char;
      }
      visiblePos++;
      if (visiblePos >= actualEnd) break;
    }

    // Handle the ANSI code
    if (visiblePos < start) {
      // Before our slice - accumulate ANSI codes
      pendingAnsi += match[0];
    } else if (visiblePos < actualEnd) {
      // Within our slice - include the ANSI code
      if (result === "" && pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += match[0];
    }

    lastIndex = match.index + match[0].length;
    if (visiblePos >= actualEnd) break;
  }

  // Process remaining text after last ANSI code
  const remaining = str.slice(lastIndex);
  for (const char of remaining) {
    if (visiblePos >= start && visiblePos < actualEnd) {
      if (result === "" && pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += char;
    }
    visiblePos++;
    if (visiblePos >= actualEnd) break;
  }

  return result;
}

/**
 * Wrap text to width, preserving words
 */
export function wrapText(text: string, width: number, indent: number = 0): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let currentLine = "";
  const indentStr = " ".repeat(indent);
  const effectiveWidth = width - indent;

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= effectiveWidth) {
      currentLine += " " + word;
    } else {
      lines.push(indentStr + currentLine);
      currentLine = word;
    }
  }
  if (currentLine) {
    lines.push(indentStr + currentLine);
  }

  return lines;
}

/**
 * Move cursor to position (1-indexed)
 */
export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/**
 * Clear from cursor to end of line
 */
export function clearToEol(): string {
  return `${CSI}K`;
}

/**
 * Clear entire line
 */
export function clearLine(): string {
  return `${CSI}2K`;
}

/**
 * Clear screen
 */
export function clearScreen(): string {
  return `${CSI}2J${CSI}H`;
}

/**
 * Hide cursor
 */
export function hideCursor(): string {
  return `${CSI}?25l`;
}

/**
 * Show cursor
 */
export function showCursor(): string {
  return `${CSI}?25h`;
}

/**
 * Save cursor position
 */
export function saveCursor(): string {
  return `${CSI}s`;
}

/**
 * Restore cursor position
 */
export function restoreCursor(): string {
  return `${CSI}u`;
}

/**
 * Enter alternate screen buffer
 */
export function enterAltScreen(): string {
  return `${CSI}?1049h`;
}

/**
 * Exit alternate screen buffer
 */
export function exitAltScreen(): string {
  return `${CSI}?1049l`;
}

/**
 * Draw a horizontal line
 */
export function horizontalLine(width: number, char: string = BOX.horizontal): string {
  return char.repeat(width);
}

/**
 * Draw a box border
 */
export function drawBox(
  width: number,
  height: number,
  title?: string
): string[] {
  const lines: string[] = [];

  // Top border
  let topLine = BOX.topLeft + horizontalLine(width - 2) + BOX.topRight;
  if (title) {
    const titleStr = ` ${title} `;
    const titleStart = 2;
    topLine =
      BOX.topLeft +
      BOX.horizontal.repeat(titleStart) +
      titleStr +
      BOX.horizontal.repeat(width - titleStart - titleStr.length - 2) +
      BOX.topRight;
  }
  lines.push(topLine);

  // Middle lines
  for (let i = 0; i < height - 2; i++) {
    lines.push(BOX.vertical + " ".repeat(width - 2) + BOX.vertical);
  }

  // Bottom border
  lines.push(BOX.bottomLeft + horizontalLine(width - 2) + BOX.bottomRight);

  return lines;
}

/**
 * Create a buffer for building screen content
 */
export class ScreenBuffer {
  private lines: string[] = [];
  private row: number = 1;
  private col: number = 1;

  constructor(
    private readonly width: number,
    private readonly height: number
  ) {
    // Initialize with empty lines
    for (let i = 0; i < height; i++) {
      this.lines.push(" ".repeat(width));
    }
  }

  /**
   * Write text at current position
   */
  write(text: string): this {
    if (this.row >= 1 && this.row <= this.height) {
      const line = this.lines[this.row - 1];
      const before = line.slice(0, this.col - 1);
      const after = line.slice(this.col - 1 + visibleLength(text));
      this.lines[this.row - 1] = before + text + after;
      this.col += visibleLength(text);
    }
    return this;
  }

  /**
   * Write text at specific position
   */
  writeAt(row: number, col: number, text: string): this {
    this.row = row;
    this.col = col;
    return this.write(text);
  }

  /**
   * Move to position
   */
  move(row: number, col: number): this {
    this.row = row;
    this.col = col;
    return this;
  }

  /**
   * Get the rendered screen content
   */
  render(): string {
    return this.lines.join("\n");
  }

  /**
   * Get a specific line
   */
  getLine(row: number): string {
    return this.lines[row - 1] || "";
  }

  /**
   * Set a specific line
   */
  setLine(row: number, content: string): this {
    if (row >= 1 && row <= this.height) {
      this.lines[row - 1] = padRight(content, this.width).slice(0, this.width);
    }
    return this;
  }
}

/**
 * Render the full screen, outputting directly to stdout
 */
export function renderFullScreen(
  content: string[],
  rows: number,
  cols: number
): void {
  let output = moveTo(1, 1);

  for (let i = 0; i < rows; i++) {
    const line = content[i] ?? "";
    output += padRight(line, cols).slice(0, cols);
    if (i < rows - 1) {
      output += "\n";
    }
  }

  process.stdout.write(output);
}
