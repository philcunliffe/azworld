/**
 * Ideas pool modal renderer for azbrowse TUI.
 *
 * Renders a centered modal listing ideas with status filter + actions. Mirrors
 * the onboarding-modal layout so it overlays cleanly on top of the tree/detail
 * panels without rebuilding the underlying screen.
 */

import type { IdeasState, IdeaListItem } from "../types";
import type { LayoutDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  REVERSE,
  BOX,
  FG_WHITE,
  FG_CYAN,
  FG_GREEN,
  FG_YELLOW,
  FG_GRAY,
  BG_MODAL,
  BG_SELECTION,
  visibleLength,
  sliceByVisible,
  truncate,
} from "../renderer";

function statusBadge(status: string): string {
  switch (status) {
    case "used": return `${FG_GRAY}[used]${RESET}${BG_MODAL}`;
    case "pending": return `${FG_GREEN}[pending]${RESET}${BG_MODAL}`;
    default: return `${FG_GRAY}[${status}]${RESET}${BG_MODAL}`;
  }
}

function labelText(item: IdeaListItem): string {
  if (item.labels.length) return item.labels.slice(0, 4).join(", ");
  if (item.labelsStatus === "pending") return "(labeling…)";
  if (item.labelsStatus === "skipped") return "(no labels)";
  return "";
}

/**
 * Render the ideas modal — returns the modal's body lines plus its position
 * and width so the controller can overlay it on top of the existing screen.
 */
