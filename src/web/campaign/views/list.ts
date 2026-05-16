import type { Campaign } from "../../../campaign/types";
import type { SlotKind, MultiSlotKind } from "../../../campaign/types";
import { escapeHtml, htmlPage } from "./layout";

const SINGLE_SLOTS: SlotKind[] = ["region", "location", "event", "faction"];
const MULTI_SLOTS: MultiSlotKind[] = ["npcs", "lore", "hooks"];

function slotSummary(c: Campaign): string {
  const parts: string[] = [];
  for (const k of SINGLE_SLOTS) {
    parts.push(`${k}:${c.state.slots[k].status}`);
  }
  for (const k of MULTI_SLOTS) {
    parts.push(`${k}:${c.state.multi[k].entries.length}`);
  }
  return parts.join(", ");
}

export function renderListPage(opts: { campaigns: Campaign[]; filter: "open" | "archived" | "all" }): string {
  const { campaigns, filter } = opts;

  const filterLinks = (["open", "archived", "all"] as const).map((f) => {
    const cls = f === filter ? "" : "";
    const label = f.charAt(0).toUpperCase() + f.slice(1);
    if (f === filter) return `<strong>${label}</strong>`;
    const q = f === "open" ? "" : `?status=${f}`;
    return `<a href="/campaign${q}">${label}</a>`;
  }).join(" · ");

  const rows = campaigns.length === 0
    ? `<tr><td colspan="5" class="empty">No campaigns ${filter === "all" ? "" : filter}.</td></tr>`
    : campaigns.map((c) => `
      <tr>
        <td><a href="/campaign/${escapeHtml(c.id)}">${escapeHtml(c.name)}</a></td>
        <td><span class="status-tag ${escapeHtml(c.status === "archived" ? "open" : "accepted")}">${escapeHtml(c.status)}</span></td>
        <td><code>${escapeHtml(slotSummary(c))}</code></td>
        <td>${escapeHtml(c.updatedAt)}</td>
        <td>${
          c.status === "archived"
            ? ""
            : `<form class="inline" method="post" action="/campaign/${escapeHtml(c.id)}/archive">
                  <button class="danger" type="submit">Archive</button>
                </form>`
        }</td>
      </tr>
    `).join("");

  const body = `
    <nav class="crumbs"><a href="/campaign">Campaigns</a></nav>
    <h1>Campaigns</h1>
    <p>${filterLinks}</p>
    <p><a href="/campaign/new"><button type="button">New campaign</button></a></p>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Slot summary</th>
          <th>Last updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  return htmlPage("Campaigns", body);
}
