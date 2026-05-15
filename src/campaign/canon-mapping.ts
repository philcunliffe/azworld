import type { SlotKind, MultiSlotKind } from "./types";

export type AnySlotKind = SlotKind | MultiSlotKind;

// Maps a campaign-builder slot kind to the canon entity `type` string.
// NOTE: `region` and `lore` are slot names that do not yet exist as canon
// `EntityType` values (see `src/canon/canon.ts`). Production integration
// (az-CHT / az-WEB) will need to extend the canon entity-type CHECK
// constraint or remap these slots. Callers cast the value to `EntityType`.
export const SLOT_TO_ENTITY_TYPE: Record<AnySlotKind, string> = {
  region: "region",
  location: "location",
  event: "event",
  faction: "faction",
  npcs: "npc",
  lore: "lore",
  hooks: "hook",
};

const ANCHOR_RELATIONS: Record<string, string> = {
  "location:region": "in_region",
  "event:region": "in_region",
  "faction:region": "in_region",
  "npcs:region": "in_region",
  "npcs:location": "occupies",
  "lore:region": "anchored_in_region",
  "lore:location": "anchored_in_location",
  "hooks:region": "anchored_in_region",
  "hooks:location": "anchored_in_location",
};

export function anchorRelationFor(slot: AnySlotKind, parentSlot: SlotKind): string | null {
  return ANCHOR_RELATIONS[`${slot}:${parentSlot}`] ?? null;
}

const MULTI_SLOTS: ReadonlySet<string> = new Set(["npcs", "lore", "hooks"]);

export function isMultiSlot(slot: AnySlotKind): slot is MultiSlotKind {
  return MULTI_SLOTS.has(slot);
}
