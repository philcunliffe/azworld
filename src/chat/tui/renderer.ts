import type { TuiState, FeedItem, NpcListItem, NpcDetailTab } from "./types";
import { getSelectedNpc, getCurrentNpcs } from "./state";

// ANSI escape sequences
const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const ITALIC = `${CSI}3m`;
const UNDERLINE = `${CSI}4m`;
const REVERSE = `${CSI}7m`;

// Colors (256-color mode for better terminal support)
const FG_GRAY = `${CSI}38;5;245m`;
const FG_CYAN = `${CSI}38;5;39m`;
const FG_GREEN = `${CSI}38;5;40m`;
const FG_YELLOW = `${CSI}38;5;220m`;
const FG_MAGENTA = `${CSI}38;5;205m`;
const FG_BLUE = `${CSI}38;5;75m`;
const FG_WHITE = `${CSI}38;5;255m`;
const BG_HIGHLIGHT = `${CSI}48;5;236m`;

// Box drawing characters
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  doubleHorizontal: "═",
  doubleTopLeft: "╔",
  doubleTopRight: "╗",
  doubleBottomLeft: "╚",
  doubleBottomRight: "╝",
  doubleVertical: "║",
};

const COLLAPSED_ARROW = "▸";
const EXPANDED_ARROW = "▾";

/**
 * Get terminal width
 */
function getWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Truncate string to fit width, adding ellipsis if needed
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Wrap text to width, preserving words
 */
function wrapText(text: string, width: number, indent: number = 0): string[] {
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
 * Format tool arguments for display (collapsed view)
 */
function formatToolArgsShort(args: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.length > 20) {
      parts.push(`${key}="${value.slice(0, 17)}..."`);
    } else if (typeof value === "object") {
      parts.push(`${key}={...}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(", ");
}

/**
 * Render a collapsed feed item (one line)
 */
export function renderCollapsedItem(item: FeedItem, width: number): string {
  const prefix = item.highlighted ? `${BG_HIGHLIGHT}${FG_WHITE}` : "";
  const suffix = item.highlighted ? RESET : "";
  const arrow = COLLAPSED_ARROW;

  let content: string;

  switch (item.type) {
    case "tool_call": {
      const argsStr = item.toolArgs ? formatToolArgsShort(item.toolArgs) : "";
      const timeStr = item.elapsedMs !== undefined ? `[${(item.elapsedMs / 1000).toFixed(1)}s]` : "[...]";
      content = `${FG_CYAN}${arrow} ${item.toolName}(${FG_GRAY}${argsStr}${FG_CYAN}) ${FG_GRAY}${timeStr}${RESET}`;
      break;
    }
    case "tool_result": {
      const resultPreview = JSON.stringify(item.toolResult)?.slice(0, 50) ?? "";
      content = `${FG_GREEN}${arrow} result: ${FG_GRAY}${resultPreview}${resultPreview.length >= 50 ? "..." : ""}${RESET}`;
      break;
    }
    case "user_input": {
      const text = truncate(item.text || "", width - 10);
      content = `${FG_YELLOW}> ${text}${RESET}`;
      break;
    }
    case "narration": {
      const text = truncate(item.text || "", width - 4);
      content = `${FG_WHITE}${text}${RESET}`;
      break;
    }
    case "llm_text": {
      const text = truncate(item.text || "", width - 4);
      content = `${DIM}${text}${RESET}`;
      break;
    }
    case "npc_list": {
      const count = item.npcs?.length ?? 0;
      content = `${FG_MAGENTA}${arrow} NPCs Present (${count})${RESET}`;
      break;
    }
    case "scene_header": {
      const name = item.sceneName || "Scene";
      const padding = Math.floor((width - name.length - 6) / 2);
      const line = BOX.doubleHorizontal.repeat(Math.max(0, padding));
      content = `${FG_BLUE}${line} ${name} ${line}${RESET}`;
      break;
    }
    default:
      content = truncate(item.text || `[${item.type}]`, width - 2);
  }

  return prefix + content + suffix;
}

/**
 * Render an expanded tool call (full view with box)
 */
export function renderExpandedToolCall(item: FeedItem, width: number): string[] {
  const lines: string[] = [];
  const innerWidth = width - 4;
  const toolName = item.toolName || "unknown";

  // Top border
  const titleLen = toolName.length + 4;
  const rightPad = Math.max(0, innerWidth - titleLen);
  lines.push(`${FG_CYAN}${BOX.topLeft}${BOX.horizontal} ${toolName} ${BOX.horizontal.repeat(rightPad)}${BOX.topRight}${RESET}`);

  // Args section
  if (item.toolArgs) {
    lines.push(`${FG_CYAN}${BOX.vertical}${RESET} ${FG_GRAY}Args:${RESET}`);
    const argsJson = JSON.stringify(item.toolArgs, null, 2);
    for (const line of argsJson.split("\n")) {
      const padded = truncate(line, innerWidth).padEnd(innerWidth);
      lines.push(`${FG_CYAN}${BOX.vertical}${RESET}   ${FG_GRAY}${padded}${RESET}`);
    }
  }

  // Result section
  if (item.toolResult !== undefined) {
    const elapsed = item.elapsedMs !== undefined ? ` (${(item.elapsedMs / 1000).toFixed(1)}s)` : "";
    lines.push(`${FG_CYAN}${BOX.vertical}${RESET} ${FG_GREEN}Result${elapsed}:${RESET}`);
    const resultJson = JSON.stringify(item.toolResult, null, 2);
    const resultLines = resultJson.split("\n").slice(0, 15); // Limit lines
    for (const line of resultLines) {
      const padded = truncate(line, innerWidth).padEnd(innerWidth);
      lines.push(`${FG_CYAN}${BOX.vertical}${RESET}   ${FG_GRAY}${padded}${RESET}`);
    }
    if (resultJson.split("\n").length > 15) {
      lines.push(`${FG_CYAN}${BOX.vertical}${RESET}   ${DIM}... (${resultJson.split("\n").length - 15} more lines)${RESET}`);
    }
  }

  // Bottom border
  lines.push(`${FG_CYAN}${BOX.bottomLeft}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.bottomRight}${RESET}`);

  return lines;
}

/**
 * Render NPC list with highlight
 */
export function renderNpcList(npcs: NpcListItem[], highlightIndex: number, width: number): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${FG_MAGENTA}${BOLD}NPCs Present:${RESET}`);

  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    const isHighlighted = i === highlightIndex;
    const prefix = isHighlighted ? `${BG_HIGHLIGHT}${FG_WHITE} ${EXPANDED_ARROW} ` : `   `;
    const suffix = isHighlighted ? ` ${RESET}` : "";

    const nameStr = `${BOLD}${npc.name}${RESET}${isHighlighted ? BG_HIGHLIGHT : ""}`;
    const summaryStr = ` ${FG_GRAY}${DIM}— ${truncate(npc.summary, width - npc.name.length - 10)}${RESET}`;

    lines.push(prefix + nameStr + summaryStr + suffix);
  }

  lines.push("");
  lines.push(`${DIM}[j/k: move | Enter: details | Esc: back]${RESET}`);

  return lines;
}

