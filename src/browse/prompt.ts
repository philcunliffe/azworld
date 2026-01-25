/**
 * Context-aware prompt rendering for azbrowse CLI
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { BrowseState, currentRef, stackToPath, refToName } from "./state";

// Color codes for terminal output
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// Get prompt string based on current navigation state
export function getPrompt(state: BrowseState, world: AzgaarWorld, canon: CanonStore): string {
  const cur = currentRef(state);

  switch (cur.kind) {
    case "world":
      return `${CYAN}~${RESET} > `;

    case "state": {
      const name = refToName(cur, world, canon);
      return `${GREEN}${name}${RESET} > `;
    }

    case "burg": {
      const name = refToName(cur, world, canon);
      return `${YELLOW}${name}${RESET} > `;
    }

    case "location": {
      // Show burg / location
      const burgRef = state.stack.find(r => r.kind === "burg");
      const burgName = burgRef ? refToName(burgRef, world, canon) : "";
      const locName = refToName(cur, world, canon);
      if (burgName) {
        return `${YELLOW}${burgName}${RESET} / ${MAGENTA}${locName}${RESET} > `;
      }
      return `${MAGENTA}${locName}${RESET} > `;
    }

    case "npc": {
      // Show [NPC Name] for focused NPC
      const npcName = refToName(cur, world, canon);
      return `${BOLD}[${npcName}]${RESET} > `;
    }

    default:
      return "> ";
  }
}

// Get a simplified prompt without colors (for non-TTY or logging)
export function getPromptPlain(state: BrowseState, world: AzgaarWorld, canon: CanonStore): string {
  const cur = currentRef(state);

  switch (cur.kind) {
    case "world":
      return "~ > ";
    case "state":
    case "burg":
    case "location":
      return `${stackToPath(state, world, canon)} > `;
    case "npc": {
      const npcName = refToName(cur, world, canon);
      return `[${npcName}] > `;
    }
    default:
      return "> ";
  }
}

// Format location kind for display
export function formatKind(kind?: string): string {
  if (!kind) return "";
  return `${DIM}(${kind})${RESET}`;
}

// Format tags for display
export function formatTags(tags?: string[]): string {
  if (!tags || tags.length === 0) return "";
  return `${DIM}(${tags.join(", ")})${RESET}`;
}

// Format entity name with highlighting
export function formatEntityName(name: string, highlighted?: boolean): string {
  if (highlighted) {
    return `${BOLD}${name}${RESET}`;
  }
  return name;
}

// Pad string to fixed width
export function padRight(s: string, width: number): string {
  // Strip ANSI codes for length calculation
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - plain.length);
  return s + " ".repeat(padding);
}
