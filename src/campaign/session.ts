import {
  type Campaign,
  type CampaignState,
  type Candidate,
  CampaignStateError,
  type HistoryEntry,
  type MultiSlotEntry,
  type MultiSlotKind,
  type Slot,
  type SlotKind,
} from "./types";
import {
  type CampaignStore,
  type CreateCampaignInput,
} from "./store";

function cloneState(state: CampaignState): CampaignState {
  return JSON.parse(JSON.stringify(state)) as CampaignState;
}

function cloneCampaign(campaign: Campaign): Campaign {
  return {
    ...campaign,
    state: cloneState(campaign.state),
  };
}

export class CampaignSession {
  readonly id: string;
  private store: CampaignStore;
  private campaign: Campaign;
  private dirty: boolean;

  private constructor(store: CampaignStore, campaign: Campaign) {
    this.store = store;
    this.campaign = campaign;
    this.id = campaign.id;
    this.dirty = false;
  }

  static create(store: CampaignStore, input: CreateCampaignInput): CampaignSession {
    const campaign = store.createCampaign(input);
    return new CampaignSession(store, campaign);
  }

  static load(store: CampaignStore, id: string): CampaignSession {
    const campaign = store.getCampaign(id);
    if (!campaign) {
      throw new Error(`campaign not found: ${id}`);
    }
    return new CampaignSession(store, campaign);
  }

  getState(): Readonly<CampaignState> {
    return this.campaign.state;
  }

  getCampaign(): Readonly<Campaign> {
    return this.campaign;
  }

  setSlotProposed(slotKind: SlotKind, candidates: Candidate[]): void {
    const slot = this.campaign.state.slots[slotKind];
    if (slot.status !== "open" && slot.status !== "proposed") {
      throw new CampaignStateError(
        `cannot propose slot ${slotKind}: current status ${slot.status}`
      );
    }
    const next: Slot = {
      status: "proposed",
      candidates: candidates.map((c) => ({ ...c })),
    };
    if (slot.notes !== undefined) next.notes = slot.notes;
    this.campaign.state.slots[slotKind] = next;
    this.markDirty();
  }

  acceptSlot(slotKind: SlotKind, candidateId: string, entityId?: string): void {
    const slot = this.campaign.state.slots[slotKind];
    if (slot.status !== "proposed") {
      throw new CampaignStateError(
        `cannot accept slot ${slotKind}: current status ${slot.status}`
      );
    }
    const candidates = slot.candidates ?? [];
    const found = candidates.find((c) => c.id === candidateId);
    if (!found) {
      throw new CampaignStateError(
        `cannot accept slot ${slotKind}: candidate ${candidateId} not found`
      );
    }
    const next: Slot = {
      status: "accepted",
      acceptedCandidateId: candidateId,
    };
    if (entityId !== undefined) next.entityId = entityId;
    if (slot.notes !== undefined) next.notes = slot.notes;
    this.campaign.state.slots[slotKind] = next;
    this.markDirty();
  }

  setSlotNotes(slotKind: SlotKind, notes: string): void {
    const slot = this.campaign.state.slots[slotKind];
    this.campaign.state.slots[slotKind] = { ...slot, notes };
    this.markDirty();
  }

  resetSlot(slotKind: SlotKind): void {
    this.campaign.state.slots[slotKind] = { status: "open" };
    this.markDirty();
  }

  addMultiEntry(slotKind: MultiSlotKind, entry: MultiSlotEntry): void {
    this.campaign.state.multi[slotKind].entries.push({ ...entry });
    this.markDirty();
  }

  removeMultiEntry(slotKind: MultiSlotKind, candidateId: string): void {
    const entries = this.campaign.state.multi[slotKind].entries;
    const idx = entries.findIndex((e) => e.candidateId === candidateId);
    if (idx === -1) return;
    entries.splice(idx, 1);
    this.markDirty();
  }

  appendHistory(entry: HistoryEntry): void {
    this.campaign.state.history.push(entry);
    this.markDirty();
  }

  flush(): void {
    if (!this.dirty) return;
    const updated = this.store.updateCampaign(this.id, {
      name: this.campaign.name,
      status: this.campaign.status,
      state: cloneState(this.campaign.state),
    });
    this.campaign = cloneCampaign(updated);
    this.dirty = false;
  }

  archive(): void {
    this.campaign.status = "archived";
    this.markDirty();
    this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
  }
}
