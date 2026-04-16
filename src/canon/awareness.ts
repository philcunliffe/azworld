import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity, AwarenessLevel } from "./canon";

export type PropagationOptions = {
  event: CanonEntity;
  world: AzgaarWorld;
  canon: CanonStore;
  currentDay: number;
};

/**
 * Propagate awareness of an event based on scope, distance, and time.
 * This simulates how news travels in a fantasy world.
 */
export function propagateAwareness(opts: PropagationOptions): void {
  const { event, world, canon, currentDay } = opts;
  const payload = event.payload || {};

  const scope = (payload.scope as string) || "burg";
  const severity = (payload.severity as string) || "moderate";
  const secrecy = (payload.secrecy as string) || "public";
  const audience = (payload.audience as Record<string, any> | undefined) || {};
  const daysAgo = typeof payload.daysAgo === "number" ? payload.daysAgo : 0;
  const daysSinceEvent = daysAgo;

  // Get event anchor
  const eventBurgId = event.anchors?.burgId;
  const eventStateId = event.anchors?.stateId;

  // Severity affects speed of propagation
  const severityMultiplier = {
    minor: 0.5,
    moderate: 1.0,
    major: 1.5,
    catastrophic: 2.0,
  }[severity] || 1.0;

  const secrecyMultiplier = {
    secret: 0.2,
    restricted: 0.5,
    rumored: 0.85,
    public: 1.2,
  }[secrecy] || 1.0;

  const publicKnowledge = secrecy === "public" || audience.public === true;

  // Source location has intimate knowledge immediately
  if (eventBurgId) {
    canon.setAwareness({
      actorType: "burg",
      actorId: String(eventBurgId),
      eventId: event.id,
      level: "intimate",
    });
  }
  if (eventStateId) {
    canon.setAwareness({
      actorType: "state",
      actorId: String(eventStateId),
      eventId: event.id,
      level: scope === "state" || scope === "region" || scope === "world" ? "intimate" : "confirmed",
    });
  }

  seedAudienceAwareness(event, canon, audience);

  if (!publicKnowledge) {
    return;
  }

  // Propagate to other burgs based on scope and time
  const allBurgs = world.listBurgs();
  const sourceBurg = eventBurgId ? world.getBurg(eventBurgId) : undefined;

  for (const burg of allBurgs) {
    if (burg.id === eventBurgId) continue;

    let level: AwarenessLevel = "unknown";
    const isSameState = eventStateId && burg.state === eventStateId;
    const isCapital = burg.capital === 1;
    const isPort = burg.port === 1;

    // Calculate effective distance (simplified)
    let distance = Infinity;
    if (sourceBurg) {
      const dx = (burg.x ?? 0) - (sourceBurg.x ?? 0);
      const dy = (burg.y ?? 0) - (sourceBurg.y ?? 0);
      distance = Math.sqrt(dx * dx + dy * dy);
    }

    // Determine awareness level based on scope and propagation rules
    if (scope === "world") {
      // World events: confirmed everywhere after a few days
      if (daysSinceEvent >= 3 / (severityMultiplier * secrecyMultiplier)) {
        level = "confirmed";
      } else if (daysSinceEvent >= 1) {
        level = "rumor";
      }
    } else if (scope === "region") {
      // Region events: confirmed in same state, rumor elsewhere
      if (isSameState && daysSinceEvent >= 2 / (severityMultiplier * secrecyMultiplier)) {
        level = "confirmed";
      } else if (daysSinceEvent >= 5 / (severityMultiplier * secrecyMultiplier)) {
        level = "rumor";
      }
    } else if (scope === "state") {
      // State events: confirmed in same state after time, rumor in neighboring
      if (isSameState) {
        if (daysSinceEvent >= 1 / (severityMultiplier * secrecyMultiplier)) {
          level = isCapital || isPort ? "confirmed" : "rumor";
        }
        if (daysSinceEvent >= 3 / (severityMultiplier * secrecyMultiplier)) {
          level = "confirmed";
        }
      } else if (daysSinceEvent >= 7 / (severityMultiplier * secrecyMultiplier)) {
        level = isPort ? "rumor" : "unknown";
      }
    } else if (scope === "burg") {
      // Burg events: local stays local unless severe
      if (isSameState) {
        // Same state hears rumors quickly
        if (daysSinceEvent >= 3 / (severityMultiplier * secrecyMultiplier) && distance < 200) {
          level = "rumor";
        }
        if (daysSinceEvent >= 7 / (severityMultiplier * secrecyMultiplier)) {
          level = isCapital ? "rumor" : "unknown";
        }
      }
      // Very severe burg events spread further
      if (severity === "catastrophic" && daysSinceEvent >= 10) {
        level = "rumor";
      }
    }
    // Neighborhood events stay even more local (handled separately)

    if (level !== "unknown") {
      canon.setAwareness({
        actorType: "burg",
        actorId: String(burg.id),
        eventId: event.id,
        level,
      });
    }
  }

  // Propagate to factions in affected areas
  const factions = canon.listEntities({ type: "faction", limit: 500 });
  for (const faction of factions) {
    const factionBurgId = faction.anchors?.burgId;
    if (!factionBurgId) continue;

    const burgAwareness = canon.getAwareness({
      actorType: "burg",
      actorId: String(factionBurgId),
      eventId: event.id,
    });

    if (burgAwareness.length && burgAwareness[0].level !== "unknown") {
      // Factions know what their city knows
      canon.setAwareness({
        actorType: "faction",
        actorId: faction.id,
        eventId: event.id,
        level: burgAwareness[0].level,
      });
    }
  }
}

