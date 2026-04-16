/**
 * chat-drawer.js - Chat UI for Director, NPC, and General chat.
 *
 * General mode renders as a full-page panel inside main content.
 * Director/NPC modes render as a bottom drawer overlay.
 *
 * Features:
 *   - Director / NPC / General tab switcher
 *   - Scrollable message history
 *   - Rich block rendering for General chat (tool calls, inline plans)
 *   - Thinking indicator while waiting for LLM response
 */

import { escapeHtml, renderMarkdown } from '../lib/util.js';

/**
 * Render the chat drawer.
 * @param {object} state - Full app state with snapshot, chatOpen, chatMode, etc.
 * @returns {string} HTML string
 */
export function renderChatDrawer(state) {
  if (!state.chatOpen) {
    return `
      <div class="chat-drawer-minimized">
        <button class="chat-drawer-toggle" data-action="toggle-chat">Chat</button>
      </div>
    `;
  }

  const scene = state.snapshot?.scene?.scene;
  const chatState = state.snapshot?.scene?.chatState || {};
  const mode = state.chatMode || 'director';
  const isGeneral = mode === 'general';

  // Select appropriate history for active mode
  let history = [];
  if (mode === 'director') {
    history = chatState.directorHistory || [];
  } else if (mode === 'npc') {
    const npcId = chatState.currentNpcId;
    history = npcId ? (chatState.npcHistories?.[npcId] || []) : [];
  } else if (mode === 'general') {
    history = chatState.generalHistory || [];
  }

  // Append optimistic messages (local-only, before server responds)
  if (state._pendingChatMessages?.length) {
    history = [...history, ...state._pendingChatMessages];
  }

  // Scene context line (Director/NPC only)
  const sceneCtx = scene
    ? `${scene.burg?.name || ''}${scene.location ? ' > ' + scene.location.name : ''}`
    : 'No scene set';
  const npcsPresent = scene?.npcs?.length
    ? scene.npcs.map(n => n.name).join(', ')
    : 'None';

  // Placeholder text per mode
  const placeholders = {
    director: 'Describe the scene...',
    npc: 'Say something...',
    general: 'Ask about the world...',
  };

  // Use different wrapper class for full-page vs drawer
  const wrapperClass = isGeneral ? 'chat-fullpage' : 'chat-drawer open';

  return `
    <div class="${wrapperClass}">
      <div class="chat-drawer-header">
        <div class="chat-tabs">
          <button class="chat-tab ${mode === 'general' ? 'is-active' : ''}" data-action="set-chat-mode" data-mode="general">General</button>
          <button class="chat-tab ${mode === 'director' ? 'is-active' : ''}" data-action="set-chat-mode" data-mode="director">Director</button>
          <button class="chat-tab ${mode === 'npc' ? 'is-active' : ''}" data-action="set-chat-mode" data-mode="npc">NPC${chatState.currentNpcId ? ': ' + escapeHtml(chatState.currentNpcName || '') : ''}</button>
        </div>
        <div class="chat-drawer-controls">
          <button class="chat-minimize" data-action="toggle-chat" title="Minimize">&#x2014;</button>
          <button class="chat-close" data-action="close-chat" title="Close">&times;</button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages">
        ${history.length === 0 && isGeneral ? `
          <div class="chat-empty">
            <p class="chat-empty-title">World Chat</p>
            <p class="muted">Ask questions about your world, discuss lore, or request new content to be generated.</p>
          </div>
        ` : ''}
        ${history.map(msg => renderMessage(msg, isGeneral)).join('')}
        ${state._chatThinking ? `
          <div class="chat-msg chat-msg-assistant">
            <div class="chat-msg-role">assistant</div>
            <div class="chat-msg-content chat-thinking">
              <span class="chat-thinking-dots"><span>.</span><span>.</span><span>.</span></span> Thinking
            </div>
          </div>
        ` : ''}
      </div>
      ${!isGeneral ? `
        <div class="chat-context">
          <span class="muted">Scene: ${escapeHtml(sceneCtx)}</span>
          ${mode === 'npc' ? `<span class="muted">NPCs: ${escapeHtml(npcsPresent)}</span>` : ''}
        </div>
      ` : ''}
      <form id="chat-form" class="chat-input-row">
        ${mode === 'npc' && !chatState.currentNpcId ? `
          <input name="npcName" placeholder="NPC name" class="chat-npc-name" autocomplete="off" />
        ` : ''}
        <input name="message" placeholder="${placeholders[mode] || placeholders.general}" class="chat-input" autocomplete="off" ${state._chatThinking ? 'disabled' : ''} />
        <button type="submit" class="chat-send" ${state._chatThinking ? 'disabled' : ''}>Send</button>
      </form>
    </div>
  `;
}

