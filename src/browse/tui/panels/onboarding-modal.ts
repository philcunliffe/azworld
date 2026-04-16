/**
 * Onboarding modal renderer for azbrowse TUI
 *
 * Renders a multi-step wizard for campaign settings.
 */

import type { OnboardingState, OnboardingStep } from "../types";
import type { LayoutDimensions } from "../layout";
import { ONBOARDING_STEPS, getStepOptions, isTextInputStep, isMultiCheckboxStep } from "../state";
import {
  RESET,
  BOLD,
  DIM,
  REVERSE,
  BOX,
  FG_WHITE,
  FG_GRAY,
  FG_CYAN,
  FG_YELLOW,
  FG_GREEN,
  BG_MODAL,
  BG_SELECTION,
  padRight,
  truncate,
  visibleLength,
  sliceByVisible,
} from "../renderer";

/**
 * Step configuration for the onboarding wizard
 */
const STEP_CONFIG: Record<OnboardingStep, {
  title: string;
  description: string;
  example?: string;
}> = {
  worldVibe: {
    title: "World Vibe",
    description: "The overall feel of your world",
    example: "Dark medieval with lingering magic",
  },
  culturalTouchpoints: {
    title: "Cultural Touchpoints",
    description: "Inspirations for tone and style",
    example: "Game of Thrones politics, Tolkien grandeur",
  },
  campaignArc: {
    title: "Campaign Arc",
    description: "What are the heroes working toward?",
    example: "Stop the lich king from rising",
  },
  userNotes: {
    title: "Additional Notes",
    description: "Any other context the AI should know",
    example: "No explicit content, focus on political intrigue",
  },
  contentTone: {
    title: "Content Tone",
    description: "How dark or light should generated content be?",
  },
  rating: {
    title: "Content Rating",
    description: "What content restrictions should apply?",
  },
  contentTypes: {
    title: "Content to Generate",
    description: "Select what content types to create (Space to toggle)",
  },
  scopeSelection: {
    title: "Generation Scope",
    description: "Generate for entire world or specific states?",
  },
  stateSelection: {
    title: "Select States",
    description: "Choose which states to generate content for (Space to toggle)",
  },
  confirm: {
    title: "Confirmation",
    description: "Review and save your settings",
  },
};

/**
 * Render the onboarding modal
 */
