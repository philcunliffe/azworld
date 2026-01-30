/**
 * Help modal renderer for azbrowse TUI
 *
 * Renders centered overlay modal displaying command reference.
 */

import type { HelpState } from "../types";
import type { LayoutDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  FG_WHITE,
  FG_CYAN,
  BG_MODAL,
  padRight,
  visibleLength,
  sliceByVisible,
} from "../renderer";

/**
 * Render the help modal
 */
export function renderHelpModal(
  help: HelpState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  // Modal dimensions - centered, 70% width, up to 70% height
  const modalWidth = Math.min(70, Math.floor(layout.terminalCols * 0.7));
  const modalHeight = Math.min(30, Math.floor(layout.terminalRows * 0.7));
  const left = Math.floor((layout.terminalCols - modalWidth) / 2);
  const top = Math.floor((layout.terminalRows - modalHeight) / 2);

  const lines: string[] = [];
  const innerWidth = modalWidth - 2;

  // Top border with title
  const title = " Help ";
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - title.length
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Content area
  const contentHeight = modalHeight - 4; // Account for top border, separator, help line, bottom border
  const visibleContent = help.contentLines.slice(
    help.scrollOffset,
    help.scrollOffset + contentHeight
  );

  // Render content rows
  for (let i = 0; i < contentHeight; i++) {
    const contentLine = visibleContent[i];

    if (contentLine === undefined) {
      lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);
      continue;
    }

    // Check if this is a section header (all caps, no leading spaces)
    const isHeader = /^[A-Z][A-Z\s]+$/.test(contentLine.trim());

    let formattedLine: string;
    if (isHeader) {
      // Section header - cyan and bold
      formattedLine = `${BG_MODAL}${FG_CYAN}${BOLD}${contentLine}${RESET}${BG_MODAL}`;
    } else if (contentLine === "") {
      // Empty line
      formattedLine = `${BG_MODAL}${" ".repeat(innerWidth)}`;
    } else {
      // Regular content line
      formattedLine = `${BG_MODAL}${contentLine}`;
    }

    // Calculate padding
    const contentLen = visibleLength(formattedLine);
    const padding = Math.max(0, innerWidth - contentLen);
    lines.push(
      `${BG_MODAL}${BOX.doubleVertical}${formattedLine}${" ".repeat(padding)}${BOX.doubleVertical}${RESET}`
    );
  }

  // Scroll indicator
  let scrollIndicator = "";
  if (help.contentLines.length > contentHeight) {
    const endLine = Math.min(help.scrollOffset + contentHeight, help.contentLines.length);
    scrollIndicator = `[${help.scrollOffset + 1}-${endLine}/${help.contentLines.length}]`;
  }

  // Separator before help line
  lines.push(
    `${BG_MODAL}${BOX.verticalRight}${BOX.horizontal.repeat(innerWidth)}${BOX.verticalLeft}${RESET}`
  );

  // Help line with scroll indicator
  const helpText = "j/k: scroll  PgUp/PgDn: page  g/G: top/bottom  Esc/q: close";
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
 * Overlay help modal onto screen content
 */
export function overlayHelpModal(
  screenLines: string[],
  help: HelpState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderHelpModal(help, layout);
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
