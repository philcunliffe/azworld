/**
 * Field selection modal for azbrowse TUI
 *
 * Renders a modal for selecting which fields to regenerate on an existing entity.
 */

import type { FieldSelectionState } from "../types";
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
  BG_MODAL,
  BG_SELECTION,
  padRight,
  truncate,
  visibleLength,
  sliceByVisible,
} from "../renderer";

/**
 * Render the field selection modal
 */
export function renderFieldSelectionModal(
  fieldSelection: FieldSelectionState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  // Modal dimensions - centered, 60% width, up to 70% height
  const modalWidth = Math.min(70, Math.floor(layout.terminalCols * 0.6));
  const modalHeight = Math.min(25, Math.floor(layout.terminalRows * 0.7));
  const left = Math.floor((layout.terminalCols - modalWidth) / 2);
  const top = Math.floor((layout.terminalRows - modalHeight) / 2);

  const lines: string[] = [];
  const innerWidth = modalWidth - 2;

  // Top border with title
  const title = ` Regenerate Fields: ${truncate(fieldSelection.entityName, 30)} `;
  const titlePadding = Math.floor((innerWidth - visibleLength(title)) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - visibleLength(title)
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Content area
  const contentHeight = modalHeight - 6; // Account for borders, header, hint area, help
  const contentLines: string[] = [];

  // Description
  contentLines.push(`${DIM}Select fields to regenerate (Space to toggle)${RESET}`);
  contentLines.push("");

  // Track current index for highlighting
  let currentIndex = 0;

  // Core Fields section
  if (fieldSelection.coreFields.length > 0) {
    contentLines.push(`${FG_CYAN}${BOLD}Core Fields${RESET}`);
    for (const field of fieldSelection.coreFields) {
      const isSelected = currentIndex === fieldSelection.selectedIndex;
      const isChecked = fieldSelection.selectedFields.has(field);
      const checkbox = isChecked ? `${FG_GREEN}[x]${RESET}${BG_MODAL}` : "[ ]";
      const highlight = isSelected ? `${BG_SELECTION}${FG_WHITE}` : "";
      const reset = isSelected ? `${RESET}${BG_MODAL}` : "";
      contentLines.push(`${highlight}  ${checkbox} ${field}${reset}`);
      currentIndex++;
    }
    contentLines.push("");
  }

  // Payload Fields section
  if (fieldSelection.payloadFields.length > 0) {
    contentLines.push(`${FG_CYAN}${BOLD}Payload Fields${RESET}`);
    for (const field of fieldSelection.payloadFields) {
      const isSelected = currentIndex === fieldSelection.selectedIndex;
      const isChecked = fieldSelection.selectedFields.has(field);
      const checkbox = isChecked ? `${FG_GREEN}[x]${RESET}${BG_MODAL}` : "[ ]";
      const highlight = isSelected ? `${BG_SELECTION}${FG_WHITE}` : "";
      const reset = isSelected ? `${RESET}${BG_MODAL}` : "";
      contentLines.push(`${highlight}  ${checkbox} ${field}${reset}`);
      currentIndex++;
    }
    contentLines.push("");
  }

  // Show selection count
  const selectedCount = fieldSelection.selectedFields.size;
  contentLines.push(`${DIM}${selectedCount} field${selectedCount !== 1 ? "s" : ""} selected${RESET}`);

  // Apply scroll offset for long lists
  const scrollOffset = fieldSelection.scrollOffset || 0;
  const maxOffset = Math.max(0, contentLines.length - contentHeight);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const visibleLines = contentLines.slice(clampedOffset, clampedOffset + contentHeight);

  // Pad content to fill height
  while (visibleLines.length < contentHeight) {
    visibleLines.push("");
  }

  // Render content lines with borders
  for (let i = 0; i < contentHeight; i++) {
    const line = visibleLines[i] || "";
    const lineLen = visibleLength(line);
    const padding = Math.max(0, innerWidth - lineLen - 2);
    lines.push(`${BG_MODAL}${BOX.doubleVertical} ${line}${BG_MODAL}${" ".repeat(padding)} ${BOX.doubleVertical}${RESET}`);
  }

  // Separator
  lines.push(
    `${BG_MODAL}${BOX.verticalRight}${BOX.horizontal.repeat(innerWidth)}${BOX.verticalLeft}${RESET}`
  );

  // Hint input area
  const hintLabel = `${FG_YELLOW}Hint:${RESET}${BG_MODAL} `;
  const hintLabelLen = 6; // "Hint: "
  const hintInputWidth = innerWidth - hintLabelLen - 2;

  // Calculate visible window of hint text
  let viewStart = 0;
  if (fieldSelection.hintCursorPos >= hintInputWidth - 1) {
    viewStart = fieldSelection.hintCursorPos - hintInputWidth + 2;
  }

  const visibleHint = fieldSelection.hint.slice(viewStart, viewStart + hintInputWidth);
  const cursorInView = fieldSelection.hintCursorPos - viewStart;

  const before = visibleHint.slice(0, cursorInView);
  const cursorChar = visibleHint[cursorInView] ?? " ";
  const after = visibleHint.slice(cursorInView + 1);
  const hintInput = `${before}${REVERSE}${cursorChar}${RESET}${BG_MODAL}${after}`;
  const hintInputLen = visibleLength(before) + 1 + visibleLength(after);
  const hintPadding = Math.max(0, hintInputWidth - hintInputLen);

  lines.push(`${BG_MODAL}${BOX.doubleVertical} ${hintLabel}${hintInput}${" ".repeat(hintPadding)} ${BOX.doubleVertical}${RESET}`);

  // Help line
  const helpText = "j/k: move  Space: toggle  Enter: generate  Esc: cancel";
  const helpPadding = innerWidth - helpText.length - 2;
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical}${DIM} ${helpText}${" ".repeat(Math.max(0, helpPadding))} ${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`
  );

  // Bottom border
  lines.push(
    `${BG_MODAL}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth)}${BOX.doubleBottomRight}${RESET}`
  );

  return { lines, top, left, width: modalWidth };
}

/**
 * Overlay field selection modal onto screen content
 */
export function overlayFieldSelectionModal(
  screenLines: string[],
  fieldSelection: FieldSelectionState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderFieldSelectionModal(fieldSelection, layout);
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
