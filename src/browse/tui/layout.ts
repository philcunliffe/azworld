/**
 * Layout calculations for azbrowse TUI
 *
 * Handles screen splitting between tree panel and detail panel.
 */

export type LayoutDimensions = {
  // Terminal dimensions
  terminalRows: number;
  terminalCols: number;

  // Tree panel (left)
  treeLeft: number;
  treeTop: number;
  treeWidth: number;
  treeHeight: number;

  // Detail panel (right)
  detailLeft: number;
  detailTop: number;
  detailWidth: number;
  detailHeight: number;

  // Header and footer
  headerHeight: number;
  footerHeight: number;

  // Content area (excluding borders)
  treeContentWidth: number;
  treeContentHeight: number;
  detailContentWidth: number;
  detailContentHeight: number;
};

// Minimum dimensions
const MIN_TREE_WIDTH = 25;
const MIN_DETAIL_WIDTH = 40;
const MIN_TERMINAL_WIDTH = 70;
const MIN_TERMINAL_HEIGHT = 10;

// Layout ratios
const TREE_WIDTH_RATIO = 0.30; // Tree takes 30% of width
const HEADER_HEIGHT = 1;
const FOOTER_HEIGHT = 2; // Status bar + command line

/**
 * Calculate layout dimensions based on terminal size
 */
export function calculateLayout(rows: number, cols: number): LayoutDimensions {
  // Apply minimums
  const terminalRows = Math.max(rows, MIN_TERMINAL_HEIGHT);
  const terminalCols = Math.max(cols, MIN_TERMINAL_WIDTH);

  // Calculate panel widths
  const availableWidth = terminalCols - 1; // -1 for border between panels
  let treeWidth = Math.floor(availableWidth * TREE_WIDTH_RATIO);
  let detailWidth = availableWidth - treeWidth;

  // Apply minimum widths
  if (treeWidth < MIN_TREE_WIDTH) {
    treeWidth = MIN_TREE_WIDTH;
    detailWidth = availableWidth - treeWidth;
  }
  if (detailWidth < MIN_DETAIL_WIDTH) {
    detailWidth = MIN_DETAIL_WIDTH;
    treeWidth = availableWidth - detailWidth;
  }

  // Calculate heights
  const contentHeight = terminalRows - HEADER_HEIGHT - FOOTER_HEIGHT;

  return {
    terminalRows,
    terminalCols,

    // Tree panel
    treeLeft: 0,
    treeTop: HEADER_HEIGHT,
    treeWidth,
    treeHeight: contentHeight,

    // Detail panel
    detailLeft: treeWidth + 1, // +1 for border
    detailTop: HEADER_HEIGHT,
    detailWidth,
    detailHeight: contentHeight,

    // Header and footer
    headerHeight: HEADER_HEIGHT,
    footerHeight: FOOTER_HEIGHT,

    // Content dimensions (accounting for borders)
    treeContentWidth: treeWidth - 2,     // -2 for left/right borders
    treeContentHeight: contentHeight - 2, // -2 for top/bottom borders
    detailContentWidth: detailWidth - 2,
    detailContentHeight: contentHeight - 2,
  };
}

/**
 * Get dimensions for modal overlay
 */
export function calculateModalDimensions(
  layout: LayoutDimensions,
  large?: boolean
): { left: number; top: number; width: number; height: number } {
  // Large modal for approval (plan display)
  if (large) {
    const modalWidth = Math.min(80, Math.floor(layout.terminalCols * 0.85));
    const modalHeight = Math.min(layout.terminalRows - 4, Math.floor(layout.terminalRows * 0.85));
    return {
      left: Math.floor((layout.terminalCols - modalWidth) / 2),
      top: Math.floor((layout.terminalRows - modalHeight) / 2),
      width: modalWidth,
      height: modalHeight,
    };
  }

  // Standard modal
  const modalWidth = Math.min(60, Math.floor(layout.terminalCols * 0.6));
  const modalHeight = Math.min(20, Math.floor(layout.terminalRows * 0.6));

  return {
    left: Math.floor((layout.terminalCols - modalWidth) / 2),
    top: Math.floor((layout.terminalRows - modalHeight) / 2),
    width: modalWidth,
    height: modalHeight,
  };
}

/**
 * Check if terminal is too small for TUI
 */
export function isTerminalTooSmall(rows: number, cols: number): boolean {
  return cols < MIN_TERMINAL_WIDTH || rows < MIN_TERMINAL_HEIGHT;
}

/**
 * Get minimum terminal size message
 */
export function getMinSizeMessage(): string {
  return `Terminal too small. Minimum size: ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}`;
}
