/**
 * ask-modal.js - Modal for asking grounded questions about the currently
 * selected entity.
 *
 * State shape (held in state.askModal):
 *   null                                    – modal closed
 *   { status: 'idle',     entityTitle }
 *   { status: 'loading',  entityTitle, lastQuestion }
 *   { status: 'answered', entityTitle, lastQuestion, reply }
 *   { status: 'errored',  entityTitle, lastQuestion, error }
 *
 * Close on Escape / backdrop click is wired in app.js.
 */

import { escapeHtml, renderMarkdown } from '../lib/util.js';

/**
 * Render the Ask modal.
 * Returns an empty string when the modal is closed.
 * @param {object} state - Full app state with askModal field
 * @returns {string} HTML string
 */
export function renderAskModal(state) {
  const modal = state.askModal;
  if (!modal) return '';

  const status = modal.status || 'idle';
  const entityTitle = modal.entityTitle || 'this entity';
  const lastQuestion = modal.lastQuestion || '';

  const showForm = status === 'idle' || status === 'errored';
  const isLoading = status === 'loading';

  let resultBlock = '';
  if (isLoading) {
    resultBlock = `
      <div class="ask-modal-status">
        <span class="chat-thinking-dots"><span>.</span><span>.</span><span>.</span></span>
        <span>Thinking...</span>
      </div>
    `;
  } else if (status === 'answered') {
    resultBlock = `
      ${lastQuestion ? `
        <div class="ask-modal-question">
          <div class="form-label">Your question</div>
          <div class="ask-modal-question-text">${escapeHtml(lastQuestion)}</div>
        </div>
      ` : ''}
      <div class="ask-modal-reply">
        <div class="form-label">Answer</div>
        <div class="ask-modal-reply-body prose-body">${renderMarkdown(modal.reply || '')}</div>
      </div>
    `;
  } else if (status === 'errored') {
    resultBlock = `
      <div class="ask-modal-error">${escapeHtml(modal.error || 'Something went wrong.')}</div>
    `;
  }

  const formBlock = showForm ? `
    <form id="ask-modal-form" class="ask-modal-form">
      <label>
        <span class="form-label">Question</span>
        <textarea
          name="question"
          id="ask-modal-input"
          placeholder="What would you like to know?"
          rows="3"
          required
        >${escapeHtml(lastQuestion)}</textarea>
      </label>
    </form>
  ` : '';

  let footerButtons = '';
  if (status === 'answered') {
    footerButtons = `
      <button type="button" class="action-btn" data-action="ask-modal-reset">Ask another</button>
      <button type="button" class="action-btn action-btn-soft" data-action="close-ask-modal">Close</button>
    `;
  } else if (isLoading) {
    footerButtons = `
      <button type="button" class="action-btn" disabled>Submitting...</button>
      <button type="button" class="action-btn action-btn-soft" data-action="close-ask-modal">Cancel</button>
    `;
  } else {
    // idle or errored: form is shown
    footerButtons = `
      <button type="submit" form="ask-modal-form" class="action-btn">${status === 'errored' ? 'Retry' : 'Submit'}</button>
      <button type="button" class="action-btn action-btn-soft" data-action="close-ask-modal">Cancel</button>
    `;
  }

  return `
    <div class="ask-modal-overlay" data-action="close-ask-modal-backdrop" role="dialog" aria-modal="true" aria-label="Ask about ${escapeHtml(entityTitle)}">
      <div class="ask-modal-container">
        <div class="ask-modal-header">
          <h2>Ask about ${escapeHtml(entityTitle)}</h2>
          <button class="ask-modal-close" data-action="close-ask-modal" aria-label="Close ask modal" type="button">&times;</button>
        </div>
        <div class="ask-modal-body">
          ${resultBlock}
          ${formBlock}
        </div>
        <div class="ask-modal-footer">
          ${footerButtons}
        </div>
      </div>
    </div>
  `;
}
