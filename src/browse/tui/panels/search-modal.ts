/**
 * Search modal renderer for azbrowse TUI
 *
 * Renders centered overlay modal for global search.
 */

import type { SearchState, SearchResult } from "../types";
import type { LayoutDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  REVERSE,
  BOX,
  FG_WHITE,
  FG_GRAY,
  BG_MODAL,
  BG_SELECTION,
  getEntityColor,
  padRight,
  truncate,
  visibleLength,
  sliceByVisible,
} from "../renderer";

/**
 * Render the search modal
 */
export function renderSearchModal(
  search: SearchState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  // Modal dimensions - centered, 70% width, up to 60% height
  const modalWidth = Math.min(80, Math.floor(layout.terminalCols * 0.7));
  const modalHeight = Math.min(25, Math.floor(layout.terminalRows * 0.6));
  const left = Math.floor((layout.terminalCols - modalWidth) / 2);
  const top = Math.floor((layout.terminalRows - modalHeight) / 2);

  const lines: string[] = [];
  const innerWidth = modalWidth - 2;

  // Top border with title
  const title = " Search ";
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - title.length
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Search input line with cursor
  const inputPrefix = "/ ";
  const before = search.query.slice(0, search.cursorPos);
  const cursorChar = search.query[search.cursorPos] ?? " ";
  const after = search.query.slice(search.cursorPos + 1);
  const inputLine = `${inputPrefix}${before}${REVERSE}${cursorChar}${RESET}${BG_MODAL}${after}`;
  const inputPadding = innerWidth - 2 - visibleLength(inputLine);
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical} ${inputLine}${" ".repeat(Math.max(0, inputPadding))} ${BOX.doubleVertical}${RESET}`
  );

  // Separator
  lines.push(
    `${BG_MODAL}${BOX.verticalRight}${BOX.horizontal.repeat(innerWidth)}${BOX.verticalLeft}${RESET}`
  );

  // Results area
  const resultsHeight = modalHeight - 6; // Account for borders, input, separator, help
  const visibleResults = search.results.slice(
    search.scrollOffset,
    search.scrollOffset + resultsHeight
  );

  if (search.results.length === 0) {
    // No results message
    const msg = search.query.length < 2 ? "Type to search..." : "No results found";
    lines.push(
      `${BG_MODAL}${BOX.doubleVertical} ${DIM}${padRight(msg, innerWidth - 2)}${RESET}${BG_MODAL} ${BOX.doubleVertical}${RESET}`
    );
    for (let i = 1; i < resultsHeight; i++) {
      lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);
    }
  } else {
    // Render result rows
    for (let i = 0; i < resultsHeight; i++) {
      const resultIdx = search.scrollOffset + i;
      const result = visibleResults[i];

      if (!result) {
        lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);
        continue;
      }

      const isSelected = resultIdx === search.selectedIndex;
      const color = getEntityColor(result.kind);

      // Format: [kind] Name   breadcrumb
      const kindTag = `[${result.kind}]`;
      const nameWidth = Math.floor((innerWidth - 6) * 0.5);
      const breadcrumbWidth = innerWidth - 6 - nameWidth - kindTag.length - 2;

      const name = truncate(result.name, nameWidth);
      const breadcrumb = truncate(result.breadcrumb || "", breadcrumbWidth);

      let lineContent: string;
      if (isSelected) {
        lineContent = `${BG_SELECTION}${FG_WHITE} > ${color}${kindTag}${RESET}${BG_SELECTION} ${padRight(name, nameWidth)} ${DIM}${breadcrumb}${RESET}`;
      } else {
        lineContent = `${BG_MODAL}   ${color}${kindTag}${RESET}${BG_MODAL} ${padRight(name, nameWidth)} ${DIM}${breadcrumb}${RESET}${BG_MODAL}`;
      }

      // Pad to full width
      const contentLen = visibleLength(lineContent);
      const padding = Math.max(0, innerWidth - contentLen);
      const bg = isSelected ? BG_SELECTION : BG_MODAL;
      lines.push(
        `${BG_MODAL}${BOX.doubleVertical}${lineContent}${bg}${" ".repeat(padding)}${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`
      );
    }
  }

  // Scroll indicator
  let scrollIndicator = "";
  if (search.results.length > resultsHeight) {
    scrollIndicator = `[${search.scrollOffset + 1}-${Math.min(search.scrollOffset + resultsHeight, search.results.length)}/${search.results.length}]`;
  }

  // Help line with scroll indicator
  const helpText = "j/k: select  Enter: go  Esc: close";
  const helpPadding = innerWidth - helpText.length - scrollIndicator.length - 2;
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical}${DIM} ${helpText}${" ".repeat(Math.max(0, helpPadding))}${scrollIndicator} ${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`
  );

  // Bottom border
  lines.push(
    `${BG_MODAL}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth)}${BOX.doubleBottomRight}${RESET}`
  );

  return { lines, top, left, width: modalWidth };
}

/**
 * Overlay search modal onto screen content
 */
export function overlaySearchModal(
  screenLines: string[],
  search: SearchState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderSearchModal(search, layout);
  const result = [...screenLines];

  for (let i = 0; i < modalLines.length; i++) {
    const screenRow = top + i;
    if (screenRow >= 0 && screenRow < result.length) {
      const originalLine = result[screenRow];
      // Preserve background content on left and right of modal
      const leftContent = sliceByVisible(originalLine, 0, left);
      const rightStart = left + width;
      const rightContent = sliceByVisible(originalLine, rightStart);
      // Pad left content if shorter than expected
      const leftVisLen = visibleLength(leftContent);
      const leftPadded = leftContent + " ".repeat(Math.max(0, left - leftVisLen));
      result[screenRow] = leftPadded + modalLines[i] + rightContent;
    }
  }

  return result;
}
