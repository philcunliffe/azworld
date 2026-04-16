/**
 * side-sheet.js - Slide-in panel for generation/modification plan approval.
 *
 * Renders from the right side when there is a pending generation plan
 * or field-selection form to approve. Supports two pending kinds:
 *   - Entity generation plans (list of planned entities with metadata)
 *   - Field selection forms (checkbox grid for selective regeneration)
 */

import { escapeHtml, pretty } from '../lib/util.js';

/**
 * Render the side sheet panel.
 * Returns an empty string when there is nothing pending.
 * @param {object} state - Full app state with snapshot, sideSheetOpen, etc.
 * @returns {string} HTML string
 */
export function renderSideSheet(state) {
  const pending = state.snapshot?.pending;
  if (!pending) return '';

  const isOpen = state.sideSheetOpen;

  // Field selection variant has its own layout
  if (pending.kind === 'fieldSelection') {
    return renderFieldSelection(pending);
  }

  return `
    <div class="side-sheet ${isOpen ? 'open' : ''}" role="complementary" aria-label="Generation plan">
      <div class="side-sheet-header">
        <h2>Generation Plan</h2>
        <button class="side-sheet-close" data-action="close-side-sheet" aria-label="Close side sheet">&times;</button>
      </div>
      <div class="side-sheet-body">
        ${pending.entities?.length ? renderEntityPlanCards(pending) : ''}
        ${pending.formattedPlan ? `<pre class="plan-text">${escapeHtml(pending.formattedPlan)}</pre>` : ''}
      </div>
      <div class="side-sheet-footer">
        <button class="action-btn" data-action="approve-pending">Approve &amp; Generate</button>
        <button class="action-btn action-btn-soft" data-action="reject-pending">Reject</button>
      </div>
    </div>
  `;
}

/**
 * Render entity plan cards showing each planned entity.
 * @param {object} pending - Pending plan with entities array
 * @returns {string} HTML string
 */
function renderEntityPlanCards(pending) {
  return `
    <div class="plan-summary">Creating ${pending.entities.length} entities:</div>
    <div class="plan-cards">
      ${pending.entities.map((entity, i) => `
        <div class="plan-card">
          <div class="plan-card-header">
            <span class="plan-card-num">${i + 1}.</span>
            <strong>${escapeHtml(entity.name)}</strong>
            <span class="badge">${escapeHtml(entity.type)}${entity.kind ? ` / ${escapeHtml(entity.kind)}` : ''}</span>
          </div>
          ${entity.reason ? `<div class="plan-card-reason">${escapeHtml(entity.reason)}</div>` : ''}
          ${entity.connectsTo?.length ? `<div class="plan-card-connects">Connects to: ${entity.connectsTo.map(c => escapeHtml(typeof c === 'string' ? c : `${c.name} (${c.rel})${c.isNew ? ' [new]' : ''}`)).join(', ')}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render the field-selection variant of the side sheet.
 * Shows a checkbox grid for choosing which fields to regenerate.
 * @param {object} pending - Pending field selection with coreFields/payloadFields
 * @returns {string} HTML string
 */
function renderFieldSelection(pending) {
  const options = [...(pending.coreFields || []), ...(pending.payloadFields || [])];

  return `
    <div class="side-sheet open" role="complementary" aria-label="Regenerate fields">
      <div class="side-sheet-header">
        <h2>Regenerate Fields</h2>
        <button class="side-sheet-close" data-action="close-side-sheet" aria-label="Close side sheet">&times;</button>
      </div>
      <div class="side-sheet-body">
        <p class="muted">${escapeHtml(pending.entityName || '')} (${escapeHtml(pending.entityType || '')})</p>
        <form id="field-plan-form" class="form-grid">
          <div class="field-selection-grid">
            ${options.map(field => `
              <label class="field-toggle">
                <input type="checkbox" name="selectedField" value="${escapeHtml(field)}" />
                <span class="field-toggle-label">${escapeHtml(field)}</span>
              </label>
            `).join('')}
          </div>
          <label>
            <span class="form-label">Hint</span>
            <textarea name="hint" placeholder="Optional guidance for regeneration"></textarea>
          </label>
        </form>
      </div>
      <div class="side-sheet-footer">
        <button class="action-btn" data-action="submit-field-plan">Plan Regeneration</button>
        <button class="action-btn action-btn-soft" data-action="reject-pending">Cancel</button>
      </div>
    </div>
  `;
}
