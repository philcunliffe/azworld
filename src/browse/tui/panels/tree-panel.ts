/**
 * Tree panel renderer for azbrowse TUI
 *
 * Renders the left sidebar with collapsible tree navigation.
 */

import type { TreeNode, TuiState, TabId } from "../types";
import type { LayoutDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  TREE,
  FG_WHITE,
  FG_GRAY,
  FG_CYAN,
  FG_MAGENTA,
  FG_ORANGE,
  BG_SELECTION,
  REVERSE,
  getEntityColor,
  padRight,
  truncate,
  visibleLength,
} from "../renderer";
import type { EntityKind } from "../types";

// Tab definitions for the tab bar
// Labels kept to 3 chars to fit in narrow tree panel (~24 chars available)
const TABS: Array<{ id: TabId; label: string; kind: EntityKind }> = [
  { id: "world", label: "Wld", kind: "world" },
  { id: "factions", label: "Fac", kind: "faction" },
  { id: "religions", label: "Rel", kind: "religion" },
  { id: "cultures", label: "Cul", kind: "culture" },
];

/**
 * Render the tab bar for the tree panel
 */
function renderTabBar(activeTab: TabId, innerWidth: number): string {
  let tabBar = "";
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    const isActive = tab.id === activeTab;
    const num = i + 1;
    const label = `${num}:${tab.label}`;
    const color = getEntityColor(tab.kind);

    if (isActive) {
      tabBar += `${REVERSE}${color}${label}${RESET}`;
    } else {
      tabBar += `${DIM}${color}${label}${RESET}`;
    }
    if (i < TABS.length - 1) {
      tabBar += " ";
    }
  }
  return tabBar;
}

/**
 * Get title for the current tab
 */
function getTabTitle(activeTab: TabId): string {
  switch (activeTab) {
    case "world":
      return " World Tree ";
    case "factions":
      return " Factions ";
    case "religions":
      return " Religions ";
    case "cultures":
      return " Cultures ";
  }
}

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

  // Title bar - dynamic based on active tab
  const title = getTabTitle(state.activeTab);
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BOX.topLeft}${BOX.horizontal.repeat(titlePadding)}${BOLD}${title}${RESET}${BOX.horizontal.repeat(
      Math.max(0, innerWidth - titlePadding - title.length)
    )}`
  );

  // Tab bar row
  const tabBar = renderTabBar(state.activeTab, innerWidth);
  const tabBarPadded = padRight(tabBar, innerWidth);
  lines.push(`${BOX.vertical}${tabBarPadded}`);

  // Adjust content height for the tab bar row
  const adjustedContentHeight = treeContentHeight - 1;

  // Get visible nodes with scroll offset
  const visibleNodes = state.treeNodes.slice(
    state.treeScrollOffset,
    state.treeScrollOffset + adjustedContentHeight
  );

  // Render tree nodes
  for (let i = 0; i < adjustedContentHeight; i++) {
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
    totalNodes > adjustedContentHeight
      ? ` ${state.treeScrollOffset + 1}-${Math.min(
          state.treeScrollOffset + adjustedContentHeight,
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
