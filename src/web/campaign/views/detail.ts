import type { Campaign, Slot, MultiSlot, HistoryEntry, SlotKind, MultiSlotKind, Candidate } from "../../../campaign/types";
import type { CanonStore } from "../../../canon/canon";
import { escapeHtml, htmlPage } from "./layout";

const SINGLE_SLOTS: SlotKind[] = ["region", "location", "event", "faction"];
const MULTI_SLOTS: MultiSlotKind[] = ["npcs", "lore", "hooks"];
const HISTORY_TAIL = 30;

function renderCandidate(c: Candidate): string {
  return `<div class="candidate">
    <span class="cid">${escapeHtml(c.id)}</span>
    <strong>${escapeHtml(c.name)}</strong>
    <div>${escapeHtml(c.summary)}</div>
  </div>`;
}

function renderSingletonSlot(slotKind: SlotKind, slot: Slot, canon: CanonStore | null): string {
  let body = "";
  if (slot.status === "open") {
    body = `<p class="empty">Not yet started.</p>`;
  } else if (slot.status === "proposed") {
    const candidates = slot.candidates ?? [];
    if (candidates.length === 0) {
      body = `<p class="empty">Proposed, but no candidates recorded.</p>`;
    } else {
      body = `<p><em>${candidates.length} candidate${candidates.length === 1 ? "" : "s"} proposed — type your pick or revisions into the box below.</em></p>` +
        candidates.map(renderCandidate).join("");
    }
  } else if (slot.status === "accepted") {
    const entityId = slot.entityId;
    const entity = entityId && canon ? canon.getEntity(entityId) : undefined;
    const name = entity?.name ?? `(entity ${entityId})`;
    const summary = entity?.summary ?? "";
    body = `<div class="accepted-entry">
      <strong>${escapeHtml(name)}</strong>${entityId ? ` <code>${escapeHtml(entityId)}</code>` : ""}
      ${summary ? `<div>${escapeHtml(summary)}</div>` : ""}
    </div>`;
  }
  if (slot.notes) {
    body += `<div class="notes">Notes: ${escapeHtml(slot.notes)}</div>`;
  }
  return `<section class="slot" data-status="${escapeHtml(slot.status)}">
    <h3>${escapeHtml(slotKind)}<span class="status-tag ${escapeHtml(slot.status)}">${escapeHtml(slot.status)}</span></h3>
    ${body}
  </section>`;
}

function renderMultiSlot(slotKind: MultiSlotKind, slot: MultiSlot, canon: CanonStore | null): string {
  const entries = slot.entries;
  const status = entries.length > 0 ? "accepted" : "open";
  let body: string;
  if (entries.length === 0) {
    body = `<p class="empty">No entries accepted yet.</p>`;
  } else {
    body = entries.map((entry) => {
      const entity = entry.entityId && canon ? canon.getEntity(entry.entityId) : undefined;
      const name = entity?.name ?? `(candidate ${entry.candidateId})`;
      const summary = entity?.summary ?? "";
      return `<div class="accepted-entry">
        <strong>${escapeHtml(name)}</strong>
        <code>${escapeHtml(entry.candidateId)}</code>${entry.entityId ? ` <code>${escapeHtml(entry.entityId)}</code>` : ""}
        ${summary ? `<div>${escapeHtml(summary)}</div>` : ""}
      </div>`;
    }).join("");
  }
  return `<section class="slot" data-status="${escapeHtml(status)}">
    <h3>${escapeHtml(slotKind)}<span class="status-tag ${escapeHtml(status)}">${entries.length} entr${entries.length === 1 ? "y" : "ies"}</span></h3>
    ${body}
  </section>`;
}

function renderHistoryEntry(entry: HistoryEntry): string {
  if (entry.kind === "user") {
    return `<details class="history-entry"><summary><strong>You</strong> · <span>${escapeHtml(entry.ts)}</span></summary><div>${escapeHtml(entry.text)}</div></details>`;
  }
  if (entry.kind === "assistant") {
    return `<details class="history-entry" open><summary><strong>Builder</strong> · <span>${escapeHtml(entry.ts)}</span></summary><div>${escapeHtml(entry.text || "(no text)")}</div></details>`;
  }
  if (entry.kind === "tool_call") {
    return `<details class="history-entry"><summary><em>tool_call</em> ${escapeHtml(entry.tool)} · <span>${escapeHtml(entry.ts)}</span></summary><pre>${escapeHtml(JSON.stringify(entry.args, null, 2))}</pre></details>`;
  }
  return `<details class="history-entry"><summary><em>tool_result</em> ${escapeHtml(entry.tool)} · <span>${escapeHtml(entry.ts)}</span></summary><pre>${escapeHtml(JSON.stringify(entry.result, null, 2))}</pre></details>`;
}

export function renderDetailPage(opts: {
  campaign: Campaign;
  canon: CanonStore | null;
  error?: string;
  notice?: string;
}): string {
  const { campaign, canon, error, notice } = opts;
  const state = campaign.state;
  const singletons = SINGLE_SLOTS.map((k) => renderSingletonSlot(k, state.slots[k], canon)).join("");
  const multis = MULTI_SLOTS.map((k) => renderMultiSlot(k, state.multi[k], canon)).join("");
  const history = state.history.slice(-HISTORY_TAIL).map(renderHistoryEntry).join("");

  const errBanner = error ? `<p style="color:#b91c1c"><strong>${escapeHtml(error)}</strong></p>` : "";
  const noticeBanner = notice ? `<p style="color:#166534"><em>${escapeHtml(notice)}</em></p>` : "";

  const archiveSection = campaign.status === "archived"
    ? `<p><em>This campaign is archived.</em></p>`
    : `<form class="inline" method="post" action="/campaign/${escapeHtml(campaign.id)}/archive">
        <button class="danger" type="submit">Archive campaign</button>
      </form>`;

  const intentBlock = campaign.intentMd
    ? `<h2>Initial intent</h2><pre>${escapeHtml(campaign.intentMd)}</pre>`
    : "";

  const turnForm = campaign.status === "archived"
    ? `<p class="empty">Archived — turns disabled.</p>`
    : `<form class="turn-form" method="post" action="/campaign/${escapeHtml(campaign.id)}/say">
        <label>
          Your next turn<br />
          <textarea name="text" rows="3" required placeholder="Describe what you want, or pick a candidate (e.g. 'go with #2 but make it a free port')"></textarea>
        </label>
        <p><button type="submit">Send turn</button></p>
      </form>`;

  const body = `
    <nav class="crumbs"><a href="/campaign">Campaigns</a> / ${escapeHtml(campaign.name)}</nav>
    <h1>${escapeHtml(campaign.name)} <small><code>${escapeHtml(campaign.id)}</code></small></h1>
    ${errBanner}
    ${noticeBanner}
    <p>Status: <span class="status-tag ${escapeHtml(campaign.status === "archived" ? "open" : "accepted")}">${escapeHtml(campaign.status)}</span> · Last updated: ${escapeHtml(campaign.updatedAt)}</p>
    ${intentBlock}
    <h2>Singleton slots</h2>
    ${singletons}
    <h2>Multi slots</h2>
    ${multis}
    <h2>Recent history <small>(${state.history.length} total)</small></h2>
    ${history || `<p class="empty">No history yet — send the first turn below.</p>`}
    ${turnForm}
    <div class="controls">${archiveSection}</div>
  `;
  return htmlPage(campaign.name, body);
}