/**
 * Render a single chat message. For general mode, supports rich blocks.
 */
function renderMessage(msg, isGeneral) {
  const roleClass = msg.role === 'assistant' ? 'assistant' : 'user';

  if (isGeneral && msg.blocks?.length) {
    return `
      <div class="chat-msg chat-msg-${roleClass}">
        <div class="chat-msg-role">${escapeHtml(msg.role)}</div>
        <div class="chat-msg-content chat-msg-blocks">
          ${msg.blocks.map(renderBlock).join('')}
        </div>
      </div>
    `;
  }

  if (isGeneral && roleClass === 'assistant') {
    return `
      <div class="chat-msg chat-msg-${roleClass}">
        <div class="chat-msg-role">${escapeHtml(msg.role)}</div>
        <div class="chat-msg-content chat-msg-prose">${renderMarkdown(msg.content)}</div>
      </div>
    `;
  }

  return `
    <div class="chat-msg chat-msg-${roleClass}">
      <div class="chat-msg-role">${escapeHtml(msg.role)}</div>
      <div class="chat-msg-content">${escapeHtml(msg.content)}</div>
    </div>
  `;
}

/**
 * Render a single chat block (text, tool_call, or plan).
 */
function renderBlock(block) {
  switch (block.type) {
    case 'text':
      return `<div class="chat-block-text">${renderMarkdown(block.text)}</div>`;

    case 'tool_call':
      return `<div class="chat-block-tool"><span class="chat-tool-dot"></span>${escapeHtml(formatToolName(block.name))}</div>`;

    case 'plan':
      return renderPlanBlock(block);

    default:
      return '';
  }
}

/**
 * Render an inline plan card with entity list and approve/reject actions.
 */
function renderPlanBlock(block) {
  const statusClass = block.status || 'pending';
  const isPending = statusClass === 'pending';

  return `
    <div class="chat-plan-card chat-plan-${statusClass}">
      <div class="chat-plan-header">
        <strong>Generation Plan</strong>
        <span class="chat-plan-status badge badge-${statusClass}">${escapeHtml(statusClass)}</span>
      </div>
      ${block.summary ? `<div class="chat-plan-summary">${escapeHtml(block.summary)}</div>` : ''}
      <div class="chat-plan-entities">
        ${(block.entities || []).map((entity, i) => `
          <div class="chat-plan-entity">
            <span class="chat-plan-entity-num">${i + 1}.</span>
            <strong>${escapeHtml(entity.name)}</strong>
            <span class="badge">${escapeHtml(entity.type)}${entity.kind ? ` / ${escapeHtml(entity.kind)}` : ''}</span>
            ${entity.reason ? `<div class="chat-plan-entity-reason">${escapeHtml(entity.reason)}</div>` : ''}
          </div>
        `).join('')}
      </div>
      ${isPending ? `
        <div class="chat-plan-actions">
          <button class="action-btn action-btn-sm" data-action="approve-inline-plan" data-plan-id="${escapeHtml(block.planId)}">Approve</button>
          <button class="action-btn action-btn-soft action-btn-sm" data-action="reject-inline-plan" data-plan-id="${escapeHtml(block.planId)}">Reject</button>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Format a tool name for display.
 */
function formatToolName(name) {
  const labels = {
    world_lookupBurg: 'Looking up burg...',
    world_lookupState: 'Looking up state...',
    world_getBurgDetails: 'Getting burg details...',
    world_getStateDetails: 'Getting state details...',
    canon_query: 'Searching canon...',
    canon_get: 'Reading entity...',
    canon_getActiveEvents: 'Checking events...',
    canon_upsert: 'Updating canon...',
    canon_link: 'Creating relation...',
  };
  return labels[name] || `${name.replace(/_/g, ' ')}...`;
}
