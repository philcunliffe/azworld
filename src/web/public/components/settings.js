/**
 * settings.js - Full-page settings overlay with tabbed sections.
 *
 * Tabs:
 *   1. Campaign  - World vibe, tone, rating, notes
 *   2. Models    - LLM provider/model configuration per slot
 *   3. Import/Export - Wiki export, canon import/export, source ingest, world init
 *   4. Advanced  - Command console, entity CRUD, relations, awareness
 */

import { escapeHtml, pretty, parseJsonField } from '../lib/util.js';

/** All canon entity types available for creation. */
const ENTITY_TYPES = [
  'location', 'npc', 'faction', 'event', 'rumor', 'hook',
  'culture', 'religion', 'deity', 'era', 'phenomena',
  'relation_type', 'source_text', 'meta',
];

/**
 * Render the settings overlay.
 * Returns an empty string when settings are closed.
 * @param {object} state - Full app state with settingsOpen, settingsTab, snapshot, etc.
 * @returns {string} HTML string
 */
export function renderSettings(state) {
  if (!state.settingsOpen) return '';

  const tab = state.settingsTab || 'campaign';
  const snapshot = state.snapshot;
  const settings = snapshot?.campaignSettings || {};
  const models = snapshot?.models || {};

  let tabContent = '';
  switch (tab) {
    case 'campaign':     tabContent = renderCampaignTab(settings); break;
    case 'models':       tabContent = renderModelsTab(models); break;
    case 'importexport': tabContent = renderImportExportTab(); break;
    case 'advanced':     tabContent = renderAdvancedTab(state); break;
  }

  return `
    <div class="settings-overlay" role="dialog" aria-label="Settings">
      <div class="settings-container">
        <div class="settings-header">
          <h2>Settings</h2>
          <button class="settings-close" data-action="close-settings" aria-label="Close settings">&times;</button>
        </div>
        <div class="settings-tabs">
          ${['campaign', 'models', 'importexport', 'advanced'].map(t => `
            <button class="settings-tab ${tab === t ? 'is-active' : ''}" data-action="set-settings-tab" data-tab="${t}">
              ${t === 'importexport' ? 'Import / Export' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          `).join('')}
        </div>
        <div class="settings-body">
          ${tabContent}
        </div>
      </div>
    </div>
  `;
}

/**
 * Campaign settings form: vibe, touchpoints, arc, tone, rating, notes.
 * @param {object} settings - Campaign settings object
 * @returns {string} HTML string
 */
function renderCampaignTab(settings) {
  return `
    <form id="campaign-form" class="form-grid">
      <label>
        <span class="form-label">World Vibe</span>
        <input name="worldVibe" value="${escapeHtml(settings.worldVibe || '')}" placeholder="e.g. dark fantasy, whimsical, grimdark" />
      </label>
      <label>
        <span class="form-label">Cultural Touchpoints</span>
        <input name="culturalTouchpoints" value="${escapeHtml(settings.culturalTouchpoints || '')}" placeholder="e.g. medieval Europe, feudal Japan" />
      </label>
      <label>
        <span class="form-label">Campaign Arc</span>
        <input name="campaignArc" value="${escapeHtml(settings.campaignArc || '')}" placeholder="e.g. rising darkness, political intrigue" />
      </label>
      <label>
        <span class="form-label">Content Tone (1-5)</span>
        <input name="contentTone" type="number" min="1" max="5" value="${escapeHtml(String(settings.contentTone || 3))}" />
      </label>
      <label>
        <span class="form-label">Rating</span>
        <select name="rating">
          ${['pg', 'teen', 'mature', 'explicit'].map(r => `
            <option value="${r}" ${settings.rating === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>
          `).join('')}
        </select>
      </label>
      <label>
        <span class="form-label">User Notes</span>
        <textarea name="userNotes" placeholder="Additional notes for generation context">${escapeHtml(settings.userNotes || '')}</textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="action-btn" data-action="save-campaign">Save Settings</button>
      </div>
    </form>
  `;
}

/**
 * Model configuration form with three slots: chat, generation, talk.
 * Each slot has provider select, model input, and action buttons.
 * @param {object} models - Current model configuration
 * @returns {string} HTML string
 */
function renderModelsTab(models) {
  const providers = ['ollama', 'openai', 'anthropic'];

  function renderModelSlot(slot, label, info) {
    const current = info || {};
    return `
      <fieldset class="model-slot">
        <legend>${escapeHtml(label)}</legend>
        ${current.provider ? `<div class="muted">Current: ${escapeHtml(current.provider)} / ${escapeHtml(current.model || 'default')}</div>` : ''}
        <div class="model-form" data-slot="${slot}">
          <label>
            <span class="form-label">Provider</span>
            <select name="provider">
              ${providers.map(p => `
                <option value="${p}" ${current.provider === p ? 'selected' : ''}>${escapeHtml(p)}</option>
              `).join('')}
            </select>
          </label>
          <label>
            <span class="form-label">Model</span>
            <input name="model" value="${escapeHtml(current.model || '')}" placeholder="Model name" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="apply-model" data-slot="${slot}">Apply</button>
            ${slot !== 'chat' ? `<button type="button" class="action-btn action-btn-soft" data-action="disable-model" data-slot="${slot}">Disable</button>` : ''}
          </div>
        </div>
      </fieldset>
    `;
  }

  return `
    <div class="models-grid">
      ${renderModelSlot('chat', 'Chat / Director Model', models.chat)}
      ${renderModelSlot('generation', 'Generation Model (optional)', models.generation)}
      ${renderModelSlot('talk', 'NPC Talk Model (optional)', models.talk)}
    </div>
  `;
}

/**
 * Import/Export tab: wiki export, canon export/import, source ingest, world init.
 * @returns {string} HTML string
 */
function renderImportExportTab() {
  return `
    <div class="import-export-sections">
      <fieldset>
        <legend>Wiki Export</legend>
        <form id="wiki-export-form" class="form-grid">
          <label>
            <span class="form-label">Output Directory</span>
            <input name="outDir" value="./wiki" placeholder="e.g. ./wiki" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="export-wiki">Export Wiki</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Canon Export</legend>
        <form id="canon-export-form" class="form-grid">
          <label>
            <span class="form-label">File Path</span>
            <input name="filePath" value="./canon-export.json" placeholder="e.g. ./canon-export.json" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="export-canon">Export Canon</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Canon Import</legend>
        <form id="canon-import-form" class="form-grid">
          <label>
            <span class="form-label">File Path</span>
            <input name="filePath" placeholder="Path to JSON file" />
          </label>
          <label>
            <span class="form-label">Mode</span>
            <select name="mode">
              <option value="upsert">Upsert (update or insert)</option>
              <option value="insert">Insert only (skip existing)</option>
            </select>
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="import-canon">Import</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Source Ingest</legend>
        <form id="ingest-form" class="form-grid">
          <label>
            <span class="form-label">Source Name</span>
            <input name="name" placeholder="e.g. Session 4 Notes" />
          </label>
          <label>
            <span class="form-label">File Path</span>
            <input name="filePath" placeholder="Path to source file (optional)" />
          </label>
          <label>
            <span class="form-label">Scope</span>
            <input name="scope" placeholder="e.g. world, state, burg" />
          </label>
          <label>
            <span class="form-label">Anchors (JSON)</span>
            <textarea name="anchors" placeholder='{"burgId": 12}'></textarea>
          </label>
          <label>
            <span class="form-label">Text Content</span>
            <textarea name="text" placeholder="Paste source text here (if no file path)"></textarea>
          </label>
          <label class="form-checkbox">
            <input type="checkbox" name="apply" />
            <span>Apply immediately after parsing</span>
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="parse-source">Parse Source</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>World Init</legend>
        <form id="worldgen-form" class="form-grid">
          <div class="field-selection-grid">
            <label class="field-toggle">
              <input type="checkbox" name="religions" />
              <span class="field-toggle-label">Religions</span>
            </label>
            <label class="field-toggle">
              <input type="checkbox" name="pantheons" />
              <span class="field-toggle-label">Pantheons</span>
            </label>
            <label class="field-toggle">
              <input type="checkbox" name="cultures" />
              <span class="field-toggle-label">Cultures</span>
            </label>
            <label class="field-toggle">
              <input type="checkbox" name="states" />
              <span class="field-toggle-label">States</span>
            </label>
          </div>
          <label>
            <span class="form-label">State Filter</span>
            <input name="stateFilter" placeholder="Filter by state name (optional)" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="plan-world-init">Plan World Init</button>
          </div>
        </form>
      </fieldset>
    </div>
  `;
}

/**
 * Advanced tab: command console, entity creator, patch, relations, awareness.
 * @param {object} state - Full app state
 * @returns {string} HTML string
 */
function renderAdvancedTab(state) {
  return `
    <div class="advanced-sections">
      <fieldset>
        <legend>Command Console</legend>
        <form id="command-form" class="form-grid">
          <label>
            <span class="form-label">Command</span>
            <input name="command" placeholder="e.g. list burgs --top 10" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="run-command">Run</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Entity Creator</legend>
        <form id="entity-create-form" class="form-grid">
          <label>
            <span class="form-label">Type</span>
            <select name="type">
              ${ENTITY_TYPES.map(t => `<option value="${t}">${escapeHtml(t)}</option>`).join('')}
            </select>
          </label>
          <label>
            <span class="form-label">Name</span>
            <input name="name" placeholder="Entity name" />
          </label>
          <label>
            <span class="form-label">Summary</span>
            <input name="summary" placeholder="Brief description" />
          </label>
          <label>
            <span class="form-label">Details (Markdown)</span>
            <textarea name="details_md" placeholder="Extended description in markdown"></textarea>
          </label>
          <label>
            <span class="form-label">Tags (comma-separated)</span>
            <input name="tags" placeholder="e.g. tavern, merchant, quest-giver" />
          </label>
          <label>
            <span class="form-label">Anchors (JSON)</span>
            <textarea name="anchors" placeholder='{"burgId": 12, "stateId": 3}'></textarea>
          </label>
          <label>
            <span class="form-label">Payload (JSON)</span>
            <textarea name="payload" placeholder='{"rank": "lesser", "domains": ["war"]}'></textarea>
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="create-entity">Create</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Entity Patch</legend>
        <form id="entity-patch-form" class="form-grid">
          <label>
            <span class="form-label">Patch (JSON)</span>
            <textarea name="patch" placeholder='{"summary": "Updated summary", "tags": ["new-tag"]}'></textarea>
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="patch-entity">Patch Current</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Relation Creator</legend>
        <form id="relation-form" class="form-grid">
          <label>
            <span class="form-label">From ID</span>
            <input name="from_id" placeholder="Source entity ID" />
          </label>
          <label>
            <span class="form-label">To ID</span>
            <input name="to_id" placeholder="Target entity ID" />
          </label>
          <label>
            <span class="form-label">Relation Type</span>
            <input name="rel_type" placeholder="e.g. parent_of, rival_of, patron_of" />
          </label>
          <label>
            <span class="form-label">Strength (0-1)</span>
            <input name="strength" type="number" min="0" max="1" step="0.1" value="0.5" />
          </label>
          <label>
            <span class="form-label">Notes</span>
            <input name="notes" placeholder="Optional context" />
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="create-relation">Create Relation</button>
          </div>
        </form>
      </fieldset>

      <fieldset>
        <legend>Awareness</legend>
        <form id="awareness-form" class="form-grid">
          <label>
            <span class="form-label">Actor Type</span>
            <select name="actorType">
              <option value="npc">NPC</option>
              <option value="faction">Faction</option>
              <option value="burg">Burg</option>
            </select>
          </label>
          <label>
            <span class="form-label">Actor ID</span>
            <input name="actorId" placeholder="Actor entity ID" />
          </label>
          <label>
            <span class="form-label">Event ID</span>
            <input name="eventId" placeholder="Event entity ID" />
          </label>
          <label>
            <span class="form-label">Level</span>
            <select name="level">
              <option value="unaware">Unaware</option>
              <option value="rumor">Rumor</option>
              <option value="aware">Aware</option>
              <option value="informed">Informed</option>
              <option value="witness">Witness</option>
            </select>
          </label>
          <div class="form-actions">
            <button type="button" class="action-btn" data-action="set-awareness">Set Awareness</button>
          </div>
        </form>
      </fieldset>
    </div>
  `;
}
