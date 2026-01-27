/**
 * Tree panel renderer for azbrowse TUI
 *
 * Renders the left sidebar with collapsible tree navigation.
 */

import type { TreeNode, TuiState } from "../types";
import type { LayoutDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  TREE,
  FG_WHITE,
  FG_GRAY,
  BG_SELECTION,
  getEntityColor,
  padRight,
  truncate,
  visibleLength,
} from "../renderer";

/**
 * Render the tree panel
 *
 * Note: The tree panel does NOT render a right border - the detail panel
 * provides the divider between panels using T-junction characters.
 */
export function renderTreePanel(
  state: TuiState,
  layout: LayoutDimensions
): string[] {
  const lines: string[] = [];
  const { treeWidth, treeContentHeight } = layout;
  // innerWidth accounts for only the left border (no right border - detail provides divider)
  const innerWidth = treeWidth - 1;

  // Title bar - no right corner, detail panel will provide T-junction
  const title = " World Tree ";
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BOX.topLeft}${BOX.horizontal.repeat(titlePadding)}${BOLD}${title}${RESET}${BOX.horizontal.repeat(
      Math.max(0, innerWidth - titlePadding - title.length)
    )}`
  );

  // Get visible nodes with scroll offset
  const visibleNodes = state.treeNodes.slice(
    state.treeScrollOffset,
    state.treeScrollOffset + treeContentHeight
  );

  // Render tree nodes
  for (let i = 0; i < treeContentHeight; i++) {
    const node = visibleNodes[i];
    if (node) {
      lines.push(renderTreeLine(node, innerWidth, state.focus === "tree"));
    } else {
      // Empty line - no right border
      lines.push(`${BOX.vertical}${" ".repeat(innerWidth)}`);
    }
  }

  // Bottom border with scroll indicator - no right corner
  const totalNodes = state.treeNodes.length;
  const scrollInfo =
    totalNodes > treeContentHeight
      ? ` ${state.treeScrollOffset + 1}-${Math.min(
          state.treeScrollOffset + treeContentHeight,
          totalNodes
        )}/${totalNodes} `
      : "";
  const bottomPadding = innerWidth - scrollInfo.length;
  lines.push(
    `${BOX.bottomLeft}${BOX.horizontal.repeat(
      Math.floor(bottomPadding / 2)
    )}${DIM}${scrollInfo}${RESET}${BOX.horizontal.repeat(
      Math.ceil(bottomPadding / 2)
    )}`
  );

  return lines;
}

/**
 * Render a single tree line
 */
function renderTreeLine(
  node: TreeNode,
  width: number,
  hasFocus: boolean
): string {
  const indent = "  ".repeat(node.depth);
  const color = getEntityColor(node.kind);

  // Tree connector
  let connector = "";
  if (node.hasChildren) {
    connector = node.expanded ? TREE.expanded : TREE.collapsed;
  } else {
    connector = TREE.leaf;
  }

  // Selection highlight
  const bgColor = node.isSelected && hasFocus ? BG_SELECTION : "";
  const fgColor = node.isSelected && hasFocus ? FG_WHITE : color;

  // Build line content
  let content = `${indent}${connector} ${node.name}`;

  // Add extra info if there's room
  if (node.extra) {
    const nameLen = visibleLength(content);
    const extraSpace = width - nameLen - 2; // -2 for left border padding
    if (extraSpace > 10) {
      const extraText = truncate(node.extra, extraSpace);
      content += ` ${DIM}${extraText}${RESET}`;
    }
  }

  // Pad and truncate to fit - no right border
  const paddedContent = truncate(padRight(content, width), width);

  // Apply colors - no right border (detail panel provides divider)
  return `${BOX.vertical}${bgColor}${fgColor}${paddedContent}${RESET}`;
}

/**
 * Render tree panel with focus indicator
 */
export function renderTreePanelWithBorder(
  state: TuiState,
  layout: LayoutDimensions,
  isFocused: boolean
): string[] {
  const lines = renderTreePanel(state, layout);

  // If focused, highlight the border
  if (isFocused) {
    // Replace border characters with highlighted versions
    return lines.map((line, i) => {
      if (i === 0 || i === lines.length - 1) {
        return `${BOLD}${line}${RESET}`;
      }
      return line;
    });
  }

  return lines;
}
