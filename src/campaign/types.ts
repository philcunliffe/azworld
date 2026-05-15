export type SlotStatus = "open" | "proposed" | "accepted";

// Singleton slots — at most one accepted entity each.
export type SlotKind = "region" | "location" | "event" | "faction";

// Multi-instance slots — array of accepted entries.
export type MultiSlotKind = "npcs" | "lore" | "hooks";

export interface Candidate {
  id: string;          // local-to-candidates list, e.g. "c-1", "c-2", "c-3"
  name: string;
  summary: string;
  payload: unknown;    // entity-type-specific draft data; opaque at this layer
}

export interface Slot {
  status: SlotStatus;
  candidates?: Candidate[];     // present iff status === "proposed"
  acceptedCandidateId?: string;
  entityId?: string;            // canon entity id; set by az-TLS later, undefined here
  notes?: string;               // free-form steering ("more dangerous, bandits")
}

export interface MultiSlotEntry {
  candidateId: string;
  entityId?: string;
  notes?: string;
}

export interface MultiSlot {
  entries: MultiSlotEntry[];
}

export type HistoryEntry =
  | { kind: "user"; text: string; ts: string }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "tool_call"; tool: string; args: unknown; ts: string }
  | { kind: "tool_result"; tool: string; result: unknown; ts: string };

export interface CampaignState {
  slots: Record<SlotKind, Slot>;
  multi: Record<MultiSlotKind, MultiSlot>;
  history: HistoryEntry[];
}

export interface Campaign {
  id: string;           // "camp-<slug>"
  name: string;
  status: "open" | "archived";
  intentMd: string;     // user's original framing text
  state: CampaignState;
  createdAt: string;    // ISO-8601
  updatedAt: string;
}

export class CampaignStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignStateError";
  }
}

export function emptyState(): CampaignState {
  return {
    slots: {
      region:   { status: "open" },
      location: { status: "open" },
      event:    { status: "open" },
      faction:  { status: "open" },
    },
    multi: {
      npcs:  { entries: [] },
      lore:  { entries: [] },
      hooks: { entries: [] },
    },
    history: [],
  };
}
