/**
 * state.js - Client-side state management for the azworld web app.
 *
 * Holds all UI and server state, provides notice management,
 * snapshot syncing, hash-based navigation, and a render callback.
 */

import { api } from "./api.js";

const state = {
  snapshot: null,
  sidebarCollapsed: false,
  chatOpen: false,
  chatMode: "director",
  settingsOpen: false,
  settingsTab: "campaign",
  sideSheetOpen: false,
  searchOpen: false,
  searchQuery: "",
  searchResults: [],
  commandPaletteOpen: false,
  notices: [],
  genFormOpen: null,
  burgTab: "factions",
  mapViewActive: false,
};

let renderFn = null;

export function setRenderCallback(fn) {
  renderFn = fn;
}

function render() {
  if (renderFn) renderFn();
}

/**
 * Add a toast notice. Keeps at most 3 visible and auto-removes after 5 seconds.
 * @param {"info"|"success"|"error"|"warning"} kind
 * @param {string} message
 */
export function pushNotice(kind, message) {
  const id = crypto.randomUUID();
  state.notices = [{ id, kind, message }, ...state.notices].slice(0, 3);
  render();
  setTimeout(() => {
    state.notices = state.notices.filter((n) => n.id !== id);
    render();
  }, 5000);
}

/**
 * Replace the current snapshot with new server state and re-render.
 * @param {object} snapshot
 */
export function syncSnapshot(snapshot) {
  state.snapshot = snapshot;
  render();
}

/**
 * Navigate to a world/canon entity by ref string.
 * Fetches detail from the API, syncs the snapshot, and updates the URL hash.
 * @param {string} ref - Entity reference (e.g. "world", "burgs/12", "canon/npc/5")
 */
export async function navigate(ref) {
  try {
    const data = await api("/api/detail?ref=" + encodeURIComponent(ref));
    syncSnapshot(data.snapshot);
    window.location.hash = "#/" + ref;
  } catch (e) {
    pushNotice("error", e.message);
  }
}

/**
 * Parse the current URL hash into a ref string for navigation.
 * Returns "world" as the default route.
 * @returns {string}
 */
export function parseHashRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return hash || "world";
}

export { state };
