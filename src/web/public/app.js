/**
 * app.js - Main entry point for the azweb UI.
 *
 * Imports all view and component modules, manages global state,
 * handles event delegation, and orchestrates the render loop.
 */

import { api, apiPost, apiDelete, apiPatch } from './lib/api.js';
import { state, setRenderCallback, syncSnapshot, pushNotice, navigate, parseHashRoute } from './lib/state.js';
import { initKeyboard, registerShortcut } from './lib/keyboard.js';
import { escapeHtml, parseJsonField } from './lib/util.js';
import { renderTopbar } from './components/topbar.js';
import { renderSidebar } from './components/sidebar.js';
import { renderSideSheet } from './components/side-sheet.js';
import { renderChatDrawer } from './components/chat-drawer.js';
import { renderSettings } from './components/settings.js';
import { renderEntityDetail } from './views/entity-detail.js';
import { loadRegionMap } from './components/region-map.js';
import { renderWorldMap, loadWorldMap } from './views/world-map.js';

const app = document.querySelector('#app');

// ---------------------------------------------------------------------------
// Search overlay
// ---------------------------------------------------------------------------

function renderSearchOverlay() {
  if (!state.searchOpen) return '';
  return `
    <div class="search-overlay" data-action="close-search-backdrop">
      <div class="search-modal">
        <input class="search-input" id="global-search-input" type="search"
               placeholder="Search states, burgs, NPCs, locations..."
               value="${escapeHtml(state.searchQuery)}" autocomplete="off" />
        <div class="search-results">
          ${state.searchResults.map(item => `
            <button class="search-result-item" data-action="navigate" data-ref="${escapeHtml(item.id)}">
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml(item.breadcrumb || item.kind || '')}</small>
            </button>
          `).join('')}
          ${state.searchQuery && !state.searchResults.length ? '<div class="muted" style="padding:12px">No results</div>' : ''}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function renderCommandPalette() {
  if (!state.commandPaletteOpen) return '';
  return `
    <div class="search-overlay" data-action="close-command-palette-backdrop">
      <div class="search-modal command-palette">
        <input class="search-input" id="command-palette-input" type="text"
               placeholder="Enter command: gen location, mod, advance 7d..."
               autocomplete="off" />
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Inline generation form
// ---------------------------------------------------------------------------

