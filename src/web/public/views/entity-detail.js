/**
 * entity-detail.js - Type-specific entity detail renderers for the azworld web app.
 *
 * Dispatches to specialised view functions based on detail.kind (world, state,
 * burg, location, npc, faction, event, rumor, hook, deity, etc.).
 *
 * Each renderer returns an HTML string that the main app inserts into the
 * detail panel area. All data arrives from snapshot.browse.detail which
 * contains: kind, title, path, nodeId, raw, sections.
 */

import {
  escapeHtml,
  renderMarkdown,
  truncate,
  formatNumber,
  pretty,
} from '../lib/util.js';
import { renderMapPlaceholder } from '../components/region-map.js';

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

/**
 * Render a coloured badge pill.
 * @param {string} label
 * @param {"default"|"ok"|"warn"|"error"|"accent"} variant
 * @returns {string}
 */
function badge(label, variant = 'default') {
  return `<span class="badge badge-${variant}">${escapeHtml(label)}</span>`;
}

/**
 * Render a clickable entity card button.
 * @param {object} entity
 * @param {string} [typeOverride]
 * @returns {string}
 */
function entityCard(entity, typeOverride) {
  const type = typeOverride || entity.type || entity.kind || '';
  const ref = entity.id && type ? `${type}:${entity.id}` : (entity.id || '');
  const name = entity.name || entity.id || 'Unknown';
  const sub = entity.summary || entity.formName || entity.kind || entity.type || '';
  return `
    <button class="entity-card" data-action="navigate" data-ref="${escapeHtml(ref)}">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(truncate(sub, 60))}</small>
    </button>
  `;
}

/**
 * Render a titled section of entity cards with an optional generation button.
 * @param {string} title
 * @param {Array} items
 * @param {string} [typeOverride]
 * @param {{label: string, command: string}} [genAction]
 * @returns {string}
 */
function entityCardList(title, items, typeOverride, genAction) {
  return `
    <div class="entity-list-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="entity-card-list">
        ${items.length ? items.map(e => entityCard(e, typeOverride)).join('') : '<div class="muted">None yet</div>'}
      </div>
      ${genAction ? `<button class="gen-inline-btn" data-action="open-gen-form" data-type="${escapeHtml(genAction.command)}">${escapeHtml(genAction.label)}</button>` : ''}
    </div>
  `;
}

/**
 * Render a single labelled payload field. Returns empty string if value is
 * falsy or an empty array.
 * @param {string} label
 * @param {*} value
 * @returns {string}
 */
function payloadField(label, value) {
  if (!value || (Array.isArray(value) && !value.length)) return '';
  const display = Array.isArray(value) ? value.join(', ') : String(value);
  return `
    <div class="payload-field">
      <div class="payload-label">${escapeHtml(label)}</div>
      <div class="payload-value">${escapeHtml(display)}</div>
    </div>
  `;
}

/**
 * Render a prose-style payload block with markdown rendering.
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
function payloadProse(label, value) {
  if (!value) return '';
  return `
    <div class="payload-prose">
      <h4>${escapeHtml(label)}</h4>
      <div class="prose-body">${renderMarkdown(value)}</div>
    </div>
  `;
}

/**
 * Render the relations list for an entity.
 * @param {Array} relations
 * @returns {string}
 */