/**
 * Render NPC detail panel with tabs
 */
export function renderNpcDetailPanel(
  npc: NpcListItem,
  activeTab: NpcDetailTab,
  width: number
): string[] {
  const lines: string[] = [];
  const innerWidth = width - 4;

  // Double-line top border with name
  const nameLen = npc.name.length + 4;
  const rightPad = Math.max(0, innerWidth - nameLen);
  lines.push(`${FG_MAGENTA}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(innerWidth + 2)}${BOX.doubleTopRight}${RESET}`);
  lines.push(`${FG_MAGENTA}${BOX.doubleVertical}${RESET}  ${BOLD}${npc.name.toUpperCase()}${RESET}${" ".repeat(rightPad)}${FG_MAGENTA}${BOX.doubleVertical}${RESET}`);

  // Tab row
  const tabs: NpcDetailTab[] = ["description", "dm_info", "talk"];
  const tabLabels: Record<NpcDetailTab, string> = {
    description: "Description",
    dm_info: "DM Info",
    talk: "Talk",
  };

  lines.push(`${FG_MAGENTA}${BOX.doubleVertical}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.doubleVertical}${RESET}`);

  let tabRow = `${FG_MAGENTA}${BOX.doubleVertical}${RESET} `;
  for (const tab of tabs) {
    const label = tabLabels[tab];
    if (tab === activeTab) {
      tabRow += `${REVERSE}[${label}]${RESET} `;
    } else {
      tabRow += `${DIM}[${label}]${RESET} `;
    }
  }
  tabRow = tabRow.padEnd(innerWidth + 2 + 20) + `${FG_MAGENTA}${BOX.doubleVertical}${RESET}`;
  lines.push(tabRow);

  lines.push(`${FG_MAGENTA}${BOX.doubleVertical}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.doubleVertical}${RESET}`);

  // Content based on active tab
  const contentLines: string[] = [];

  switch (activeTab) {
    case "description": {
      if (npc.detailsMd) {
        contentLines.push(...wrapText(npc.detailsMd, innerWidth, 0));
      } else if (npc.summary) {
        contentLines.push(...wrapText(npc.summary, innerWidth, 0));
      } else {
        contentLines.push("No description available.");
      }
      contentLines.push("");
      if (npc.tags.length > 0) {
        contentLines.push(`Tags: ${npc.tags.join(", ")}`);
      }
      break;
    }
    case "dm_info": {
      if (npc.payload) {
        const dmFields = ["motivation", "secrets", "attitude", "goals", "fears"];
        let hasContent = false;
        for (const field of dmFields) {
          if (npc.payload[field]) {
            contentLines.push(`${BOLD}${field.charAt(0).toUpperCase() + field.slice(1)}:${RESET}`);
            contentLines.push(...wrapText(String(npc.payload[field]), innerWidth, 2));
            contentLines.push("");
            hasContent = true;
          }
        }
        if (!hasContent) {
          contentLines.push("No DM-specific information available.");
        }
      } else {
        contentLines.push("No DM-specific information available.");
      }
      break;
    }
    case "talk": {
      contentLines.push("Press 't' to start a conversation with this NPC.");
      contentLines.push("");
      contentLines.push(`This will switch to NPC mode where you can`);
      contentLines.push(`speak with ${npc.name} directly.`);
      break;
    }
  }

  // Render content with box borders
  for (const line of contentLines) {
    const padded = truncate(line, innerWidth).padEnd(innerWidth);
    lines.push(`${FG_MAGENTA}${BOX.doubleVertical}${RESET} ${padded} ${FG_MAGENTA}${BOX.doubleVertical}${RESET}`);
  }

  // Add some padding lines
  for (let i = contentLines.length; i < 8; i++) {
    lines.push(`${FG_MAGENTA}${BOX.doubleVertical}${RESET} ${" ".repeat(innerWidth)} ${FG_MAGENTA}${BOX.doubleVertical}${RESET}`);
  }

  // Bottom border
  lines.push(`${FG_MAGENTA}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth + 2)}${BOX.doubleBottomRight}${RESET}`);

  // Help line
  lines.push(`${DIM}[Tab: tabs | t: talk | c: copy | Esc: back]${RESET}`);

  return lines;
}

