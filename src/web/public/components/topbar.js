/**
 * topbar.js - Fixed horizontal bar at the top of the page.
 *
 * Shows breadcrumb navigation, search trigger, status chips,
 * chat toggle, and settings button.
 */

import { escapeHtml, formatNumber } from '../lib/util.js';

/**
 * Render the topbar header.
 * @param {object} state - Full app state with snapshot, etc.
 * @returns {string} HTML string
 */
export function renderTopbar(state) {
  const snapshot = state.snapshot;
  if (!snapshot) return '';

  const detail = snapshot.browse?.detail;
  const breadcrumbs = buildBreadcrumbs(detail, snapshot);
  const tokens = snapshot.tokens || {};

  return `
    <header class="topbar" role="banner">
      <nav class="breadcrumbs" aria-label="Breadcrumb navigation">
        ${breadcrumbs}
      </nav>
      <div class="topbar-center">
        <button class="search-trigger" data-action="toggle-search" title="Search (Cmd+K)">
          <span class="search-icon">&#x2315;</span>
          <span class="search-placeholder">Search entities...</span>
          <kbd>&#x2318;K</kbd>
        </button>
      </div>
      <div class="topbar-right">
        <span class="status-chip" title="Tokens used">${formatNumber(tokens.totalTokens || 0)} tokens</span>
        <button class="topbar-icon-btn ${state.mapViewActive ? 'is-active' : ''}" data-action="toggle-map" title="World Map">
          <span>&#x1F5FA;</span>
        </button>
        <button class="topbar-icon-btn" data-action="toggle-chat" title="Chat (Cmd+D)">
          <span>&#x1F4AC;</span>
        </button>
        <button class="topbar-icon-btn" data-action="open-settings" title="Settings">
          <span>&#x2699;</span>
        </button>
      </div>
    </header>
  `;
}

/**
 * Build clickable breadcrumbs from the detail object and snapshot.
 *
 * Uses the entity's anchors to reconstruct the hierarchy chain
 * (world > state > burg > location > entity) with clickable links.
 */
function buildBreadcrumbs(detail, snapshot) {
  if (!detail) return crumbLink('World', 'world', true);

  const raw = detail.raw || {};
  const anchors = raw.anchors || {};
  const kind = detail.kind;
  const crumbs = [];

  // World root is always first
  crumbs.push(crumbLink('World', 'world'));

  // State
  const stateId = anchors.stateId ?? raw.state ?? raw.stateId;
  if (stateId != null && kind !== 'state' && kind !== 'world') {
    const stateName = findStateName(snapshot, stateId) || `State ${stateId}`;
    crumbs.push(crumbLink(stateName, `state:${stateId}`));
  }

  // Burg
  const burgId = anchors.burgId ?? raw.burgId;
  if (burgId != null && kind !== 'burg' && kind !== 'state' && kind !== 'world') {
    const burgName = findBurgName(snapshot, burgId) || `Burg ${burgId}`;
    crumbs.push(crumbLink(burgName, `burg:${burgId}`));
  }

  // Location (for NPCs anchored to a location)
  if (anchors.locationId && kind !== 'location') {
    const locName = findCanonName(snapshot, anchors.locationId) || 'Location';
    crumbs.push(crumbLink(locName, `location:${anchors.locationId}`));
  }

  // Current entity (non-clickable)
  if (kind === 'world') {
    // Already shown as the root link — make it current
    crumbs.length = 0;
    crumbs.push(crumbCurrent('World'));
  } else if (kind === 'state') {
    crumbs.push(crumbCurrent(detail.title || 'State'));
  } else {
    crumbs.push(crumbCurrent(detail.title || 'Entity'));
  }

  return crumbs.join('<span class="crumb-sep">/</span>');
}

function crumbLink(label, ref) {
  return `<a class="crumb" data-action="navigate" data-ref="${escapeHtml(ref)}" tabindex="0">${escapeHtml(label)}</a>`;
}

function crumbCurrent(label) {
  return `<span class="crumb crumb-current" aria-current="page">${escapeHtml(label)}</span>`;
}

/** Find a state name from the world tree in the snapshot. */
function findStateName(snapshot, stateId) {
  const nodes = snapshot.browse?.explorer?.world || [];
  for (const node of nodes) {
    if (node.id === `state:${stateId}`) return node.name;
  }
  return null;
}

/** Find a burg name from the world tree in the snapshot. */
function findBurgName(snapshot, burgId) {
  const nodes = snapshot.browse?.explorer?.world || [];
  for (const state of nodes) {
    if (!state.children) continue;
    for (const child of state.children) {
      if (child.id === `burg:${burgId}`) return child.name;
    }
  }
  return null;
}

/** Find a canon entity name by ID. */
function findCanonName(snapshot, entityId) {
  // Search through explorer trees for matching node
  const trees = ['factions', 'religions'];
  for (const key of trees) {
    const nodes = snapshot.browse?.explorer?.[key] || [];
    for (const node of nodes) {
      if (node.id?.endsWith(entityId)) return node.name;
    }
  }
  return null;
}
