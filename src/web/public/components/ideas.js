/**
 * ideas.js - Full-page Ideas pool overlay.
 *
 * Renders an overlay (modeled on the settings overlay) that lists ideas in
 * the canon DB and lets the user add, mark as used, delete, or relabel them.
 *
 * State shape:
 *   state.ideasOpen          - boolean, controls visibility
 *   state.ideasStatusFilter  - "pending" | "used" | "all"
 *   state.ideasLabelFilter   - free-text label filter (client-side)
 *   state.ideasItems         - array of idea objects from /api/ideas
 *   state.ideasLoading       - boolean
 *   state.ideasError         - last error string (or null)
 */

import { escapeHtml, truncate } from '../lib/util.js';

const STATUS_OPTIONS = ['pending', 'used', 'all'];

/**
 * Render the Ideas overlay.
 * Returns an empty string when closed.
 * @param {object} state - Full app state
 * @returns {string} HTML string
 */
export function renderIdeasOverlay(state) {
  if (!state.ideasOpen) return '';

  const statusFilter = state.ideasStatusFilter || 'pending';
  const labelFilter = (state.ideasLabelFilter || '').trim().toLowerCase();
  const items = Array.isArray(state.ideasItems) ? state.ideasItems : [];
  const filtered = labelFilter
    ? items.filter((it) => (it.labels || []).some((l) => String(l).toLowerCase().includes(labelFilter)))
    : items;

  return `
    <div class="settings-overlay" role="dialog" aria-label="Ideas pool">
      <div class="settings-container">
        <div class="settings-header">
          <h2>Ideas Pool</h2>
          <button class="settings-close" data-action="close-ideas" aria-label="Close ideas">&times;</button>
        </div>
        <div class="settings-tabs">
          ${STATUS_OPTIONS.map((s) => `
            <button class="settings-tab ${statusFilter === s ? 'is-active' : ''}" data-action="set-ideas-status" data-status="${s}">
              ${s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          `).join('')}
        </div>
        <div class="settings-body">
          ${renderAddForm()}
          ${renderFilterRow(labelFilter)}
          ${renderIdeasList(filtered, state.ideasLoading, state.ideasError)}
        </div>
      </div>
    </div>
  `;
}

function renderAddForm() {
  return `
    <form id="idea-add-form" class="form-grid" style="margin-bottom:18px">
      <label>
        <span class="form-label">Idea Text</span>
        <textarea name="text" placeholder="e.g. mistlands caused by melting ice" required></textarea>
      </label>
      <label>
        <span class="form-label">Labels (comma-separated; leave blank for auto-label)</span>
        <input name="labels" placeholder="weather, climate" />
      </label>
      <div class="form-actions">
        <button type="submit" class="action-btn">Add Idea</button>
      </div>
    </form>
  `;
}

function renderFilterRow(labelFilter) {
  return `
    <div class="form-grid" style="margin-bottom:12px">
      <label>
        <span class="form-label">Filter by label</span>
        <input id="idea-label-filter" value="${escapeHtml(labelFilter || '')}" placeholder="type to filter" />
      </label>
    </div>
  `;
}

function renderIdeasList(items, loading, error) {
  if (loading) {
    return `<div class="muted">Loading ideas…</div>`;
  }
  if (error) {
    return `<div class="muted" style="color:var(--error)">${escapeHtml(error)}</div>`;
  }
  if (!items.length) {
    return `<div class="muted">No ideas match this view.</div>`;
  }
  const rows = items.map(renderIdeaRow).join('');
  return `
    <div class="ideas-list">
      ${rows}
    </div>
  `;
}

function renderIdeaRow(idea) {
  const labels = Array.isArray(idea.labels) ? idea.labels : [];
  const labelChips = labels.length
    ? labels.map((l) => `<span class="idea-chip">${escapeHtml(String(l))}</span>`).join('')
    : `<span class="muted idea-labels-empty">${idea.labelsStatus === 'pending' ? '(labeling…)' : idea.labelsStatus === 'skipped' ? '(no labels)' : ''}</span>`;
  const statusClass = idea.status === 'used' ? 'idea-status-used' : 'idea-status-pending';
  const usedBy = idea.usedBy
    ? `<span class="muted">used by ${escapeHtml(idea.usedBy.name)} (${escapeHtml(idea.usedBy.type)})</span>`
    : '';
  return `
    <article class="idea-row" data-idea-id="${escapeHtml(idea.id)}">
      <header class="idea-row-header">
        <span class="idea-id">${escapeHtml(idea.id)}</span>
        <span class="idea-status ${statusClass}">${escapeHtml(idea.status || 'pending')}</span>
        ${usedBy}
      </header>
      <p class="idea-text">${escapeHtml(truncate(idea.text || '', 400))}</p>
      <div class="idea-labels">${labelChips}</div>
      <div class="idea-actions">
        ${idea.status !== 'used' ? `<button class="action-btn action-btn-soft" data-action="mark-idea-used" data-id="${escapeHtml(idea.id)}">Mark used</button>` : ''}
        <button class="action-btn action-btn-soft" data-action="relabel-idea" data-id="${escapeHtml(idea.id)}">Re-label</button>
        <button class="action-btn action-btn-soft" data-action="delete-idea" data-id="${escapeHtml(idea.id)}">Delete</button>
      </div>
    </article>
  `;
}