export function renderIdeasModal(
  ideas: IdeasState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  const modalWidth = Math.min(96, Math.floor(layout.terminalCols * 0.8));
  const modalHeight = Math.min(30, Math.floor(layout.terminalRows * 0.8));
  const left = Math.floor((layout.terminalCols - modalWidth) / 2);
  const top = Math.floor((layout.terminalRows - modalHeight) / 2);
  const innerWidth = modalWidth - 2;

  const lines: string[] = [];

  // Top border with title
  const filterLabel = ideas.statusFilter[0].toUpperCase() + ideas.statusFilter.slice(1);
  const title = ` Ideas Pool — ${filterLabel} (${ideas.items.length}) `;
  const titlePadding = Math.max(2, Math.floor((innerWidth - title.length) / 2));
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      Math.max(0, innerWidth - titlePadding - title.length)
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Empty spacer
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Reserve 4 lines for header/spacers + 3 for footer (separator + help + bottom border)
  const contentHeight = Math.max(4, modalHeight - 7);
  const contentLines: string[] = [];

  if (ideas.subMode === "add") {
    // Add-idea modal: a single multi-segment input row, mirroring onboarding-modal text input
    contentLines.push(`${BOLD}${FG_WHITE}Add a new idea${RESET}${BG_MODAL}`);
    contentLines.push(`${DIM}Press Enter to submit, Esc to cancel.${RESET}${BG_MODAL}`);
    contentLines.push("");

    const inputWidth = innerWidth - 4;
    const buffer = ideas.inputBuffer;
    const cursorPos = ideas.inputCursorPos;
    let viewStart = 0;
    if (cursorPos >= inputWidth - 1) viewStart = cursorPos - inputWidth + 2;
    const visibleBuffer = buffer.slice(viewStart, viewStart + inputWidth);
    const cursorInView = cursorPos - viewStart;
    const before = visibleBuffer.slice(0, cursorInView);
    const cursorChar = visibleBuffer[cursorInView] ?? " ";
    const after = visibleBuffer.slice(cursorInView + 1);
    const scrollIndicator = viewStart > 0 ? "…" : ">";
    contentLines.push(`${scrollIndicator} ${before}${REVERSE}${cursorChar}${RESET}${BG_MODAL}${after}`);
  } else {
    if (ideas.items.length === 0) {
      contentLines.push(`${DIM}(no ideas in this view — press 'a' to add one)${RESET}${BG_MODAL}`);
    } else {
      // Scroll window: keep selected row visible
      const visibleRows = Math.max(1, contentHeight - 1);
      let viewStart = ideas.scrollOffset;
      if (ideas.selectedIndex < viewStart) viewStart = ideas.selectedIndex;
      if (ideas.selectedIndex >= viewStart + visibleRows) {
        viewStart = ideas.selectedIndex - visibleRows + 1;
      }
      viewStart = Math.max(0, Math.min(viewStart, Math.max(0, ideas.items.length - visibleRows)));

      const visibleItems = ideas.items.slice(viewStart, viewStart + visibleRows);
      for (let i = 0; i < visibleItems.length; i++) {
        const absIndex = viewStart + i;
        const isSelected = absIndex === ideas.selectedIndex;
        const item = visibleItems[i];

        const idTok = item.id.length > 16 ? `${item.id.slice(0, 13)}…` : item.id;
        const status = statusBadge(item.status);
        const labels = labelText(item);
        const labelTok = labels ? `${FG_CYAN}{${labels}}${RESET}${BG_MODAL}` : "";

        const fixedCols = idTok.length + 1 + 9 + 1; // id space + [pending] etc + space
        const labelCols = labels ? Math.min(labels.length + 2, 28) : 0;
        const snippetRoom = Math.max(8, innerWidth - 4 - fixedCols - labelCols - 2);
        const snippet = `${FG_YELLOW}${truncate(item.text.replace(/\s+/g, " "), snippetRoom)}${RESET}${BG_MODAL}`;

        const prefix = isSelected ? `${BG_SELECTION}${FG_WHITE}` : "";
        const suffix = isSelected ? `${RESET}${BG_MODAL}` : "";
        contentLines.push(`${prefix}${idTok} ${status} ${snippet} ${labelTok}${suffix}`);
      }
      if (ideas.items.length > visibleRows) {
        contentLines.push(`${DIM}↑/↓ to scroll · showing ${visibleItems.length}/${ideas.items.length}${RESET}${BG_MODAL}`);
      }
    }
  }

  // Status/transient feedback line (used for "Idea added", error etc.)
  if (ideas.status) {
    contentLines.push("");
    contentLines.push(`${FG_YELLOW}${ideas.status}${RESET}${BG_MODAL}`);
  }

  while (contentLines.length < contentHeight) contentLines.push("");

  for (let i = 0; i < contentHeight; i++) {
    const line = contentLines[i] || "";
    const lineLen = visibleLength(line);
    const padding = Math.max(0, innerWidth - lineLen - 2);
    lines.push(`${BG_MODAL}${BOX.doubleVertical} ${line}${BG_MODAL}${" ".repeat(padding)} ${BOX.doubleVertical}${RESET}`);
  }

  // Separator
  lines.push(`${BG_MODAL}${BOX.verticalRight}${BOX.horizontal.repeat(innerWidth)}${BOX.verticalLeft}${RESET}`);

  // Help footer
  const helpText = ideas.subMode === "add"
    ? "Enter: add  Esc: cancel  ←/→: cursor"
    : "j/k: move  a: add  m: mark used  d: delete  r: relabel  Tab: filter  q/Esc: close";
  const helpPadding = Math.max(0, innerWidth - helpText.length - 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical}${DIM} ${helpText}${" ".repeat(helpPadding)} ${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`
  );

  // Bottom border
  lines.push(
    `${BG_MODAL}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth)}${BOX.doubleBottomRight}${RESET}`
  );

  return { lines, top, left, width: modalWidth };
}

/**
 * Overlay the ideas modal onto an already-rendered screen.
 */
export function overlayIdeasModal(
  screenLines: string[],
  ideas: IdeasState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderIdeasModal(ideas, layout);
  const result = [...screenLines];

  for (let i = 0; i < modalLines.length; i++) {
    const screenRow = top + i;
    if (screenRow >= 0 && screenRow < result.length) {
      const originalLine = result[screenRow];
      const leftContent = sliceByVisible(originalLine, 0, left);
      const rightStart = left + width;
      const rightContent = sliceByVisible(originalLine, rightStart);
      const leftVisLen = visibleLength(leftContent);
      const leftPadded = leftContent + " ".repeat(Math.max(0, left - leftVisLen));
      result[screenRow] = leftPadded + modalLines[i] + rightContent;
    }
  }

  return result;
}
