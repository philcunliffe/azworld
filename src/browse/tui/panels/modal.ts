/**
 * Modal renderer for azbrowse TUI
 *
 * Renders centered overlay modals for generation progress and results.
 */

import type { ModalState, EntityKind } from "../types";
import type { LayoutDimensions } from "../layout";
import { calculateModalDimensions } from "../layout";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  FG_WHITE,
  FG_GRAY,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  FG_CYAN,
  BG_MODAL,
  BG_SELECTION,
  getEntityColor,
  padRight,
  padCenter,
  truncate,
  sliceByVisible,
  visibleLength,
} from "../renderer";

/**
 * Render the modal overlay
 */
export function renderModal(
  modal: ModalState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  // Use large modal for approval (when we have choices, regardless of plan text presence)
  const isApproval = !!(modal.approvalChoices?.length && !modal.isComplete);
  const dims = calculateModalDimensions(layout, isApproval);
  const lines: string[] = [];
  const innerWidth = dims.width - 2;

  // Top border with title
  const title = ` ${modal.title} `;
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - title.length
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Content area
  const contentHeight = dims.height - 4; // -4 for borders and help line
  const contentLines: string[] = [];

  if (modal.error) {
    // Error state
    contentLines.push("");
    contentLines.push(`${FG_RED}${BOLD}Error${RESET}`);
    contentLines.push("");
    contentLines.push(`${FG_RED}${truncate(modal.error, innerWidth - 4)}${RESET}`);
    contentLines.push("");
    contentLines.push(`${DIM}Press Esc to close${RESET}`);
  } else if (modal.approvalChoices?.length && !modal.isComplete) {
    // Approval mode - show plan and choices
    // Parse the plan text and display it
    const planText = modal.pendingPlanText || "(No plan details available)";
    const planLines = planText.split("\n");
    for (const planLine of planLines) {
      contentLines.push(truncate(planLine, innerWidth - 4));
    }
    contentLines.push("");

    contentLines.push(`${DIM}─── Select an action ───${RESET}`);
    contentLines.push("");

    const selectedIdx = modal.approvalSelectedIndex ?? 0;
    for (let i = 0; i < modal.approvalChoices.length; i++) {
      const choice = modal.approvalChoices[i];
      const isSelected = i === selectedIdx;
      const prefix = isSelected ? `${BG_SELECTION}${FG_WHITE} > ` : "   ";
      const suffix = isSelected ? ` ${RESET}` : "";
      const hint = choice.hint ? ` ${DIM}- ${choice.hint}${RESET}` : "";
      contentLines.push(
        `${prefix}${BOLD}${choice.label}${RESET}${isSelected ? BG_SELECTION : ""}${hint}${suffix}`
      );
    }

    contentLines.push("");
    contentLines.push(`${DIM}j/k: select  Enter: confirm  Esc: cancel${RESET}`);
  } else if (!modal.isComplete) {
    // Progress state - differentiate planning vs execution
    const isPlanningPhase = modal.title.toLowerCase().includes("plan");
    contentLines.push("");
    contentLines.push(`${FG_YELLOW}${BOLD}${isPlanningPhase ? "Planning..." : "Generating..."}${RESET}`);
    contentLines.push("");

    if (modal.progress) {
      contentLines.push(truncate(modal.progress, innerWidth - 4));
    }

    // Show appropriate waiting message
    contentLines.push("");
    contentLines.push(`${DIM}${isPlanningPhase ? "Press Esc to cancel" : "Please wait..."}${RESET}`);

    // Show entities created so far
    if (modal.createdEntities.length > 0) {
      contentLines.push("");
      contentLines.push(`${FG_GREEN}Created:${RESET}`);
      for (const entity of modal.createdEntities) {
        const color = getEntityColor(entity.kind);
        contentLines.push(`  ${color}${entity.kind}${RESET} ${entity.name}`);
      }
    }
  } else {
    // Complete state
    contentLines.push("");
    contentLines.push(`${FG_GREEN}${BOLD}Generation Complete${RESET}`);
    contentLines.push("");

    if (modal.createdEntities.length === 0) {
      contentLines.push(`${DIM}No entities created${RESET}`);
    } else {
      contentLines.push(`${FG_WHITE}Created ${modal.createdEntities.length} entities:${RESET}`);
      contentLines.push("");

      // Render entity list with selection
      for (let i = 0; i < modal.createdEntities.length; i++) {
        const entity = modal.createdEntities[i];
        const isSelected = i === modal.selectedIndex;
        const color = getEntityColor(entity.kind);
        const prefix = isSelected ? `${BG_SELECTION}${FG_WHITE} > ` : "   ";
        const suffix = isSelected ? ` ${RESET}` : "";
        const kindStr = padRight(`[${entity.kind}]`, 12);
        contentLines.push(
          `${prefix}${color}${kindStr}${RESET}${isSelected ? BG_SELECTION : ""} ${entity.name}${suffix}`
        );
      }

      contentLines.push("");
      contentLines.push(`${DIM}j/k: select  Enter: go to  Esc: close${RESET}`);
    }
  }

  // Pad content to fill height
  while (contentLines.length < contentHeight) {
    contentLines.push("");
  }

  // Render content lines with borders
  for (let i = 0; i < contentHeight; i++) {
    const line = contentLines[i] || "";
    const paddedLine = padRight(truncate(line, innerWidth - 2), innerWidth - 2);
    lines.push(`${BG_MODAL}${BOX.doubleVertical} ${paddedLine} ${BOX.doubleVertical}${RESET}`);
  }

  // Help line
  const isPlanningPhase = modal.title.toLowerCase().includes("plan");
  const helpText = modal.isComplete
    ? "Press Enter to navigate, Esc to close"
    : modal.approvalChoices?.length
    ? "j/k: select  Enter: confirm  Esc: cancel"
    : isPlanningPhase
    ? "Creating plan... Esc to cancel"
    : "Generating content...";
  const helpLine = padCenter(helpText, innerWidth);
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${DIM}${helpLine}${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`);

  // Bottom border
  lines.push(
    `${BG_MODAL}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth)}${BOX.doubleBottomRight}${RESET}`
  );

  return {
    lines,
    top: dims.top,
    left: dims.left,
    width: dims.width,
  };
}

/**
 * Overlay modal onto screen content
 *
 * Preserves the background content on the left and right of the modal
 * by slicing the original line by visible position.
 */
export function overlayModal(
  screenLines: string[],
  modal: ModalState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderModal(modal, layout);
  const result = [...screenLines];

  for (let i = 0; i < modalLines.length; i++) {
    const screenRow = top + i;
    if (screenRow >= 0 && screenRow < result.length) {
      const originalLine = result[screenRow];
      // Preserve background content on left and right of modal
      const leftContent = sliceByVisible(originalLine, 0, left);
      const rightStart = left + width;
      const rightContent = sliceByVisible(originalLine, rightStart);
      // Pad left content if shorter than expected (handles short lines)
      const leftVisLen = visibleLength(leftContent);
      const leftPadded = leftContent + " ".repeat(Math.max(0, left - leftVisLen));
      result[screenRow] = leftPadded + modalLines[i] + rightContent;
    }
  }

  return result;
}

/**
 * Create a simple confirmation modal
 */
export function renderConfirmModal(
  title: string,
  message: string,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number } {
  const dims = calculateModalDimensions(layout);
  const lines: string[] = [];
  const innerWidth = dims.width - 2;

  // Top border
  const titleStr = ` ${title} `;
  const titlePadding = Math.floor((innerWidth - titleStr.length) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${titleStr}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - titleStr.length
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Empty line
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Message
  const msgLine = padCenter(message, innerWidth);
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${msgLine}${BOX.doubleVertical}${RESET}`);

  // Empty line
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Options
  const options = "  [Y]es    [N]o  ";
  const optLine = padCenter(options, innerWidth);
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${BOLD}${optLine}${RESET}${BG_MODAL}${BOX.doubleVertical}${RESET}`);

  // Empty line
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Bottom border
  lines.push(
    `${BG_MODAL}${BOX.doubleBottomLeft}${BOX.doubleHorizontal.repeat(innerWidth)}${BOX.doubleBottomRight}${RESET}`
  );

  return {
    lines,
    top: Math.floor((layout.terminalRows - lines.length) / 2),
    left: Math.floor((layout.terminalCols - dims.width) / 2),
  };
}