function renderGenForm() {
  if (!state.genFormOpen) return '';
  const { type } = state.genFormOpen;
  const label = type === 'advance' ? 'Advance Time' : `Generate ${type.replace('gen ', '')}`;
  const placeholder = type === 'advance' ? '7d trade disruption focus' : 'tavern, undercity contacts, seedy...';
  return `
    <div class="gen-form-inline">
      <div class="gen-form-header">${escapeHtml(label)}</div>
      <form id="gen-inline-form" class="gen-form-body">
        <input name="hints" placeholder="${escapeHtml(placeholder)}" class="gen-form-input" autocomplete="off" />
        <button type="submit" class="action-btn">Plan</button>
        <button type="button" class="action-btn action-btn-soft" data-action="close-gen-form">Cancel</button>
      </form>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

function renderNotices() {
  if (!state.notices.length) return '';
  return `
    <div class="notices-container">
      ${state.notices.map(n => `
        <div class="notice notice-${n.kind}">${escapeHtml(n.message)}</div>
      `).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function render() {
  if (!state.snapshot) {
    app.innerHTML = `
      <div class="loading-shell">
        <h1 style="font-family:var(--serif)">azweb</h1>
        <p class="muted">Loading world data...</p>
      </div>
    `;
    return;
  }

  const detail = state.snapshot.browse?.detail;

  // Auto-open side sheet when pending appears
  if (state.snapshot.pending && !state.sideSheetOpen) {
    state.sideSheetOpen = true;
  }
  if (!state.snapshot.pending && state.sideSheetOpen) {
    state.sideSheetOpen = false;
  }

  const isGeneralChat = state.chatOpen && state.chatMode === 'general';
  const isMapView = state.mapViewActive && !isGeneralChat;

  // Determine main content
  let mainContent;
  if (isGeneralChat) {
    mainContent = renderChatDrawer(state);
  } else if (isMapView) {
    mainContent = renderWorldMap();
  } else {
    mainContent = `${renderGenForm()}${renderEntityDetail(detail, state)}`;
  }

  const workspaceClasses = [
    'workspace',
    state.sidebarCollapsed ? 'sidebar-is-collapsed' : '',
    state.chatOpen && !isGeneralChat ? 'chat-is-open' : '',
    isGeneralChat ? 'general-chat-active' : '',
    isMapView ? 'map-view-active' : '',
  ].filter(Boolean).join(' ');

  app.innerHTML = `
    <div class="${workspaceClasses}">
      ${renderTopbar(state)}
      ${renderSidebar(state)}
      <main class="main-content">
        ${mainContent}
      </main>
      ${renderSideSheet(state)}
      ${!isGeneralChat ? renderChatDrawer(state) : ''}
    </div>
    ${renderSettings(state)}
    ${renderSearchOverlay()}
    ${renderCommandPalette()}
    ${renderNotices()}
  `;

  // Focus search input when overlay opens
  if (state.searchOpen) {
    const input = document.getElementById('global-search-input');
    if (input) input.focus();
  }
  if (state.commandPaletteOpen) {
    const input = document.getElementById('command-palette-input');
    if (input) input.focus();
  }
  // Auto-scroll chat to bottom
  if (state.chatOpen) {
    const msgs = document.getElementById('chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }
  // Load region map if burg detail is showing (only once per burg)
  const mapEl = document.getElementById('region-map');
  if (mapEl && !mapEl.dataset.loaded) {
    const burgId = Number(mapEl.dataset.burgId);
    if (burgId) {
      mapEl.dataset.loaded = '1';
      loadRegionMap(burgId);
    }
  }
  // Load world map if map view is active
  if (isMapView) {
    loadWorldMap();
  }
}

setRenderCallback(render);

// ---------------------------------------------------------------------------
// Command execution helper
// ---------------------------------------------------------------------------

async function runCommand(command) {
  try {
    const data = await apiPost('/api/command', { command });
    syncSnapshot(data.snapshot);
    if (data.result?.error) pushNotice('error', data.result.error);
    if (data.result?.output) pushNotice(data.result.pending ? 'warning' : 'ok', data.result.output);
    if (data.result?.message?.content) pushNotice('ok', data.result.message.content);
  } catch (e) {
    pushNotice('error', e.message);
  }
}

// ---------------------------------------------------------------------------
// Search debounce
// ---------------------------------------------------------------------------

let searchTimeout = null;
function handleSearchInput(query) {
  state.searchQuery = query;
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    state.searchResults = [];
    render();
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      const data = await api('/api/search?q=' + encodeURIComponent(query));
      state.searchResults = data.results || [];
      render();
    } catch (e) {
      // ignore search errors
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// Event delegation: clicks
// ---------------------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  try {
    // Navigation
    if (action === 'navigate') {
      const ref = target.dataset.ref;
      if (ref) {
        state.mapViewActive = false; // close map when navigating to entity
        await navigate(ref);
      }
      // Close search if open
      state.searchOpen = false;
      state.searchQuery = '';
      state.searchResults = [];
      return;
    }

    // World map toggle
    if (action === 'toggle-map') {
      state.mapViewActive = !state.mapViewActive;
      if (state.mapViewActive) {
        state.chatOpen = false; // close chat when opening map
      }
      render();
      return;
    }

    // Map context menu: generate marker
    if (action === 'map-gen-marker') {
      const cellId = target.dataset.cellId;
      const x = target.dataset.x;
      const y = target.dataset.y;
      const stateId = target.dataset.stateId;
      // Open general chat with prefilled prompt
      state.mapViewActive = false;
      state.chatOpen = true;
      state.chatMode = 'general';
      render();
      // Auto-fill the chat input
      setTimeout(() => {
        const input = document.querySelector('.chat-input');
        if (input) {
          input.value = `Generate a marker near cell ${cellId}${stateId ? ` in state ${stateId}` : ''}. Suggest something interesting for this wilderness location.`;
          input.focus();
        }
      }, 100);
      return;
    }

    // Sidebar toggle
    if (action === 'toggle-sidebar') {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      render();
      return;
    }

    // Search
    if (action === 'toggle-search') {
      state.searchOpen = !state.searchOpen;
      state.searchQuery = '';
      state.searchResults = [];
      render();
      return;
    }
    if (action === 'close-search-backdrop') {
      if (event.target === event.target.closest('.search-overlay')) {
        state.searchOpen = false;
        render();
      }
      return;
    }

    // Chat
    if (action === 'toggle-chat') {
      state.chatOpen = !state.chatOpen;
      render();
      return;
    }
    if (action === 'close-chat') {
      state.chatOpen = false;
      render();
      return;
    }
    if (action === 'set-chat-mode') {
      state.chatMode = target.dataset.mode || 'director';
      render();
      return;
    }
    if (action === 'open-chat-npc') {
      state.chatOpen = true;
      state.chatMode = 'npc';
      render();
      return;
    }

    // Settings
    if (action === 'open-settings') {
      state.settingsOpen = true;
      if (target.dataset.tab) state.settingsTab = target.dataset.tab;
      render();
      return;
    }
    if (action === 'close-settings') {
      state.settingsOpen = false;
      render();
      return;
    }
    if (action === 'set-settings-tab') {
      state.settingsTab = target.dataset.tab;
      render();
      return;
    }

    // Side sheet
    if (action === 'close-side-sheet') {
      state.sideSheetOpen = false;
      render();
      return;
    }
    if (action === 'approve-pending') {
      const data = await apiPost('/api/pending/approve', {});
      syncSnapshot(data.snapshot);
      pushNotice(data.result?.pending ? 'warning' : 'ok', data.result?.output || 'Approved.');
      return;
    }
    if (action === 'reject-pending') {
      const data = await apiPost('/api/pending/reject', {});
      syncSnapshot(data.snapshot);
      pushNotice('ok', data.result?.output || 'Cancelled.');
      state.sideSheetOpen = false;
      return;
    }
    if (action === 'approve-inline-plan') {
      const planId = target.dataset.planId;
      if (!planId) return;
      const data = await apiPost('/api/chat/general/plan/approve', { planId });
      syncSnapshot(data.snapshot);
      pushNotice('ok', data.result?.output || 'Plan approved and generating.');
      return;
    }
    if (action === 'reject-inline-plan') {
      const planId = target.dataset.planId;
      if (!planId) return;
      const data = await apiPost('/api/chat/general/plan/reject', { planId });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Plan rejected.');
      return;
    }
    if (action === 'submit-field-plan') {
      const form = document.getElementById('field-plan-form');
      if (!form) return;
      const formData = new FormData(form);
      const selectedFields = formData.getAll('selectedField').map(String);
      const hint = String(formData.get('hint') || '');
      const data = await apiPost('/api/pending/field-plan', { selectedFields, hint });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Field regeneration planned.');
      return;
    }

    // Burg tabs
    if (action === 'set-burg-tab') {
      state.burgTab = target.dataset.tab;
      render();
      return;
    }
    // Map tabs (region / city) - handled client-side without re-render
    if (action === 'set-map-tab') {
      const tab = target.dataset.tab;
      const regionPanel = document.getElementById('burg-map-region');
      const cityPanel = document.getElementById('burg-map-city');
      if (regionPanel && cityPanel) {
        regionPanel.style.display = tab === 'region' ? '' : 'none';
        cityPanel.style.display = tab === 'city' ? '' : 'none';
        // Update active tab
        const tabs = target.parentElement?.querySelectorAll('[data-action="set-map-tab"]');
        if (tabs) tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
      }
      return;
    }

    // Generation form
    if (action === 'open-gen-form') {
      state.genFormOpen = { type: target.dataset.type || 'gen' };
      render();
      return;
    }
    if (action === 'close-gen-form') {
      state.genFormOpen = null;
      render();
      return;
    }

    // Run command (from action buttons or advanced console)
    if (action === 'run-command') {
      let command = target.dataset.command;
      if (!command) {
        // Check if there's a form input nearby (advanced console)
        const form = target.closest('form');
        if (form) {
          command = String(new FormData(form).get('command') || '').trim();
          if (command) form.reset();
        }
      }
      if (command) await runCommand(command);
      return;
    }

    // Delete entity
    if (action === 'delete-entity') {
      if (!confirm('Delete this entity?')) return;
      const data = await apiDelete(`/api/canon/entity/${encodeURIComponent(target.dataset.id)}`);
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Entity deleted.');
      return;
    }

    // Delete relation
    if (action === 'delete-relation') {
      if (!confirm('Delete this relation?')) return;
      const data = await apiDelete(`/api/canon/relation/${encodeURIComponent(target.dataset.id)}`);
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Relation deleted.');
      return;
    }

    // Modify entity
    if (action === 'modify-entity') {
      await runCommand('mod');
      return;
    }

    // Regen fields
    if (action === 'regen-fields') {
      await runCommand(`gen ${target.dataset.type || ''} ${target.dataset.name || ''}`);
      return;
    }

    // Command palette
    if (action === 'close-command-palette-backdrop') {
      if (event.target === event.target.closest('.search-overlay')) {
        state.commandPaletteOpen = false;
        render();
      }
      return;
    }

    // Load models list
    if (action === 'load-models') {
      const slot = target.dataset.slot;
      const form = document.querySelector(`.model-form[data-slot="${slot}"]`);
      if (!form) return;
      const provider = form.querySelector('select[name="provider"]')?.value;
      const data = await api(`/api/settings/models?provider=${encodeURIComponent(provider)}`);
      pushNotice('ok', (data.models || []).map(m => m.id).slice(0, 12).join(', ') || 'No models returned.');
      return;
    }

    // Disable separate model
    if (action === 'disable-model') {
      const slot = target.dataset.slot;
      const data = await apiPost('/api/settings/model', { slot, disable: true });
      syncSnapshot(data.snapshot);
      pushNotice('ok', `Disabled separate ${slot} model.`);
      return;
    }

    // Settings form actions (buttons with data-action in settings overlay)
    if (action === 'save-campaign') {
      const form = document.getElementById('campaign-form');
      if (!form) return;
      const fd = new FormData(form);
      await apiPost('/api/settings/campaign', {
        settings: {
          worldVibe: fd.get('worldVibe') || undefined,
          culturalTouchpoints: fd.get('culturalTouchpoints') || undefined,
          campaignArc: fd.get('campaignArc') || undefined,
          userNotes: fd.get('userNotes') || undefined,
          contentTone: fd.get('contentTone') ? Number(fd.get('contentTone')) : undefined,
          rating: fd.get('rating') || undefined,
        },
      });
      const snap = await api('/api/bootstrap');
      syncSnapshot(snap);
      pushNotice('ok', 'Campaign settings updated.');
      return;
    }

    if (action === 'apply-model') {
      const slot = target.dataset.slot;
      const container = document.querySelector(`.model-form[data-slot="${slot}"]`);
      if (!container) return;
      const provider = container.querySelector('select[name="provider"]')?.value;
      const model = container.querySelector('input[name="model"]')?.value;
      const data = await apiPost('/api/settings/model', { slot, provider, model });
      syncSnapshot(data.snapshot);
      pushNotice('ok', `Updated ${slot} model.`);
      return;
    }

    if (action === 'export-wiki') {
      const form = document.getElementById('wiki-export-form');
      if (!form) return;
      const data = await apiPost('/api/tools/wiki-export', { outDir: new FormData(form).get('outDir') });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Wiki exported.');
      return;
    }

    if (action === 'export-canon') {
      const form = document.getElementById('canon-export-form');
      if (!form) return;
      const data = await apiPost('/api/tools/canon-export', { outFile: new FormData(form).get('filePath') });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Canon exported.');
      return;
    }

    if (action === 'import-canon') {
      const form = document.getElementById('canon-import-form');
      if (!form) return;
      const fd = new FormData(form);
      const data = await apiPost('/api/tools/canon-import', { inputFile: fd.get('filePath'), mode: fd.get('mode') });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Canon imported.');
      return;
    }

    if (action === 'parse-source') {
      const form = document.getElementById('ingest-form');
      if (!form) return;
      const fd = new FormData(form);
      const data = await apiPost('/api/tools/ingest', {
        name: fd.get('name') || undefined,
        filePath: fd.get('filePath') || undefined,
        text: fd.get('text') || undefined,
        scope: fd.get('scope') || undefined,
        apply: fd.get('apply') === 'on',
        anchors: parseJsonField(String(fd.get('anchors') || ''), {}),
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Source ingest complete.');
      return;
    }

    if (action === 'plan-world-init') {
      const form = document.getElementById('worldgen-form');
      if (!form) return;
      const fd = new FormData(form);
      const filter = String(fd.get('stateFilter') || '')
        .split(',').map(v => Number(v.trim())).filter(v => !Number.isNaN(v));
      const data = await apiPost('/api/worldgen/start', {
        flags: {
          religions: !!fd.get('religions'),
          pantheons: !!fd.get('pantheons'),
          cultures: !!fd.get('cultures'),
          states: !!fd.get('states'),
        },
        stateFilter: filter.length ? filter : undefined,
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'World generation plan prepared.');
      return;
    }

    if (action === 'create-entity') {
      const form = document.getElementById('entity-create-form');
      if (!form) return;
      const fd = new FormData(form);
      const data = await apiPost('/api/canon/entity', {
        entity: {
          type: fd.get('type'),
          name: fd.get('name'),
          summary: fd.get('summary') || null,
          details_md: fd.get('details_md') || null,
          tags: String(fd.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean),
          anchors: parseJsonField(String(fd.get('anchors') || ''), {}),
          payload: parseJsonField(String(fd.get('payload') || ''), {}),
        },
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Entity created.');
      form.reset();
      return;
    }

    if (action === 'patch-entity') {
      const detail = state.snapshot?.browse?.detail;
      const entityId = detail?.raw?.id;
      if (!entityId) { pushNotice('error', 'Select a canon entity first.'); return; }
      const form = document.getElementById('entity-patch-form');
      if (!form) return;
      const patch = parseJsonField(String(new FormData(form).get('patch') || ''), {});
      const data = await apiPatch('/api/canon/entity', { entityId, patch });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Entity patched.');
      return;
    }

  } catch (e) {
    pushNotice('error', e.message || String(e));
  }
});

// ---------------------------------------------------------------------------
// Event delegation: form submissions
// ---------------------------------------------------------------------------

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();

  try {
    // Inline generation form
    if (form.id === 'gen-inline-form') {
      const hints = String(new FormData(form).get('hints') || '').trim();
      const type = state.genFormOpen?.type || 'gen';
      const command = [type, hints].filter(Boolean).join(' ');
      state.genFormOpen = null;
      await runCommand(command);
      return;
    }

    // Chat form
    if (form.id === 'chat-form') {
      const formData = new FormData(form);
      const message = String(formData.get('message') || '').trim();
      if (!message) return;

      // Show user message immediately + thinking indicator
      state._pendingChatMessages = [{ role: 'user', content: message }];
      state._chatThinking = true;
      form.reset();
      render();

      try {
        if (state.chatMode === 'general') {
          const data = await apiPost('/api/chat/general', { message });
          syncSnapshot(data.snapshot);
        } else if (state.chatMode === 'director') {
          const data = await apiPost('/api/chat/director', { message });
          syncSnapshot(data.snapshot);
        } else {
          const npcName = String(formData.get('npcName') || '').trim() || undefined;
          const data = await apiPost('/api/chat/npc', { message, npcName });
          syncSnapshot(data.snapshot);
        }
      } finally {
        state._pendingChatMessages = [];
        state._chatThinking = false;
        render();
      }
      return;
    }

    // Command console (in advanced settings)
    if (form.id === 'command-form') {
      const command = String(new FormData(form).get('command') || '').trim();
      if (command) await runCommand(command);
      form.reset();
      return;
    }

    // Campaign settings
    if (form.id === 'campaign-form') {
      const fd = new FormData(form);
      await apiPost('/api/settings/campaign', {
        settings: {
          worldVibe: fd.get('worldVibe') || undefined,
          culturalTouchpoints: fd.get('culturalTouchpoints') || undefined,
          campaignArc: fd.get('campaignArc') || undefined,
          userNotes: fd.get('userNotes') || undefined,
          contentTone: fd.get('contentTone') ? Number(fd.get('contentTone')) : undefined,
          rating: fd.get('rating') || undefined,
        },
      });
      const snap = await api('/api/bootstrap');
      syncSnapshot(snap);
      pushNotice('ok', 'Campaign settings updated.');
      return;
    }

    // World gen
    if (form.id === 'worldgen-form') {
      const fd = new FormData(form);
      const filter = String(fd.get('stateFilter') || '')
        .split(',').map(v => Number(v.trim())).filter(v => !Number.isNaN(v));
      const data = await apiPost('/api/worldgen/start', {
        flags: {
          religions: fd.get('religions') === 'on',
          pantheons: fd.get('pantheons') === 'on',
          cultures: fd.get('cultures') === 'on',
          states: fd.get('states') === 'on',
        },
        stateFilter: filter.length ? filter : undefined,
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'World generation plan prepared.');
      return;
    }

    // Ingest
    if (form.id === 'ingest-form') {
      const fd = new FormData(form);
      const data = await apiPost('/api/tools/ingest', {
        name: fd.get('name') || undefined,
        filePath: fd.get('filePath') || undefined,
        text: fd.get('text') || undefined,
        scope: fd.get('scope') || undefined,
        apply: fd.get('apply') === 'on',
        anchors: parseJsonField(String(fd.get('anchors') || ''), {}),
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Source ingest complete.');
      return;
    }

    // Wiki export
    if (form.id === 'wiki-export-form') {
      const data = await apiPost('/api/tools/wiki-export', { outDir: new FormData(form).get('outDir') });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Wiki exported.');
      return;
    }

    // Canon export
    if (form.id === 'canon-export-form') {
      const data = await apiPost('/api/tools/canon-export', { outFile: new FormData(form).get('outFile') });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Canon exported.');
      return;
    }

    // Canon import
    if (form.id === 'canon-import-form') {
      const fd = new FormData(form);
      const data = await apiPost('/api/tools/canon-import', {
        inputFile: fd.get('inputFile'),
        mode: fd.get('mode'),
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Canon imported.');
      return;
    }

    // Entity create
    if (form.id === 'entity-create-form') {
      const fd = new FormData(form);
      const data = await apiPost('/api/canon/entity', {
        entity: {
          type: fd.get('type'),
          name: fd.get('name'),
          summary: fd.get('summary') || null,
          details_md: fd.get('details_md') || null,
          tags: String(fd.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean),
          anchors: parseJsonField(String(fd.get('anchors') || ''), {}),
          payload: parseJsonField(String(fd.get('payload') || ''), {}),
        },
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Entity created.');
      form.reset();
      return;
    }

    // Entity patch
    if (form.id === 'entity-patch-form') {
      const detail = state.snapshot?.browse?.detail;
      const entityId = detail?.raw?.id;
      if (!entityId) { pushNotice('error', 'Select a canon entity first.'); return; }
      const patch = parseJsonField(String(new FormData(form).get('patch') || ''), {});
      const data = await apiPatch('/api/canon/entity', { entityId, patch });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Entity patched.');
      return;
    }

    // Relation create
    if (form.id === 'relation-form') {
      const fd = new FormData(form);
      const data = await apiPost('/api/canon/relation', {
        relation: {
          from_id: fd.get('from_id'),
          to_id: fd.get('to_id'),
          rel_type: fd.get('rel_type'),
          strength: fd.get('strength') ? Number(fd.get('strength')) : null,
          notes: fd.get('notes') || null,
        },
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Relation created.');
      return;
    }

    // Awareness
    if (form.id === 'awareness-form') {
      const fd = new FormData(form);
      const data = await apiPost('/api/canon/awareness', {
        actorType: fd.get('actorType'),
        actorId: fd.get('actorId'),
        eventId: fd.get('eventId'),
        level: fd.get('level'),
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', 'Awareness updated.');
      return;
    }

    // Model forms
    if (form.classList.contains('model-form')) {
      const fd = new FormData(form);
      const slot = form.dataset.slot;
      const data = await apiPost('/api/settings/model', {
        slot,
        provider: fd.get('provider'),
        model: fd.get('model'),
      });
      syncSnapshot(data.snapshot);
      pushNotice('ok', `Updated ${slot} model.`);
      return;
    }
  } catch (e) {
    pushNotice('error', e.message || String(e));
  }
});

// ---------------------------------------------------------------------------
// Event delegation: inputs (search, command palette)
// ---------------------------------------------------------------------------

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'global-search-input') {
    handleSearchInput(target.value);
  }
});

document.addEventListener('keydown', (event) => {
  // Command palette enter
  if (event.key === 'Enter' && event.target.id === 'command-palette-input') {
    event.preventDefault();
    const command = event.target.value.trim();
    if (command) {
      state.commandPaletteOpen = false;
      runCommand(command);
    }
    return;
  }
  // Search enter to navigate to first result
  if (event.key === 'Enter' && event.target.id === 'global-search-input') {
    event.preventDefault();
    if (state.searchResults.length) {
      const ref = state.searchResults[0].id;
      state.searchOpen = false;
      state.searchQuery = '';
      state.searchResults = [];
      navigate(ref);
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

registerShortcut('search', () => {
  state.searchOpen = !state.searchOpen;
  if (!state.searchOpen) {
    state.searchQuery = '';
    state.searchResults = [];
  }
  render();
});

registerShortcut('chat-director', () => {
  state.chatOpen = !state.chatOpen;
  state.chatMode = 'director';
  render();
});

registerShortcut('command-palette', () => {
  state.commandPaletteOpen = !state.commandPaletteOpen;
  render();
});

registerShortcut('toggle-sidebar', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  render();
});

registerShortcut('escape', () => {
  if (state.commandPaletteOpen) { state.commandPaletteOpen = false; render(); return; }
  if (state.searchOpen) { state.searchOpen = false; state.searchQuery = ''; state.searchResults = []; render(); return; }
  if (state.settingsOpen) { state.settingsOpen = false; render(); return; }
  if (state.genFormOpen) { state.genFormOpen = null; render(); return; }
});

initKeyboard();

// ---------------------------------------------------------------------------
// Hash-based routing
// ---------------------------------------------------------------------------

window.addEventListener('hashchange', async () => {
  const ref = parseHashRoute();
  if (ref && ref !== 'world') {
    await navigate(ref);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    syncSnapshot(data);
    // If URL has a hash route, navigate to it
    const ref = parseHashRoute();
    if (ref && ref !== 'world') {
      await navigate(ref);
    }
  } catch (e) {
    app.innerHTML = `
      <div class="loading-shell">
        <h1 style="font-family:var(--serif)">azweb</h1>
        <p style="color:var(--error)">${escapeHtml(e.message || String(e))}</p>
      </div>
    `;
  }
}

bootstrap();

// ---------------------------------------------------------------------------
// Livereload
// ---------------------------------------------------------------------------

const evtSource = new EventSource('/api/livereload');
evtSource.onmessage = (event) => {
  if (event.data === 'reload') location.reload();
};