/**
 * Initialize awareness for a newly created event.
 * Sets immediate awareness for the source location.
 */
export function initializeEventAwareness(opts: {
  event: CanonEntity;
  canon: CanonStore;
}): void {
  const { event, canon } = opts;

  // Source has intimate knowledge
  const eventBurgId = event.anchors?.burgId;
  const eventStateId = event.anchors?.stateId;
  const secrecy = (event.payload?.secrecy as string) || "public";
  const audience = (event.payload?.audience as Record<string, any> | undefined) || {};

  if (eventBurgId) {
    canon.setAwareness({
      actorType: "burg",
      actorId: String(eventBurgId),
      eventId: event.id,
      level: "intimate",
    });
  }

  if (eventStateId) {
    canon.setAwareness({
      actorType: "state",
      actorId: String(eventStateId),
      eventId: event.id,
      level: secrecy === "secret" ? "rumor" : "confirmed",
    });
  }

  seedAudienceAwareness(event, canon, audience);
}

/**
 * Get what an NPC would know based on their location's awareness.
 */
export function getNpcAwareness(opts: {
  npcId: string;
  eventId: string;
  canon: CanonStore;
}): AwarenessLevel {
  const { npcId, eventId, canon } = opts;

  // Check if NPC has direct awareness
  const directAwareness = canon.getAwareness({
    actorType: "npc",
    actorId: npcId,
    eventId,
  });

  if (directAwareness.length) {
    return directAwareness[0].level;
  }

  // Fall back to NPC's burg awareness
  const npc = canon.getEntity(npcId);
  if (!npc) return "unknown";

  const burgId = npc.anchors?.burgId;
  if (!burgId) return "unknown";

  const burgAwareness = canon.getAwareness({
    actorType: "burg",
    actorId: String(burgId),
    eventId,
  });

  return burgAwareness.length ? burgAwareness[0].level : "unknown";
}

function seedAudienceAwareness(
  event: CanonEntity,
  canon: CanonStore,
  audience: Record<string, any>
): void {
  const eventId = event.id;
  const intimateFactionIds = toStringArray(audience.knownFactionIds);
  const intimateNpcIds = toStringArray(audience.knownNpcIds);
  const intimateBurgIds = toStringArray(audience.knownBurgIds);
  const intimateStateIds = toStringArray(audience.knownStateIds);
  const rumoredFactionIds = toStringArray(audience.suspectedByFactionIds);

  for (const id of intimateFactionIds) {
    canon.setAwareness({ actorType: "faction", actorId: id, eventId, level: "intimate" });
  }
  for (const id of intimateNpcIds) {
    canon.setAwareness({ actorType: "npc", actorId: id, eventId, level: "intimate" });
  }
  for (const id of intimateBurgIds) {
    canon.setAwareness({ actorType: "burg", actorId: id, eventId, level: "intimate" });
  }
  for (const id of intimateStateIds) {
    canon.setAwareness({ actorType: "state", actorId: id, eventId, level: "intimate" });
  }
  for (const id of rumoredFactionIds) {
    canon.setAwareness({ actorType: "faction", actorId: id, eventId, level: "rumor" });
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