/**
 * Render the full TUI view based on current state
 */
export function renderTui(state: TuiState): string[] {
  const width = getWidth();
  const lines: string[] = [];

  switch (state.mode) {
    case "normal":
    case "feed_nav": {
      // Render feed items
      for (const item of state.feedItems) {
        if (item.collapsed) {
          lines.push(renderCollapsedItem(item, width));
        } else {
          if (item.type === "tool_call") {
            lines.push(...renderExpandedToolCall(item, width));
          } else if (item.type === "npc_list" && item.npcs) {
            lines.push(...renderNpcList(item.npcs, state.npcListIndex, width));
          } else {
            // Multi-line content for expanded non-tool items
            const text = item.text || "";
            lines.push(...wrapText(text, width));
          }
        }
      }

      // Add navigation hint in feed_nav mode
      if (state.mode === "feed_nav") {
        lines.push("");
        lines.push(`${DIM}[j/k: move | Enter: expand/select | Esc: exit nav]${RESET}`);
      }
      break;
    }

    case "npc_list": {
      // Find the NPC list item
      const npcItem = getCurrentNpcs(state);
      if (npcItem?.npcs) {
        lines.push(...renderNpcList(npcItem.npcs, state.npcListIndex, width));
      }
      break;
    }

    case "npc_detail": {
      const npc = getSelectedNpc(state);
      if (npc) {
        lines.push(...renderNpcDetailPanel(npc, state.npcDetailTab, width));
      }
      break;
    }

    case "expanded_item": {
      const item = state.feedItems.find((i) => i.id === state.highlightedItemId);
      if (item && item.type === "tool_call") {
        lines.push(...renderExpandedToolCall(item, width));
        lines.push("");
        lines.push(`${DIM}[c: copy | Esc: back]${RESET}`);
      }
      break;
    }
  }

  return lines;
}

/**
 * Clear screen and render TUI
 * Respects the status bar by only clearing the scroll region
 */
export function fullRender(state: TuiState): void {
  const lines = renderTui(state);
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;

  // Clear the scroll region (everything except the last line where status bar is)
  // Move to top, clear from cursor to end of scroll region
  let output = `${CSI}H`;  // Move to top-left
  output += `${CSI}1;${rows - 1}r`;  // Set scroll region (rows 1 to rows-1)
  output += `${CSI}J`;  // Clear from cursor to end of screen (within scroll region)

  // Render lines
  const maxLines = rows - 2;  // Leave room for status bar and prompt
  const displayLines = lines.slice(0, maxLines);
  output += displayLines.join("\n");

  // If we have fewer lines than the screen, add newlines to push content up
  if (displayLines.length < maxLines) {
    output += "\n";
  }

  // Move cursor to bottom of scroll region for prompt
  output += `${CSI}${Math.min(displayLines.length + 1, rows - 1)};1H`;

  process.stdout.write(output);
}

/**
 * Render just the navigation hint bar (for incremental updates)
 */
export function renderNavHint(mode: string): string {
  switch (mode) {
    case "feed_nav":
      return `${DIM}[j/k: move | Enter: expand/select | q/Esc: exit nav]${RESET}`;
    case "npc_list":
      return `${DIM}[j/k: move | Enter: details | Esc: back]${RESET}`;
    case "npc_detail":
      return `${DIM}[Tab: tabs | t: talk | c: copy | Esc: back]${RESET}`;
    case "expanded_item":
      return `${DIM}[c: copy | Esc: back]${RESET}`;
    default:
      return `${DIM}[Ctrl+N: navigate]${RESET}`;
  }
}
