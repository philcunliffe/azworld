/**
 * Modal renderer for azbrowse TUI
 *
 * Renders centered overlay modals for generation progress and results.
 */

import type { ModalState, EntityKind, EntityEditField } from "../types";
import type { LayoutDimensions } from "../layout";
import { calculateModalDimensions } from "../layout";
import type { EntityPlan } from "../../gen-agent";
import {
  RESET,
  BOLD,
  DIM,
  REVERSE,
  BOX,
  FG_WHITE,
  FG_GRAY,
  FG_GREEN,
  FG_RED,
  FG_YELLOW,
  FG_CYAN,
  FG_MAGENTA,
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
    // Approval mode - show entities on left, plan details on right
    const entities = (modal.pendingEntities || []) as EntityPlan[];
    const hasEntities = entities.length > 0;

    // Calculate split: left panel (entities) ~45%, right panel (context) ~55%
    const leftPanelWidth = hasEntities ? Math.floor((innerWidth - 3) * 0.45) : 0;  // -3 for border
    const rightPanelWidth = hasEntities ? innerWidth - leftPanelWidth - 3 : innerWidth - 2;

    // Calculate available height for content
    // Reserve: separator (1), actions (1), empty (1), help (1) = 4 lines
    const reservedLines = 4;
    const availableContentHeight = Math.max(1, contentHeight - reservedLines);

    if (hasEntities) {
      // Build left panel lines (entity list)
      const leftLines: string[] = [];
      leftLines.push(`${BOLD}ENTITIES TO CREATE${RESET}`);
      leftLines.push(`${DIM}${"─".repeat(leftPanelWidth - 2)}${RESET}`);

      const selectedIdx = modal.entitySelectionIndex ?? 0;
      const editingField = modal.editingEntityField;
      const editBuffer = modal.editBuffer ?? "";
      const editCursorPos = modal.editCursorPos ?? 0;

      // Calculate how many lines each entity takes (for scrolling)
      // Each entity: 1 header + 1 reason + N connections + 0-1 custom prompt + 0-1 separator
      const entityLineStarts: number[] = [];  // Line index where each entity starts
      let lineCount = 2;  // Start after header lines
      for (let i = 0; i < entities.length; i++) {
        entityLineStarts.push(lineCount);
        const entity = entities[i];
        const isSelected = i === selectedIdx;
        lineCount += 2;  // Header + reason
        if (entity.connectsTo) lineCount += entity.connectsTo.length;
        if (isSelected || (entity.customPrompt && entity.customPrompt.length > 0)) lineCount += 1;
        if (i < entities.length - 1) lineCount += 1;  // Separator
      }

      // Calculate scroll offset to keep selected entity visible
      const headerLines = 2;
      const availableForEntities = availableContentHeight - headerLines;
      let entityScrollOffset = 0;
      if (entityLineStarts.length > 0 && availableForEntities > 0) {
        const selectedStart = entityLineStarts[selectedIdx] - headerLines;
        // Calculate lines needed for selected entity
        const selectedEnd = selectedIdx < entities.length - 1
          ? entityLineStarts[selectedIdx + 1] - headerLines
          : lineCount - headerLines;
        const totalEntityLines = lineCount - headerLines;

        if (totalEntityLines > availableForEntities) {
          // Need scrolling - position so selected entity is visible
          // Try to show selected entity near the top (1/4 down) with some context
          const targetOffset = Math.max(0, selectedStart - Math.floor(availableForEntities / 4));
          // But ensure we don't scroll past the end
          const maxOffset = Math.max(0, totalEntityLines - availableForEntities);
          entityScrollOffset = Math.min(targetOffset, maxOffset);
        }
      }

      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const isSelected = i === selectedIdx;
        const icon = entity.type === "location" ? "📍" :
                     entity.type === "npc" ? "👤" :
                     entity.type === "faction" ? "🏛️" :
                     entity.type === "event" ? "⚡" : "📄";

        // Selection marker
        const marker = isSelected ? `${BG_SELECTION}${FG_WHITE} > ` : "   ";
        const suffix = isSelected ? ` ${RESET}` : "";

        // Entity header line with name - read-only display, editing happens in right panel
        const kindStr = entity.kind ? ` (${entity.kind})` : "";
        const nameDisplay = truncate(entity.name, leftPanelWidth - 10);

        leftLines.push(`${marker}${icon} ${FG_GREEN}${nameDisplay}${RESET}${isSelected ? BG_SELECTION : ""}${DIM}${kindStr}${RESET}${suffix}`);

        // Reason line (indented) - read-only display, editing happens in right panel
        const reasonDisplay = truncate(entity.reason || "(no reason)", leftPanelWidth - 8);
        const reasonPrefix = isSelected ? `${BG_SELECTION}     ` : "     ";
        const reasonSuffix = isSelected ? ` ${RESET}` : "";
        leftLines.push(`${reasonPrefix}${DIM}"${reasonDisplay}"${RESET}${reasonSuffix}`);

        // Show links (connectsTo) for this entity
        if (entity.connectsTo && entity.connectsTo.length > 0) {
          for (const conn of entity.connectsTo) {
            const linkPrefix = isSelected ? `${BG_SELECTION}     ` : "     ";
            const linkSuffix = isSelected ? ` ${RESET}` : "";
            const relMarker = conn.isNew ? "" : conn.isExisting ? `${FG_YELLOW}*${RESET}` : "";
            const linkDisplay = truncate(`└─ ${conn.rel}: ${conn.name}`, leftPanelWidth - 8);
            leftLines.push(`${linkPrefix}${FG_CYAN}${linkDisplay}${RESET}${relMarker}${linkSuffix}`);
          }
        }

        // Custom prompt line (if any) - read-only display, editing happens in right panel
        const hasCustomPrompt = entity.customPrompt && entity.customPrompt.length > 0;
        if (isSelected || hasCustomPrompt) {
          const promptDisplay = hasCustomPrompt
            ? truncate(entity.customPrompt!, leftPanelWidth - 12)
            : "none";

          const promptPrefix = isSelected ? `${BG_SELECTION}     ` : "     ";
          const promptSuffix = isSelected ? ` ${RESET}` : "";
          const promptColor = hasCustomPrompt ? FG_MAGENTA : DIM;
          leftLines.push(`${promptPrefix}${promptColor}[prompt: ${promptDisplay}]${RESET}${promptSuffix}`);
        }

        // Empty line between entities
        if (i < entities.length - 1) {
          leftLines.push(isSelected ? `${BG_SELECTION}${" ".repeat(leftPanelWidth)}${RESET}` : "");
        }
      }

      // Build right panel lines (entity details for selected entity)
      const rightLines: string[] = [];
      const selectedEntity = entities[selectedIdx];

      if (selectedEntity) {
        rightLines.push(`${BOLD}ENTITY DETAILS${RESET}`);
        rightLines.push(`${DIM}${"─".repeat(rightPanelWidth - 2)}${RESET}`);

        // Entity type and kind
        const icon = selectedEntity.type === "location" ? "📍" :
                     selectedEntity.type === "npc" ? "👤" :
                     selectedEntity.type === "faction" ? "🏛️" :
                     selectedEntity.type === "event" ? "⚡" : "📄";

        // Name section (editable)
        if (editingField === "name") {
          const before = editBuffer.slice(0, editCursorPos);
          const cursorChar = editBuffer[editCursorPos] ?? " ";
          const after = editBuffer.slice(editCursorPos + 1);
          rightLines.push(`${icon} ${FG_GREEN}${BOLD}${before}${REVERSE}${cursorChar}${RESET}${FG_GREEN}${BOLD}${after}${RESET}`);
        } else {
          rightLines.push(`${icon} ${FG_GREEN}${BOLD}${selectedEntity.name}${RESET}`);
        }
        rightLines.push(`   Type: ${FG_CYAN}${selectedEntity.type}${RESET}${selectedEntity.kind ? ` (${selectedEntity.kind})` : ""}`);
        rightLines.push("");

        // Reason section
        rightLines.push(`${BOLD}Reason:${RESET}`);
        if (editingField === "reason") {
          // Show edit buffer with cursor (single line for simplicity)
          const before = editBuffer.slice(0, editCursorPos);
          const cursorChar = editBuffer[editCursorPos] ?? " ";
          const after = editBuffer.slice(editCursorPos + 1);
          rightLines.push(`   ${before}${REVERSE}${cursorChar}${RESET}${after}`);
        } else {
          const reasonText = selectedEntity.reason || "(no reason specified)";
          // Word wrap reason text
          const reasonWords = reasonText.split(" ");
          let currentLine = "   ";
          for (const word of reasonWords) {
            if (currentLine.length + word.length + 1 > rightPanelWidth - 2) {
              rightLines.push(currentLine);
              currentLine = "   " + word;
            } else {
              currentLine += (currentLine.length > 3 ? " " : "") + word;
            }
          }
          if (currentLine.length > 3) rightLines.push(currentLine);
        }
        rightLines.push("");

        // Connections section
        if (selectedEntity.connectsTo && selectedEntity.connectsTo.length > 0) {
          rightLines.push(`${BOLD}Connections:${RESET}`);
          for (const conn of selectedEntity.connectsTo) {
            const marker = conn.isNew ? `${FG_GREEN}(new)${RESET}` :
                          conn.isExisting ? `${FG_YELLOW}(existing)${RESET}` : "";
            rightLines.push(`   ${FG_CYAN}${conn.rel}${RESET} → ${conn.name} ${marker}`);
          }
          rightLines.push("");
        }

        // Custom prompt section (always show when editing, otherwise only if has content)
        if (editingField === "customPrompt" || selectedEntity.customPrompt) {
          rightLines.push(`${BOLD}Custom Prompt:${RESET}`);
          if (editingField === "customPrompt") {
            const before = editBuffer.slice(0, editCursorPos);
            const cursorChar = editBuffer[editCursorPos] ?? " ";
            const after = editBuffer.slice(editCursorPos + 1);
            rightLines.push(`   ${FG_MAGENTA}${before}${REVERSE}${cursorChar}${RESET}${FG_MAGENTA}${after}${RESET}`);
          } else {
            const promptWords = selectedEntity.customPrompt!.split(" ");
            let promptLine = "   ";
            for (const word of promptWords) {
              if (promptLine.length + word.length + 1 > rightPanelWidth - 2) {
                rightLines.push(`${FG_MAGENTA}${promptLine}${RESET}`);
                promptLine = "   " + word;
              } else {
                promptLine += (promptLine.length > 3 ? " " : "") + word;
              }
            }
            if (promptLine.length > 3) rightLines.push(`${FG_MAGENTA}${promptLine}${RESET}`);
          }
          rightLines.push("");
        }

        // Edit hints at bottom
        rightLines.push(`${DIM}${"─".repeat(rightPanelWidth - 2)}${RESET}`);
        rightLines.push(`${DIM}Press to edit:${RESET}`);
        rightLines.push(`  ${FG_GREEN}n${RESET} name  ${FG_GREEN}r${RESET} reason  ${FG_GREEN}p${RESET} prompt  ${FG_GREEN}e${RESET} $EDITOR`);
      } else {
        rightLines.push(`${BOLD}PLAN DETAILS${RESET}`);
        rightLines.push(`${DIM}${"─".repeat(rightPanelWidth - 2)}${RESET}`);

        // Fallback to plan text if no entity selected
        const planText = modal.pendingPlanText || "";
        const planLines = planText.split("\n");
        const scrollOffset = modal.planScrollOffset ?? 0;
        const availableRightHeight = availableContentHeight - 2;
        const maxOffset = Math.max(0, planLines.length - availableRightHeight);
        const clampedOffset = Math.min(scrollOffset, maxOffset);
        const visiblePlanLines = planLines.slice(clampedOffset, clampedOffset + availableRightHeight);

        for (const line of visiblePlanLines) {
          rightLines.push(truncate(line, rightPanelWidth - 2));
        }
      }

      // Pad right panel if needed
      while (rightLines.length < availableContentHeight) {
        rightLines.push("");
      }

      // Apply scroll offset to left panel
      // Keep header lines (first 2), then slice entity content
      const leftHeader = leftLines.slice(0, headerLines);
      const leftContent = leftLines.slice(headerLines);
      const visibleLeftContent = leftContent.slice(entityScrollOffset, entityScrollOffset + availableForEntities);
      const scrolledLeftLines = [...leftHeader, ...visibleLeftContent];

      // Pad left panel if needed
      while (scrolledLeftLines.length < availableContentHeight) {
        scrolledLeftLines.push("");
      }

      // Add scroll indicator to header if scrolled
      const totalEntityLines = leftContent.length;
      if (totalEntityLines > availableForEntities) {
        const scrollInfo = ` [${entityScrollOffset + 1}-${Math.min(entityScrollOffset + availableForEntities, totalEntityLines)}/${totalEntityLines}]`;
        scrolledLeftLines[1] = `${DIM}${"─".repeat(Math.max(0, leftPanelWidth - 2 - scrollInfo.length))}${scrollInfo}${RESET}`;
      }

      // Combine panels horizontally
      for (let i = 0; i < availableContentHeight; i++) {
        // Truncate then pad to ensure lines fit within panel width
        const leftTruncated = sliceByVisible(scrolledLeftLines[i] || "", 0, leftPanelWidth);
        const rightTruncated = sliceByVisible(rightLines[i] || "", 0, rightPanelWidth);
        const leftLine = padRight(leftTruncated, leftPanelWidth);
        const rightLine = padRight(rightTruncated, rightPanelWidth);
        contentLines.push(`${leftLine}${DIM}│${RESET}${rightLine}`);
      }

      // Separator line
      contentLines.push(`${DIM}${"─".repeat(leftPanelWidth)}┴${"─".repeat(rightPanelWidth)}${RESET}`);

    } else {
      // No entities - just show plan text (for modals without entity editing like description gen)
      const planText = modal.pendingPlanText || "(No plan details available)";
      const planLines = planText.split("\n");

      const scrollOffset = modal.planScrollOffset ?? 0;
      const maxOffset = Math.max(0, planLines.length - availableContentHeight);
      const clampedOffset = Math.min(scrollOffset, maxOffset);
      const visibleLines = planLines.slice(clampedOffset, clampedOffset + availableContentHeight);

      for (const line of visibleLines) {
        contentLines.push(truncate(line, innerWidth - 4));
      }

      // Pad if shorter
      while (contentLines.length < availableContentHeight) {
        contentLines.push("");
      }

      // Scroll indicator
      const scrollIndicator = planLines.length > availableContentHeight
        ? ` [${clampedOffset + 1}-${Math.min(clampedOffset + availableContentHeight, planLines.length)}/${planLines.length}]`
        : "";
      contentLines.push(`${DIM}${"─".repeat(innerWidth - 10 - scrollIndicator.length)}${scrollIndicator}${RESET}`);
    }

    // Action hints
    const approveChoice = modal.approvalChoices.find(c => c.value !== "cancel");
    const approveLabel = approveChoice?.label || "Approve";
    contentLines.push(`  ${FG_GREEN}Enter${RESET} ${approveLabel}    ${FG_RED}Esc${RESET} Cancel`);

  } else if (!modal.isComplete) {
    // Progress state - differentiate planning vs execution vs talk
    const isPlanningPhase = modal.title.toLowerCase().includes("plan");
    const isTalkMode = modal.title.toLowerCase().includes("talking to");

    if (isTalkMode) {
      // Talk mode - show full multi-line conversation with word wrap
      contentLines.push("");
      if (modal.progress) {
        const progressLines = modal.progress.split("\n");
        const maxLineWidth = innerWidth - 4;
        for (const line of progressLines) {
          if (line.length <= maxLineWidth) {
            contentLines.push(line);
          } else {
            // Word wrap long lines
            const words = line.split(" ");
            let currentLine = "";
            for (const word of words) {
              if (currentLine.length === 0) {
                currentLine = word;
              } else if (currentLine.length + 1 + word.length <= maxLineWidth) {
                currentLine += " " + word;
              } else {
                contentLines.push(currentLine);
                currentLine = word;
              }
            }
            if (currentLine.length > 0) {
              contentLines.push(currentLine);
            }
          }
        }
      }
    } else {
      // Regular progress mode (planning/generating)
      contentLines.push("");
      contentLines.push(`${FG_YELLOW}${BOLD}${isPlanningPhase ? "Planning..." : "Generating..."}${RESET}`);
      contentLines.push("");

      if (modal.progress) {
        contentLines.push(truncate(modal.progress, innerWidth - 4));
      }

      // Show appropriate waiting message
      contentLines.push("");
      contentLines.push(`${DIM}${isPlanningPhase ? "Press Esc to cancel" : "Please wait..."}${RESET}`);
    }

    // Show entities created so far
    if (modal.createdEntities.length > 0) {
      contentLines.push("");
      contentLines.push(`${FG_GREEN}Created:${RESET}`);
      for (const entity of modal.createdEntities) {
        const color = getEntityColor(entity.kind);
        contentLines.push(`  ${color}${entity.kind}${RESET} ${entity.name}`);
      }
    }
  } else if (modal.message) {
    contentLines.push("");
    const messageLines = modal.message.split("\n");
    const maxLineWidth = innerWidth - 4;
    for (const line of messageLines) {
      if (line.length <= maxLineWidth) {
        contentLines.push(line);
        continue;
      }

      const words = line.split(" ");
      let currentLine = "";
      for (const word of words) {
        if (!currentLine) {
          currentLine = word;
        } else if (currentLine.length + 1 + word.length <= maxLineWidth) {
          currentLine += " " + word;
        } else {
          contentLines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) {
        contentLines.push(currentLine);
      }
    }
    contentLines.push("");
    contentLines.push(`${DIM}Press Esc to close${RESET}`);
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
  const isTalkMode = modal.title.toLowerCase().includes("talking to");
  const hasEntities = modal.pendingEntities && modal.pendingEntities.length > 0;
  const isEditing = modal.editingEntityField !== null && modal.editingEntityField !== undefined;
  const helpText = modal.isComplete
    ? "Press Enter to navigate, Esc to close"
    : modal.approvalChoices?.length
    ? isEditing
      ? "Type to edit  Enter: save  Esc: cancel"
      : hasEntities
        ? "j/k: select  n/r/p: edit  e: $EDITOR  Enter: approve  Esc: cancel"
        : "j/k: scroll  Enter: approve  Esc: cancel"
    : isTalkMode
    ? "Type below, Enter to send, Esc to exit"
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