export function renderOnboardingModal(
  onboarding: OnboardingState,
  layout: LayoutDimensions
): { lines: string[]; top: number; left: number; width: number } {
  // Modal dimensions - centered, 70% width, up to 70% height
  const modalWidth = Math.min(80, Math.floor(layout.terminalCols * 0.7));
  const modalHeight = Math.min(25, Math.floor(layout.terminalRows * 0.7));
  const left = Math.floor((layout.terminalCols - modalWidth) / 2);
  const top = Math.floor((layout.terminalRows - modalHeight) / 2);

  const lines: string[] = [];
  const innerWidth = modalWidth - 2;

  const stepConfig = STEP_CONFIG[onboarding.currentStep];
  const stepIndex = ONBOARDING_STEPS.indexOf(onboarding.currentStep);
  const totalSteps = ONBOARDING_STEPS.length;

  // Top border with title
  const title = ` Campaign Settings (${stepIndex + 1}/${totalSteps}) `;
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BG_MODAL}${BOX.doubleTopLeft}${BOX.doubleHorizontal.repeat(titlePadding)}${BOLD}${FG_WHITE}${title}${RESET}${BG_MODAL}${BOX.doubleHorizontal.repeat(
      innerWidth - titlePadding - title.length
    )}${BOX.doubleTopRight}${RESET}`
  );

  // Empty line
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Step title
  const stepTitle = `${FG_CYAN}${BOLD}${stepConfig.title}${RESET}`;
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical} ${stepTitle}${BG_MODAL}${" ".repeat(innerWidth - visibleLength(stepTitle) - 2)} ${BOX.doubleVertical}${RESET}`
  );

  // Description
  const descLine = `${DIM}${stepConfig.description}${RESET}`;
  lines.push(
    `${BG_MODAL}${BOX.doubleVertical} ${descLine}${BG_MODAL}${" ".repeat(innerWidth - visibleLength(descLine) - 2)} ${BOX.doubleVertical}${RESET}`
  );

  // Empty line
  lines.push(`${BG_MODAL}${BOX.doubleVertical}${" ".repeat(innerWidth)}${BOX.doubleVertical}${RESET}`);

  // Content area depends on step type
  const contentHeight = modalHeight - 10; // Account for borders, header, help
  const contentLines: string[] = [];

  if (isTextInputStep(onboarding.currentStep)) {
    // Text input mode
    if (stepConfig.example) {
      contentLines.push(`${DIM}Example: ${stepConfig.example}${RESET}`);
      contentLines.push("");
    }

    // Input field with cursor - handle horizontal scrolling
    const inputWidth = innerWidth - 4; // Account for "> " prefix and padding
    const buffer = onboarding.inputBuffer;
    const cursorPos = onboarding.inputCursorPos;

    // Calculate visible window of text to show
    let viewStart = 0;
    if (cursorPos >= inputWidth - 1) {
      // Scroll to keep cursor visible with some context
      viewStart = cursorPos - inputWidth + 2;
    }

    // Extract the visible portion of the buffer
    const visibleBuffer = buffer.slice(viewStart, viewStart + inputWidth);
    const cursorInView = cursorPos - viewStart;

    const before = visibleBuffer.slice(0, cursorInView);
    const cursorChar = visibleBuffer[cursorInView] ?? " ";
    const after = visibleBuffer.slice(cursorInView + 1);

    // Show scroll indicator if text extends beyond view
    const scrollIndicator = viewStart > 0 ? "…" : ">";
    const inputLine = `${scrollIndicator} ${before}${REVERSE}${cursorChar}${RESET}${BG_MODAL}${after}`;
    contentLines.push(inputLine);
  } else if (onboarding.currentStep === "confirm") {
    // Confirmation screen - show summary with scrolling
    const allContentLines: string[] = [];

    allContentLines.push(`${BOLD}Settings Summary:${RESET}`);
    allContentLines.push("");

    const s = onboarding.settings;
    if (s.worldVibe) allContentLines.push(`${FG_CYAN}Vibe:${RESET} ${truncate(s.worldVibe, innerWidth - 10)}`);
    if (s.culturalTouchpoints) allContentLines.push(`${FG_CYAN}Style:${RESET} ${truncate(s.culturalTouchpoints, innerWidth - 10)}`);
    if (s.campaignArc) allContentLines.push(`${FG_CYAN}Arc:${RESET} ${truncate(s.campaignArc, innerWidth - 10)}`);
    if (s.userNotes) allContentLines.push(`${FG_CYAN}Notes:${RESET} ${truncate(s.userNotes, innerWidth - 10)}`);
    if (s.contentTone !== undefined) allContentLines.push(`${FG_CYAN}Tone:${RESET} ${s.contentTone}`);
    if (s.rating) allContentLines.push(`${FG_CYAN}Rating:${RESET} ${s.rating}`);

    allContentLines.push("");
    allContentLines.push(`${BOLD}Generation:${RESET}`);
    const ct = onboarding.generate.contentTypes;
    const hasAnyContent = ct.religions || ct.pantheons || ct.cultures || ct.states;
    if (!hasAnyContent) {
      allContentLines.push(`  ${DIM}(No content selected)${RESET}`);
    } else {
      if (ct.religions) allContentLines.push(`  ${FG_GREEN}[x]${RESET} Religions`);
      if (ct.pantheons) allContentLines.push(`  ${FG_GREEN}[x]${RESET} Pantheons`);
      if (ct.cultures) allContentLines.push(`  ${FG_GREEN}[x]${RESET} Cultures`);
      if (ct.states) allContentLines.push(`  ${FG_GREEN}[x]${RESET} States + Leaders`);
    }

    // Show scope
    if (hasAnyContent) {
      allContentLines.push("");
      if (onboarding.generate.scope === "world") {
        allContentLines.push(`${FG_CYAN}Scope:${RESET} Entire World`);
      } else {
        const selectedCount = onboarding.generate.selectedStateIds.length;
        allContentLines.push(`${FG_CYAN}Scope:${RESET} ${selectedCount} selected state${selectedCount !== 1 ? "s" : ""}`);
      }
    }

    allContentLines.push("");

    // Action options
    const options = getStepOptions(onboarding.currentStep);
    for (let i = 0; i < options.length; i++) {
      const isSelected = i === onboarding.selectedIndex;
      const prefix = isSelected ? `${BG_SELECTION}${FG_WHITE} > ` : "   ";
      const suffix = isSelected ? ` ${RESET}` : "";
      allContentLines.push(`${prefix}${options[i]}${suffix}`);
    }

    // Apply scroll offset
    const scrollOffset = onboarding.scrollOffset || 0;
    const maxOffset = Math.max(0, allContentLines.length - contentHeight);
    const clampedOffset = Math.min(scrollOffset, maxOffset);
    const visibleLines = allContentLines.slice(clampedOffset, clampedOffset + contentHeight);
    contentLines.push(...visibleLines);
  } else if (isMultiCheckboxStep(onboarding.currentStep)) {
    // Multi-checkbox mode (contentTypes, stateSelection)
    if (onboarding.currentStep === "contentTypes") {
      // Content type checkboxes
      const options = getStepOptions(onboarding.currentStep);
      const descriptions = [
        "Generate theological content for each religion",
        "Generate deities for each religion based on form",
        "Generate detailed descriptions for each culture",
        "Generate governments and rulers for each state",
      ];

      for (let i = 0; i < options.length; i++) {
        const isSelected = i === onboarding.selectedIndex;
        const isChecked = onboarding.checkedIndices.has(i);
        const checkbox = isChecked ? `${FG_GREEN}[x]${RESET}${BG_MODAL}` : "[ ]";
        const highlight = isSelected ? `${BG_SELECTION}${FG_WHITE}` : "";
        const reset = isSelected ? `${RESET}${BG_MODAL}` : "";
        contentLines.push(`${highlight} ${checkbox} ${options[i]}${reset}`);
        contentLines.push(`     ${DIM}${descriptions[i]}${RESET}`);
      }
    } else if (onboarding.currentStep === "stateSelection") {
      // State selection list with scrolling
      const allStateLines: string[] = [];
      const states = onboarding.stateList;

      for (let i = 0; i < states.length; i++) {
        const state = states[i];
        const isSelected = i === onboarding.selectedIndex;
        const isChecked = onboarding.checkedIndices.has(i);
        const checkbox = isChecked ? `${FG_GREEN}[x]${RESET}${BG_MODAL}` : "[ ]";
        const highlight = isSelected ? `${BG_SELECTION}${FG_WHITE}` : "";
        const reset = isSelected ? `${RESET}${BG_MODAL}` : "";
        allStateLines.push(`${highlight} ${checkbox} ${state.name}${reset}`);
      }

      if (states.length === 0) {
        allStateLines.push(`${DIM}(No states available)${RESET}`);
      }

      // Apply scroll offset for long lists
      const scrollOffset = onboarding.scrollOffset || 0;
      const maxOffset = Math.max(0, allStateLines.length - contentHeight);
      const clampedOffset = Math.min(scrollOffset, maxOffset);
      const visibleLines = allStateLines.slice(clampedOffset, clampedOffset + contentHeight);
      contentLines.push(...visibleLines);

      // Show selection count at bottom
      const checkedCount = onboarding.checkedIndices.size;
      if (states.length > 0) {
        contentLines.push("");
        contentLines.push(`${DIM}${checkedCount} of ${states.length} states selected${RESET}`);
      }
    }
  } else {
    // Selection mode (tone, rating, scopeSelection)
    const options = getStepOptions(onboarding.currentStep);

    // Add descriptions for special options
    if (onboarding.currentStep === "contentTone") {
      contentLines.push(`${DIM}1 = Gritty (violence, despair)${RESET}`);
      contentLines.push(`${DIM}3 = Balanced (adventure with stakes)${RESET}`);
      contentLines.push(`${DIM}5 = Lighthearted (heroic, hopeful)${RESET}`);
      contentLines.push("");
    } else if (onboarding.currentStep === "rating") {
      contentLines.push(`${DIM}pg     - Family friendly${RESET}`);
      contentLines.push(`${DIM}teen   - Mild violence, no explicit${RESET}`);
      contentLines.push(`${DIM}mature - Darker themes allowed${RESET}`);
      contentLines.push(`${DIM}explicit - No restrictions${RESET}`);
      contentLines.push("");
    } else if (onboarding.currentStep === "scopeSelection") {
      contentLines.push(`${DIM}Choose the scope for content generation:${RESET}`);
      contentLines.push("");
    }

    for (let i = 0; i < options.length; i++) {
      const isSelected = i === onboarding.selectedIndex;
      const prefix = isSelected ? `${BG_SELECTION}${FG_WHITE} > ` : "   ";
      const suffix = isSelected ? ` ${RESET}` : "";
      contentLines.push(`${prefix}${options[i]}${suffix}`);
    }
  }

  // Pad content to fill height
  while (contentLines.length < contentHeight) {
    contentLines.push("");
  }

  // Render content lines
  for (let i = 0; i < contentHeight; i++) {
    const line = contentLines[i] || "";
    const lineLen = visibleLength(line);
    const padding = Math.max(0, innerWidth - lineLen - 2);
    lines.push(`${BG_MODAL}${BOX.doubleVertical} ${line}${BG_MODAL}${" ".repeat(padding)} ${BOX.doubleVertical}${RESET}`);
  }

  // Separator
  lines.push(
    `${BG_MODAL}${BOX.verticalRight}${BOX.horizontal.repeat(innerWidth)}${BOX.verticalLeft}${RESET}`
  );

  // Help line
  let helpText: string;
  if (isTextInputStep(onboarding.currentStep)) {
    helpText = "Enter: confirm  Tab: skip  Esc: cancel";
  } else if (onboarding.currentStep === "confirm") {
    helpText = "j/k: select  PgUp/PgDn: scroll  Enter: confirm  Esc: cancel";
  } else if (isMultiCheckboxStep(onboarding.currentStep)) {
    if (onboarding.currentStep === "stateSelection") {
      helpText = "j/k: move  Space: toggle  PgUp/PgDn: scroll  Enter: confirm";
    } else {
      helpText = "j/k: move  Space: toggle  Enter: confirm  Tab: skip";
    }
  } else {
    helpText = "j/k: select  Enter: confirm  Tab: skip  Esc: cancel";
  }

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
 * Overlay onboarding modal onto screen content
 */
export function overlayOnboardingModal(
  screenLines: string[],
  onboarding: OnboardingState,
  layout: LayoutDimensions
): string[] {
  const { lines: modalLines, top, left, width } = renderOnboardingModal(onboarding, layout);
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
