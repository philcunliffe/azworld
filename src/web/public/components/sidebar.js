/**
 * sidebar.js - Collapsible sidebar with unified tree navigator.
 *
 * Sections:
 *   1. World hierarchy (expanded by default)
 *   2. Factions (collapsed by default, uses <details>)
 *   3. Religions (collapsed by default)
 *   4. Cultures (collapsed by default)
 *   5. Canon by Type (collapsed by default, shows type counts)
 */

import { escapeHtml, truncate } from '../lib/util.js';

/** Entity-type to dot-color mapping, matching TUI palette. */
const TYPE_COLORS = {
  state:      '#5b8dd9',
  burg:       '#5bbcd9',
  location:   '#5bd97b',
  npc:        '#d9c45b',
  faction:    '#b95bd9',
  event:      '#d95b5b',
  rumor:      '#d9935b',
  hook:       '#d9935b',
  culture:    '#d9935b',
  religion:   '#5bbcd9',
  deity:      '#d9c45b',
  era:        '#8b7355',
  phenomena:  '#9b59b6',
};

/**
 * Render the sidebar navigation panel.
 * @param {object} state - Full app state with snapshot, sidebarCollapsed, etc.
 * @returns {string} HTML string
 */
export function renderSidebar(state) {
  const snapshot = state.snapshot;
  if (!snapshot) return '';

  const explorer = snapshot.browse?.explorer;
  const currentNodeId = snapshot.browse?.detail?.nodeId;

  // Build tree HTML for each section
  const worldNodes = (explorer?.world || [])
    .map(node => renderTreeNode(node, currentNodeId)).join('');
  const factionNodes = (explorer?.factions || [])
    .map(node => renderTreeNode(node, currentNodeId)).join('');
  const religionNodes = (explorer?.religions || [])
    .map(node => renderTreeNode(node, currentNodeId)).join('');
  const cultureNodes = (explorer?.cultures || [])
    .map(node => renderTreeNode(node, currentNodeId)).join('');

  // Canon type summary list
  const canonTypes = explorer?.canonTypes || [];
  const canonTypeItems = canonTypes
    .filter(t => t.count > 0)
    .map(t => {
      const color = TYPE_COLORS[t.type] || '#999';
      return `
        <button class="canon-type-item" data-action="navigate" data-ref="canon:${escapeHtml(t.type)}">
          <span class="type-dot" style="background:${color}"></span>
          ${escapeHtml(t.type)} <span class="muted">(${t.count})</span>
        </button>
      `;
    })
    .join('');

  const collapsed = state.sidebarCollapsed;

  return `
    <aside class="sidebar${collapsed ? ' sidebar-collapsed' : ''}" role="complementary" aria-label="Explorer sidebar">
      <div class="sidebar-header">
        <h2 class="sidebar-title">${collapsed ? '' : 'Explorer'}</h2>
        <button class="sidebar-toggle" data-action="toggle-sidebar" title="Toggle sidebar ([)" aria-label="Toggle sidebar">
          ${collapsed ? '&#x25B6;' : '&#x25C0;'}
        </button>
      </div>
      ${collapsed ? '' : renderExpandedContent(worldNodes, factionNodes, religionNodes, cultureNodes, canonTypeItems)}
    </aside>
  `;
}

/**
 * Render the full expanded sidebar content (all tree sections).
 * Extracted to keep renderSidebar readable.
 */
function renderExpandedContent(worldNodes, factionNodes, religionNodes, cultureNodes, canonTypeItems) {
  return `
    <div class="sidebar-scroll">
      <section class="sidebar-section">
        <details class="sidebar-details" open>
          <summary class="sidebar-section-title">World</summary>
          <div class="sidebar-tree">${worldNodes || '<div class="muted sidebar-empty">No world data</div>'}</div>
        </details>
      </section>
      <section class="sidebar-section">
        <details class="sidebar-details">
          <summary class="sidebar-section-title">Factions</summary>
          <div class="sidebar-tree">${factionNodes || '<div class="muted sidebar-empty">None</div>'}</div>
        </details>
      </section>
      <section class="sidebar-section">
        <details class="sidebar-details">
          <summary class="sidebar-section-title">Religions</summary>
          <div class="sidebar-tree">${religionNodes || '<div class="muted sidebar-empty">None</div>'}</div>
        </details>
      </section>
      <section class="sidebar-section">
        <details class="sidebar-details">
          <summary class="sidebar-section-title">Cultures</summary>
          <div class="sidebar-tree">${cultureNodes || '<div class="muted sidebar-empty">None</div>'}</div>
        </details>
      </section>
      <section class="sidebar-section">
        <details class="sidebar-details">
          <summary class="sidebar-section-title">Canon by Type</summary>
          <div class="canon-type-list">
            ${canonTypeItems || '<div class="muted sidebar-empty">No canon entities</div>'}
          </div>
        </details>
      </section>
    </div>
  `;
}

/**
 * Render a single tree node as a clickable button.
 *
 * @param {object} node - Tree node with id, name, depth, kind, extra
 * @param {string|undefined} selectedId - Currently selected node ID
 * @returns {string} HTML string
 */
function renderTreeNode(node, selectedId) {
  const depth = node.depth || 0;
  const indent = depth * 16;
  const isSelected = node.id === selectedId;
  const kind = node.kind || '';
  const dotColor = TYPE_COLORS[kind] || TYPE_COLORS[node.id?.split(':')[0]] || 'transparent';
  const extra = node.extra
    ? `<span class="tree-extra">${escapeHtml(node.extra)}</span>`
    : '';
  const name = truncate(node.name || '', 40);

  return `
    <button class="tree-node${isSelected ? ' is-selected' : ''}"
            data-action="navigate" data-ref="${escapeHtml(node.id)}"
            style="padding-left:${12 + indent}px"
            title="${escapeHtml(node.name || '')}"
            aria-current="${isSelected ? 'true' : 'false'}">
      <span class="type-dot" style="background:${dotColor}"></span>
      <span class="tree-name">${escapeHtml(name)}</span>
      ${extra}
    </button>
  `;
}