function relationsList(relations) {
  if (!relations?.length) return '';
  return `
    <div class="relations-section">
      <h3>Relations</h3>
      <div class="relations-list">
        ${relations.map(r => `
          <div class="relation-row">
            <span class="relation-type">${escapeHtml(r.rel_type)}</span>
            <span class="relation-arrow">&#x2192;</span>
            <span>${escapeHtml(r.fromName || r.from_id)} &#x2194; ${escapeHtml(r.toName || r.to_id)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Render a horizontal row of action buttons.
 * @param  {...string} buttons - Pre-rendered button HTML strings
 * @returns {string}
 */
function actionRow(...buttons) {
  return `<div class="action-row">${buttons.join('')}</div>`;
}

/**
 * Render a primary action button.
 * @param {string} label
 * @param {string} action - data-action value
 * @param {string} [extra] - Additional HTML attributes
 * @param {string} [cls] - CSS class override
 * @returns {string}
 */
function actionBtn(label, action, extra = '', cls = '') {
  return `<button class="${cls || 'action-btn'}" data-action="${action}" ${extra}>${escapeHtml(label)}</button>`;
}

/** Soft-styled (secondary) action button. */
function actionBtnSoft(label, action, extra = '') {
  return actionBtn(label, action, extra, 'action-btn action-btn-soft');
}

/** Danger-styled (destructive) action button. */
function actionBtnDanger(label, action, extra = '') {
  return actionBtn(label, action, extra, 'action-btn action-btn-danger');
}

/**
 * Render a row of tag chips.
 * @param {string[]} tags
 * @returns {string}
 */
function tagsChips(tags) {
  if (!tags?.length) return '';
  return `<div class="tags-row">${tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>`;
}

/**
 * Render a summary banner block.
 * @param {string} text
 * @returns {string}
 */
function summaryBanner(text) {
  if (!text) return '';
  return `<div class="summary-banner">${escapeHtml(text)}</div>`;
}

/**
 * Render a stat chip (number + label).
 * @param {string} label
 * @param {number|string} value
 * @returns {string}
 */
function statChip(label, value) {
  return `<span class="chip"><strong>${escapeHtml(String(value))}</strong> ${escapeHtml(label)}</span>`;
}

/**
 * Render a clickable pathline from the entity's detail and raw data.
 * Looks up state/burg names from the explorer tree in the snapshot.
 */
function pathline(detail, appState) {
  const raw = detail.raw || {};
  const anchors = raw.anchors || {};
  const explorer = appState?.snapshot?.browse?.explorer;
  const treeNodes = explorer?.world || [];
  const parts = [];

  parts.push(`<a class="crumb" data-action="navigate" data-ref="world">World</a>`);

  const stateId = anchors.stateId ?? raw.state ?? raw.stateId;
  if (stateId != null && detail.kind !== 'world') {
    const name = lookupNodeName(treeNodes, `state:${stateId}`) || `State ${stateId}`;
    parts.push(`<a class="crumb" data-action="navigate" data-ref="state:${escapeHtml(String(stateId))}">${escapeHtml(name)}</a>`);
  }

  const burgId = anchors.burgId ?? raw.burgId;
  if (burgId != null && detail.kind !== 'burg' && detail.kind !== 'state' && detail.kind !== 'world') {
    const name = lookupNodeName(treeNodes, `burg:${burgId}`) || `Burg ${burgId}`;
    parts.push(`<a class="crumb" data-action="navigate" data-ref="burg:${escapeHtml(String(burgId))}">${escapeHtml(name)}</a>`);
  }

  if (anchors.locationId && detail.kind !== 'location') {
    const name = lookupNodeName(treeNodes, `location:${anchors.locationId}`) || 'Location';
    parts.push(`<a class="crumb" data-action="navigate" data-ref="location:${escapeHtml(String(anchors.locationId))}">${escapeHtml(name)}</a>`);
  }

  return `<div class="pathline">${parts.join(' <span class="crumb-sep">/</span> ')}</div>`;
}

/** Recursively search tree nodes for a matching ID and return its name. */
function lookupNodeName(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node.name;
    if (node.children) {
      const found = lookupNodeName(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Type-specific renderers
// ---------------------------------------------------------------------------

/**
 * World overview - the landing/root page.
 */
function renderWorldOverview(detail, state) {
  const snapshot = state.snapshot || {};
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const settings = snapshot.campaignSettings;

  const statesCount = sections.states?.length || 0;
  const burgsCount = sections.burgs?.length || 0;
  const canonCount = sections.canon?.length || 0;
  const relationsCount = sections.relations?.length || 0;

  // Campaign settings banner
  let campaignBanner = '';
  if (settings?.worldVibe) {
    campaignBanner = `
      <div class="detail-box campaign-banner">
        <h3>Campaign Settings</h3>
        ${payloadField('Vibe', settings.worldVibe)}
        ${payloadField('Rating', settings.rating)}
        ${payloadField('Arc', settings.arc)}
        <div class="action-row" style="margin-top:10px">
          ${actionBtnSoft('Edit Settings', 'open-settings')}
        </div>
      </div>
    `;
  } else {
    campaignBanner = `
      <div class="detail-box campaign-banner">
        <h3>Campaign Settings</h3>
        <p class="muted">No campaign settings configured yet.</p>
        <div class="action-row" style="margin-top:10px">
          ${actionBtn('Set Up Campaign', 'open-settings')}
        </div>
      </div>
    `;
  }

  // Quick actions grid
  const quickActions = `
    <div class="detail-box">
      <h3>Quick Actions</h3>
      <div class="detail-grid">
        <button class="tool-card" data-action="run-command" data-command="init">
          <h3>Init World</h3>
          <p class="muted">Generate initial world content from map data</p>
        </button>
        <button class="tool-card" data-action="open-gen-form" data-type="advance">
          <h3>Advance Time</h3>
          <p class="muted">Progress the world timeline forward</p>
        </button>
        <button class="tool-card" data-action="open-settings" data-tab="importexport">
          <h3>Import Source</h3>
          <p class="muted">Import Azgaar map data or canon backup</p>
        </button>
      </div>
    </div>
  `;

  // Recent activity
  const timeline = snapshot.timeline || [];
  const recentItems = timeline.slice(0, 5);
  const recentActivity = recentItems.length ? `
    <div class="detail-box">
      <h3>Recent Activity</h3>
      <div class="activity-list">
        ${recentItems.map(item => `
          <div class="activity-item">
            <strong>${escapeHtml(item.title || item.type || 'Activity')}</strong>
            <small class="muted">${escapeHtml(item.timestamp || item.time || '')}</small>
            ${item.summary ? `<p>${escapeHtml(truncate(item.summary, 100))}</p>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  // States grid
  const statesGrid = sections.states?.length ? `
    <div class="entity-list-section">
      <h3>States</h3>
      <div class="entity-card-list">
        ${sections.states.map(s => `
          <button class="entity-card" data-action="navigate" data-ref="state:${escapeHtml(String(s.id))}">
            <strong>${escapeHtml(s.name || s.fullName || 'State')}</strong>
            <small>${escapeHtml(s.formName || s.form || s.extra || '')}</small>
          </button>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <h2 style="font-family:var(--serif);font-size:clamp(2rem,4vw,3.2rem)">${escapeHtml(detail.title || 'World')}</h2>
      </div>
      <div class="hero-meta">
        ${statChip('states', statesCount)}
        ${statChip('burgs', burgsCount)}
        ${statChip('canon entities', canonCount)}
        ${statChip('relations', relationsCount)}
      </div>
      ${campaignBanner}
      ${quickActions}
      ${recentActivity}
      ${statesGrid}
    </section>
  `;
}

/**
 * State detail view.
 */
function renderStateDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const summaryText = raw.summary || raw.details_md || raw.fullName || '';

  const burgsCount = sections.burgs?.length || 0;
  const factionsCount = sections.factions?.length || 0;
  const npcsCount = sections.npcs?.length || 0;
  const eventsCount = sections.events?.length || 0;

  // Check whether a meta description entity exists
  const hasDescription = !!(raw.summary || raw.details_md || sections.canon?.some(c => c.type === 'meta'));
  const genDescBtn = hasDescription
    ? ''
    : actionBtnSoft('Generate Description', 'run-command', 'data-command="gen description"');

  const burgsGrid = sections.burgs?.length ? `
    <div class="entity-list-section">
      <h3>Burgs</h3>
      <div class="entity-card-list">
        ${sections.burgs.map(b => `
          <button class="entity-card" data-action="navigate" data-ref="burg:${escapeHtml(String(b.id))}">
            <strong>${escapeHtml(b.name || 'Burg')}</strong>
            <small>${b.population ? 'Pop. ' + escapeHtml(formatNumber(b.population)) : ''}${b.extra ? ' ' + escapeHtml(b.extra) : ''}</small>
          </button>
        `).join('')}
      </div>
    </div>
  ` : '';

  const factionsSection = sections.factions?.length
    ? entityCardList('Factions', sections.factions, 'faction')
    : '';

  const eventsSection = sections.events?.length
    ? entityCardList('Events', sections.events, 'event')
    : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <h2 style="font-family:var(--serif)">${escapeHtml(detail.title || 'State')}</h2>
      </div>
      ${summaryBanner(summaryText)}
      <div class="hero-meta">
        ${statChip('burgs', burgsCount)}
        ${statChip('factions', factionsCount)}
        ${statChip('NPCs', npcsCount)}
        ${statChip('events', eventsCount)}
      </div>
      ${genDescBtn ? `<div class="action-row">${genDescBtn}</div>` : ''}
      ${burgsGrid}
      ${factionsSection}
      ${eventsSection}
    </section>
  `;
}

/**
 * Build Watabou city/village generator URL from burg data.
 * Matches Azgaar FMG's exact URL construction logic.
 */
function buildCityMapUrl(burg, mapMeta) {
  const mapSeed = mapMeta?.seed || '0';
  const populationRate = mapMeta?.populationRate ?? 1000;
  const urbanization = mapMeta?.urbanization ?? 1;
  const urbanDensity = mapMeta?.urbanDensity ?? 10;
  const burgPop = burg.population ?? burg.pop ?? 0;
  const population = Math.round(burgPop * populationRate * urbanization);
  const burgId = burg.i ?? 0;
  const burgSeed = burg.MFCG || (mapSeed + String(burgId).padStart(4, '0'));

  const isVillage = burg.group === 'village' || burg.group === 'hamlet';
  const hasRiver = (mapMeta?.cellRiver ?? 0) > 0;
  const biome = mapMeta?.cellBiome ?? 0;
  const isCoastal = burg.port > 0;

  if (isVillage) {
    // Village generator
    let width;
    if (population > 1500) width = 1600;
    else if (population > 1000) width = 1400;
    else if (population > 500) width = 1000;
    else if (population > 200) width = 800;
    else if (population > 100) width = 600;
    else width = 400;
    const height = Math.round(width / 2.05);

    // Style based on biome
    let style = 'default';
    if (biome === 1 || biome === 2) style = 'sand';       // Desert
    else if (biome >= 9 && biome <= 11) style = 'snow';    // Cold/tundra/glacier

    // Build tags
    const tags = [];
    if (isCoastal) tags.push('coast');
    if (hasRiver) tags.push('river');
    if (!burg.plaza) tags.push('no square');
    if (burg.walls) tags.push('palisade');
    if (population < 100) tags.push('sparse');
    else if (population > 300) tags.push('dense');

    const params = new URLSearchParams({
      pop: String(population),
      name: burg.name || '',
      seed: String(burgSeed),
      width: String(width),
      height: String(height),
      style,
    });
    if (tags.length) params.set('tags', tags.join(','));

    return `https://watabou.github.io/village-generator/?${params.toString()}`;
  }

  // City generator
  const sizeRaw = 2.13 * Math.pow((burgPop * populationRate) / urbanDensity, 0.385);
  const size = Math.max(6, Math.min(100, Math.ceil(sizeRaw)));

  // Arable biomes for farms (grassland, forests, savanna, wetland)
  const arableBiomes = [3, 4, 5, 6, 7, 8, 12];
  const hasFarms = arableBiomes.includes(biome) ? 1 : 0;

  const params = new URLSearchParams({
    name: burg.name || '',
    population: String(population),
    size: String(size),
    seed: String(burgSeed),
    river: hasRiver ? '1' : '0',
    coast: isCoastal ? '1' : '0',
    farms: String(hasFarms),
    citadel: burg.citadel ? '1' : '0',
    urban_castle: (burg.citadel && burgId % 2 === 0) ? '1' : '0',
    hub: '0',
    plaza: burg.plaza ? '1' : '0',
    temple: burg.temple ? '1' : '0',
    walls: burg.walls ? '1' : '0',
    shantytown: burg.shanty ? '1' : '0',
    gates: '-1',
  });

  return `https://watabou.github.io/city-generator/?${params.toString()}`;
}

/**
 * Render the burg maps section with Region / City tabs.
 */
function renderBurgMaps(raw, detail) {
  const burgId = raw.i ?? detail.ref?.burgId;
  if (!burgId) return '';

  const mapMeta = detail.mapMeta || {};
  const isVillage = raw.group === 'village' || raw.group === 'hamlet';
  const noPreview = ['fort', 'monastery', 'caravanserai', 'trading_post'].includes(raw.group);
  const cityUrl = noPreview ? null : buildCityMapUrl(raw, mapMeta);
  const cityLabel = isVillage ? 'Village' : 'City';

  return `
    <div class="burg-maps-section" id="burg-maps">
      <div class="pillbar burg-map-tabs">
        ${cityUrl ? `<button class="is-active" data-action="set-map-tab" data-tab="city">${cityLabel}</button>` : ''}
        <button ${cityUrl ? '' : 'class="is-active"'} data-action="set-map-tab" data-tab="region">Region</button>
      </div>
      ${cityUrl ? `
        <div class="burg-map-panel" id="burg-map-city">
          <div class="city-map-container">
            <iframe src="${escapeHtml(cityUrl)}" class="city-map-iframe" title="${cityLabel} map of ${escapeHtml(raw.name || 'burg')}" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>
          </div>
        </div>
      ` : ''}
      <div class="burg-map-panel" id="burg-map-region" ${cityUrl ? 'style="display:none"' : ''}>
        ${renderMapPlaceholder(burgId)}
      </div>
    </div>
  `;
}

/**
 * Burg detail view - the richest, most-used view for world-building.
 */
function renderBurgDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const summaryText = raw.summary || raw.details_md || '';
  const burgTab = state.burgTab || 'factions';

  // State link
  const stateRef = raw.state != null ? `state:${raw.state}` : '';
  const treeNodes = state.snapshot?.browse?.explorer?.world || [];
  const stateName = (raw.state != null ? lookupNodeName(treeNodes, `state:${raw.state}`) : null) || raw.stateName || (raw.state != null ? `State ${raw.state}` : '');
  const stateLink = stateRef
    ? `<span class="muted">State:</span> <a class="crumb" data-action="navigate" data-ref="${escapeHtml(stateRef)}" tabindex="0">${escapeHtml(stateName)}</a>`
    : '';

  const populationInfo = raw.population
    ? `<span class="chip"><strong>${escapeHtml(formatNumber(raw.population))}</strong> population</span>`
    : '';

  // Two-column main content: locations and NPCs
  const locationsCol = `
    <div class="entity-list-section">
      <h3>Locations</h3>
      <div class="entity-card-list">
        ${sections.locations?.length ? sections.locations.map(loc => `
          <button class="entity-card" data-action="navigate" data-ref="location:${escapeHtml(String(loc.id))}">
            <div class="entity-card-header">
              <strong>${escapeHtml(loc.name || 'Location')}</strong>
              <span class="entity-card-kind">${escapeHtml(loc.kind || loc.type || 'location')}</span>
            </div>
            <small>${escapeHtml(truncate(loc.summary || '', 60))}</small>
          </button>
        `).join('') : '<div class="muted">No locations yet</div>'}
      </div>
      <button class="gen-inline-btn" data-action="open-gen-form" data-type="gen location">+ Generate Location</button>
    </div>
  `;

  const npcsCol = `
    <div class="entity-list-section">
      <h3>NPCs</h3>
      <div class="entity-card-list">
        ${sections.npcs?.length ? sections.npcs.map(npc => `
          <button class="entity-card" data-action="navigate" data-ref="npc:${escapeHtml(String(npc.id))}">
            <div class="entity-card-header">
              <strong>${escapeHtml(npc.name || 'NPC')}</strong>
              <span class="entity-card-kind">${escapeHtml(truncate(npc.payload?.role || npc.role || npc.kind || 'npc', 30))}</span>
            </div>
            <small>${escapeHtml(truncate(npc.summary || '', 60))}</small>
          </button>
        `).join('') : '<div class="muted">No NPCs yet</div>'}
      </div>
      <button class="gen-inline-btn" data-action="open-gen-form" data-type="gen npc">+ Generate NPC</button>
    </div>
  `;

  // Tabbed sub-sections
  const tabs = ['factions', 'events', 'rumors', 'hooks'];
  const tabPills = tabs.map(t =>
    `<button class="${burgTab === t ? 'is-active' : ''}" data-action="set-burg-tab" data-tab="${t}">${escapeHtml(t.charAt(0).toUpperCase() + t.slice(1))}</button>`
  ).join('');

  let tabContent = '';
  const tabItems = sections[burgTab] || [];
  const tabType = burgTab === 'factions' ? 'faction'
    : burgTab === 'events' ? 'event'
    : burgTab === 'rumors' ? 'rumor'
    : 'hook';

  tabContent = `
    <div class="entity-card-list">
      ${tabItems.length ? tabItems.map(e => entityCard(e, tabType)).join('') : `<div class="muted">No ${burgTab} yet</div>`}
    </div>
    <button class="gen-inline-btn" data-action="open-gen-form" data-type="gen ${tabType}">+ Generate ${escapeHtml(tabType.charAt(0).toUpperCase() + tabType.slice(1))}</button>
  `;

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Burg')}</h2>
          ${actionBtn('Generate Package', 'run-command', 'data-command="gen"')}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${stateLink}
        ${populationInfo}
      </div>
      ${summaryBanner(summaryText)}
      ${renderBurgMaps(raw, detail)}
      <div class="detail-grid">
        ${locationsCol}
        ${npcsCol}
      </div>
      <div class="detail-box">
        <div class="pillbar">${tabPills}</div>
        <div style="padding:12px">
          ${tabContent}
        </div>
      </div>
      ${actionRow(
        actionBtnSoft('Advance Time', 'open-gen-form', 'data-type="advance"'),
        actionBtnSoft('Generate Description', 'run-command', 'data-command="gen description"'),
        actionBtnSoft('Generate Rumor', 'open-gen-form', 'data-type="gen rumor"'),
        actionBtnSoft('Generate Hook', 'open-gen-form', 'data-type="gen hook"'),
      )}
    </section>
  `;
}

/**
 * Location detail view.
 */
function renderLocationDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  // Anchor path (burg / state)
  const anchorParts = [];
  if (raw.anchors?.burgId != null) {
    anchorParts.push(`<a class="crumb" data-action="navigate" data-ref="burg:${escapeHtml(String(raw.anchors.burgId))}" role="link" tabindex="0">Burg ${escapeHtml(String(raw.anchors.burgId))}</a>`);
  }
  if (raw.anchors?.stateId != null) {
    anchorParts.push(`<a class="crumb" data-action="navigate" data-ref="state:${escapeHtml(String(raw.anchors.stateId))}" role="link" tabindex="0">State ${escapeHtml(String(raw.anchors.stateId))}</a>`);
  }
  const anchorPath = anchorParts.length ? `<div class="muted" style="font-size:0.9rem">${anchorParts.join(' / ')}</div>` : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Location')}</h2>
          ${actionBtnSoft('Modify', 'run-command', 'data-command="mod"')}
          ${actionBtnSoft('Regen Fields', 'run-command', `data-command="gen ${escapeHtml(raw.type || 'location')} ${escapeHtml(raw.name || '')}"`.trim())}
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${raw.kind ? badge(raw.kind, 'accent') : badge('location', 'accent')}
        ${tagsChips(raw.tags)}
        ${anchorPath}
      </div>
      ${summaryBanner(raw.summary || '')}
      ${raw.details_md ? `<div class="payload-prose"><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
      ${payloadProse('Atmosphere', payload.atmosphere)}
      ${payloadProse('Physical Description', payload.physicalDescription)}
      ${payloadField('Features', payload.features)}
      ${payloadField('Brief Description', payload.briefDescription)}
      ${sections.npcs?.length ? entityCardList('People Here', sections.npcs, 'npc', { label: '+ Generate NPC Here', command: 'gen npc' }) : ''}
      ${sections.factions?.length ? entityCardList('Factions', sections.factions, 'faction') : ''}
      ${relationsList(sections.relations)}
      ${actionRow(
        actionBtnSoft('Modify', 'run-command', 'data-command="mod"'),
        actionBtnSoft('Regenerate Fields', 'run-command', `data-command="gen ${escapeHtml(raw.type || 'location')} ${escapeHtml(raw.name || '')}"`.trim()),
        actionBtnSoft('Generate NPC Here', 'open-gen-form', 'data-type="gen npc"'),
        actionBtnSoft('Talk to NPC', 'open-chat-npc', ''),
      )}
    </section>
  `;
}

/**
 * NPC detail view.
 */
function renderNpcDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  // Anchor path (location / burg)
  const anchorParts = [];
  if (raw.anchors?.locationId != null) {
    anchorParts.push(`<a class="crumb" data-action="navigate" data-ref="location:${escapeHtml(String(raw.anchors.locationId))}" role="link" tabindex="0">Location</a>`);
  }
  if (raw.anchors?.burgId != null) {
    anchorParts.push(`<a class="crumb" data-action="navigate" data-ref="burg:${escapeHtml(String(raw.anchors.burgId))}" role="link" tabindex="0">Burg ${escapeHtml(String(raw.anchors.burgId))}</a>`);
  }
  const anchorPath = anchorParts.length ? `<div class="muted" style="font-size:0.9rem">${anchorParts.join(' / ')}</div>` : '';

  // Role tag
  const roleTag = payload.role || raw.kind || 'npc';

  // Hooks from payload
  const hooksSection = payload.hooks?.length ? `
    <div class="detail-box">
      <h3>Hooks</h3>
      <ul>${payload.hooks.map(h => `<li>${escapeHtml(typeof h === 'string' ? h : h.description || h.name || pretty(h))}</li>`).join('')}</ul>
    </div>
  ` : '';

  // Secrets (spoiler toggle)
  const secretsSection = payload.secrets ? `
    <div class="detail-box">
      <h3>Secrets</h3>
      <div class="spoiler" onclick="this.classList.toggle('revealed')">
        <div class="spoiler-label">Click to reveal</div>
        <div class="spoiler-content">${escapeHtml(Array.isArray(payload.secrets) ? payload.secrets.join('; ') : String(payload.secrets))}</div>
      </div>
    </div>
  ` : '';

  // Knows section
  let knowsSection = '';
  if (payload.knows) {
    const knowsParts = [];
    if (payload.knows.public) knowsParts.push(payloadField('Public', payload.knows.public));
    if (payload.knows.secret) knowsParts.push(payloadField('Secret', payload.knows.secret));
    if (payload.knows.intimate) knowsParts.push(payloadField('Intimate', payload.knows.intimate));
    if (knowsParts.length) {
      knowsSection = `<div class="detail-box"><h3>Knows</h3>${knowsParts.join('')}</div>`;
    }
  }

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'NPC')}</h2>
          ${actionBtn('Talk', 'open-chat-npc', `data-name="${escapeHtml(raw.name || '')}"`)  }
          ${actionBtnSoft('Modify', 'run-command', 'data-command="mod"')}
          ${actionBtnSoft('Regen Fields', 'run-command', `data-command="gen ${escapeHtml(raw.type || 'npc')} ${escapeHtml(raw.name || '')}"`.trim())}
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${badge(roleTag, 'accent')}
        ${tagsChips(raw.tags)}
        ${anchorPath}
      </div>
      ${raw.summary ? `<blockquote class="summary-banner" style="font-style:italic;border-left:4px solid var(--accent);margin:0">${escapeHtml(raw.summary)}</blockquote>` : ''}
      <div class="detail-grid">
        <div class="detail-box">
          ${payloadProse('Personality', payload.personality)}
          ${payloadProse('Appearance', payload.appearance)}
        </div>
        <div class="detail-box">
          ${payloadProse('Background', payload.background)}
          ${payloadProse('Motivations', payload.motivations)}
        </div>
      </div>
      ${hooksSection}
      ${secretsSection}
      ${knowsSection}
      ${raw.details_md ? `<div class="payload-prose"><h4>Description</h4><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
      ${relationsList(sections.relations)}
      ${actionRow(
        actionBtn('Talk', 'open-chat-npc', `data-name="${escapeHtml(raw.name || '')}"`),
        actionBtnSoft('Modify', 'run-command', 'data-command="mod"'),
        actionBtnSoft('Regenerate Fields', 'run-command', `data-command="gen ${escapeHtml(raw.type || 'npc')} ${escapeHtml(raw.name || '')}"`.trim()),
      )}
    </section>
  `;
}

/**
 * Event detail view.
 */
function renderEventDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  // Days ago display
  let daysAgoLabel = '';
  if (payload.daysAgo != null) {
    daysAgoLabel = payload.daysAgo === 0 ? 'Just happened' : `${payload.daysAgo} day${payload.daysAgo !== 1 ? 's' : ''} ago`;
  }

  // Consequences list
  const consequencesSection = payload.consequences?.length ? `
    <div class="detail-box">
      <h3>Consequences</h3>
      <ul>${payload.consequences.map(c => `<li>${escapeHtml(typeof c === 'string' ? c : c.description || pretty(c))}</li>`).join('')}</ul>
    </div>
  ` : '';

  // Awareness section
  const awarenessSection = sections.awareness?.length ? `
    <div class="detail-box">
      <h3>Awareness</h3>
      <div class="relations-list">
        ${sections.awareness.map(a => `
          <div class="relation-row">
            <span>${escapeHtml(a.name || a.entity || a.id || 'Entity')}</span>
            <span class="muted">${escapeHtml(a.level || a.type || '')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Event')}</h2>
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${payload.scope ? badge(payload.scope, 'accent') : ''}
        ${payload.severity ? badge(payload.severity, payload.severity === 'catastrophic' ? 'error' : payload.severity === 'major' ? 'warn' : 'default') : ''}
        ${payload.ongoing ? badge('Ongoing', 'warn') : ''}
        ${payload.scale ? badge('Scale: ' + payload.scale) : ''}
        ${payload.secrecy ? badge('Secrecy: ' + payload.secrecy) : ''}
      </div>
      ${daysAgoLabel ? `<div class="muted" style="font-size:0.95rem">${escapeHtml(daysAgoLabel)}</div>` : ''}
      ${summaryBanner(raw.summary || '')}
      ${raw.details_md ? `<div class="payload-prose"><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
      ${consequencesSection}
      ${awarenessSection}
      ${relationsList(sections.relations)}
    </section>
  `;
}

/**
 * Rumor detail view.
 */
function renderRumorDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  // GM Truth section (spoiler toggle)
  const truthSection = payload.actualTruth ? `
    <div class="detail-box">
      <h3>GM Truth</h3>
      <div class="spoiler" onclick="this.classList.toggle('revealed')">
        <div class="spoiler-label">Click to reveal the truth</div>
        <div class="spoiler-content">${escapeHtml(payload.actualTruth)}</div>
      </div>
    </div>
  ` : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Rumor')}</h2>
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${payload.truthLevel ? badge('Truth: ' + payload.truthLevel, payload.truthLevel === 'true' ? 'ok' : payload.truthLevel === 'false' ? 'error' : 'warn') : ''}
        ${payload.spreadLevel ? badge('Spread: ' + payload.spreadLevel) : ''}
        ${payload.sourceType ? badge(payload.sourceType, 'accent') : ''}
      </div>
      ${raw.summary ? `
        <div class="summary-banner" style="font-style:italic;font-size:1.1rem">
          <span style="color:var(--muted);font-size:1.4rem">&ldquo;</span>${escapeHtml(raw.summary)}<span style="color:var(--muted);font-size:1.4rem">&rdquo;</span>
        </div>
      ` : ''}
      ${truthSection}
      <div class="detail-box">
        <h3>Spread Info</h3>
        ${payloadField('Source Type', payload.sourceType)}
        ${payloadField('Age (days)', payload.ageDays)}
        ${payloadField('Secrecy', payload.secrecy)}
      </div>
      ${relationsList(sections.relations)}
      ${raw.details_md ? `<div class="payload-prose"><h4>Details</h4><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
    </section>
  `;
}

/**
 * Hook detail view.
 */
function renderHookDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  const urgencyVariant = payload.urgency === 'critical' ? 'error'
    : payload.urgency === 'high' ? 'warn'
    : payload.urgency === 'medium' ? 'accent'
    : 'default';

  // Complications list
  const complications = payload.complications?.length
    ? `<div class="detail-box"><h3>Complications</h3><ul>${payload.complications.map(c => `<li>${escapeHtml(typeof c === 'string' ? c : c.description || pretty(c))}</li>`).join('')}</ul></div>`
    : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Hook')}</h2>
          ${payload.urgency ? badge(payload.urgency, urgencyVariant) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${payload.hookType ? badge(payload.hookType, 'accent') : ''}
        ${payload.difficulty ? badge('Difficulty: ' + payload.difficulty) : ''}
      </div>
      ${raw.summary ? `
        <div class="summary-banner" style="font-size:1.05rem">
          <h4 style="margin:0 0 6px">The Hook</h4>
          ${escapeHtml(raw.summary)}
        </div>
      ` : ''}
      <div class="detail-grid">
        <div class="detail-box">
          <h3>Reward</h3>
          ${payloadField('Type', payload.rewardType)}
          ${payloadField('Details', payload.rewardDetails || payload.reward)}
        </div>
        <div class="detail-box">
          <h3>Failure</h3>
          ${payloadField('Consequences', payload.failureConsequences || payload.failure)}
        </div>
      </div>
      ${complications}
      ${relationsList(sections.relations)}
      ${raw.details_md ? `<div class="payload-prose"><h4>Details</h4><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
    </section>
  `;
}

/**
 * Deity detail view.
 */
function renderDeityDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  const rankVariant = payload.rank === 'supreme' ? 'accent'
    : payload.rank === 'greater' ? 'ok'
    : payload.rank === 'lesser' ? 'default'
    : payload.rank === 'demigod' ? 'warn'
    : 'default';

  // Domains as chips
  const domainsChips = payload.domains?.length
    ? `<div class="tags-row">${payload.domains.map(d => `<span class="tag-chip">${escapeHtml(d)}</span>`).join('')}</div>`
    : '';

  // Titles (ornamental italic)
  const titlesDisplay = payload.titles?.length
    ? `<div style="font-style:italic;color:var(--muted);margin:4px 0">${payload.titles.map(t => escapeHtml(t)).join(' &middot; ')}</div>`
    : '';

  // Festivals list
  const festivalsSection = payload.festivals?.length ? `
    <div class="detail-box">
      <h3>Festivals</h3>
      <ul>${payload.festivals.map(f => `<li>${escapeHtml(typeof f === 'string' ? f : f.name || f.description || pretty(f))}</li>`).join('')}</ul>
    </div>
  ` : '';

  // Religion link from anchors
  const religionLink = raw.anchors?.azgaarReligionId != null
    ? `<div class="muted" style="font-size:0.9rem">Religion: <a class="crumb" data-action="navigate" data-ref="religion:${escapeHtml(String(raw.anchors.azgaarReligionId))}" role="link" tabindex="0">Religion ${escapeHtml(String(raw.anchors.azgaarReligionId))}</a></div>`
    : '';

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Deity')}</h2>
          ${payload.rank ? badge(payload.rank, rankVariant) : ''}
        </div>
      </div>
      ${domainsChips}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${payloadField('Alignment', payload.alignment)}
        ${titlesDisplay}
      </div>
      ${payloadField('Symbols', payload.symbols)}
      ${payloadField('Sacred Animal', payload.sacredAnimal)}
      ${payloadField('Sacred Element', payload.sacredElement)}
      ${payloadProse('Mythology', payload.mythology)}
      ${payloadProse('Appearance', payload.appearance)}
      ${payloadProse('Worship Style', payload.worshipStyle)}
      ${festivalsSection}
      ${relationsList(sections.relations)}
      ${religionLink}
      ${raw.details_md ? `<div class="payload-prose"><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
    </section>
  `;
}

/**
 * Faction detail view.
 */
function renderFactionDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};
  const payload = raw.payload || {};

  // Goals with optional progress bars
  let goalsSection = '';
  if (payload.goals?.length || payload.goalProgress?.length) {
    const goals = payload.goalProgress?.length ? payload.goalProgress : payload.goals;
    goalsSection = `
      <div class="detail-box">
        <h3>Goals</h3>
        <div style="display:grid;gap:8px">
          ${goals.map(g => {
            if (typeof g === 'string') {
              return `<div class="relation-row">${escapeHtml(g)}</div>`;
            }
            const name = g.name || g.goal || g.description || '';
            const status = g.status || '';
            const progress = g.progress != null ? Number(g.progress) : null;
            const statusVariant = status === 'complete' ? 'ok'
              : status === 'failed' ? 'error'
              : status === 'in_progress' ? 'warn'
              : 'default';
            return `
              <div class="relation-row" style="display:grid;gap:4px">
                <div style="display:flex;align-items:center;gap:8px">
                  <span>${escapeHtml(name)}</span>
                  ${status ? badge(status, statusVariant) : ''}
                </div>
                ${progress != null ? `
                  <div style="background:var(--line);border-radius:4px;height:6px;overflow:hidden">
                    <div style="background:var(--accent);height:100%;width:${Math.min(Math.max(progress, 0), 100)}%;border-radius:4px"></div>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Faction')}</h2>
          ${actionBtnSoft('Modify', 'run-command', 'data-command="mod"')}
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${raw.kind ? badge(raw.kind, 'accent') : badge('faction', 'accent')}
        ${tagsChips(raw.tags)}
      </div>
      ${summaryBanner(raw.summary || '')}
      ${raw.details_md ? `<div class="payload-prose"><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
      ${goalsSection}
      ${payloadProse('Methods', payload.methods)}
      ${payloadField('Influence', payload.influence)}
      ${relationsList(sections.relations)}
    </section>
  `;
}

/**
 * Generic fallback renderer for unknown entity kinds.
 */
function renderGenericDetail(detail, state) {
  const raw = detail.raw || {};
  const sections = detail.sections || {};

  // Collect all non-empty section lists
  const sectionEntries = Object.entries(sections).filter(
    ([key, val]) => Array.isArray(val) && val.length > 0 && key !== 'relations' && key !== 'awareness'
  );

  const sectionBlocks = sectionEntries.map(([key, items]) => {
    const title = key.charAt(0).toUpperCase() + key.slice(1);
    return entityCardList(title, items);
  }).join('');

  return `
    <section class="detail-card">
      <div>
        ${pathline(detail, state)}
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="font-family:var(--serif);margin:0">${escapeHtml(detail.title || 'Entity')}</h2>
          ${detail.kind ? badge(detail.kind) : ''}
          ${raw.id ? actionBtnDanger('Delete', 'delete-entity', `data-id="${escapeHtml(String(raw.id))}"`) : ''}
        </div>
      </div>
      ${summaryBanner(raw.summary || raw.fullName || '')}
      ${raw.details_md ? `<div class="payload-prose"><div class="prose-body">${renderMarkdown(raw.details_md)}</div></div>` : ''}
      ${tagsChips(raw.tags)}
      ${sectionBlocks}
      ${relationsList(sections.relations)}
      ${sections.awareness?.length ? `
        <div class="detail-box">
          <h3>Awareness</h3>
          <pre class="raw-block mono">${escapeHtml(pretty(sections.awareness))}</pre>
        </div>
      ` : ''}
      <details class="detail-box" style="cursor:pointer">
        <summary><h3 style="display:inline;font-size:0.95rem">Raw JSON</h3></summary>
        <div class="raw-block mono" style="margin-top:8px">${escapeHtml(pretty(raw))}</div>
      </details>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Renderer dispatch map
// ---------------------------------------------------------------------------

const renderers = {
  world: renderWorldOverview,
  state: renderStateDetail,
  burg: renderBurgDetail,
  location: renderLocationDetail,
  npc: renderNpcDetail,
  event: renderEventDetail,
  rumor: renderRumorDetail,
  hook: renderHookDetail,
  deity: renderDeityDetail,
  faction: renderFactionDetail,
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Render entity detail HTML based on the detail kind.
 *
 * Dispatches to a type-specific renderer if one exists, otherwise falls back
 * to the generic renderer.
 *
 * @param {object} detail - The detail object from snapshot.browse.detail
 * @param {object} state  - Full client-side app state (includes snapshot, burgTab, etc.)
 * @returns {string} HTML string
 */
export function renderEntityDetail(detail, state) {
  if (!detail) {
    return '<section class="detail-card"><div class="muted">No entity selected</div></section>';
  }

  const renderer = renderers[detail.kind] || renderGenericDetail;
  return renderer(detail, state);
}
