import { ToolRegistry, ToolContext } from "./index";
import { EntityType, CanonEntity } from "../../canon/canon";

const VALID_ENTITY_TYPES = ["npc", "faction", "location", "event", "rumor", "hook", "meta", "culture", "religion"] as const;

export function registerCanonTools(registry: ToolRegistry): void {
  // canon_query - Search entities by type, tags, anchor, kind
  registry.register(
    "canon_query",
    {
      name: "canon_query",
      description:
        "Search canon entities by type, tags, anchors (burgId, stateId, neighborhoodId), or text. Use this to find existing content before generating new content.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Entity type filter: npc, faction, location, event, rumor, hook, meta",
            enum: [...VALID_ENTITY_TYPES],
          },
          tag: { type: "string", description: "Filter by a specific tag (e.g., 'tavern', 'criminal')" },
          text: { type: "string", description: "Text search in name, summary, or details" },
          burgId: { type: "number", description: "Filter by burg anchor" },
          stateId: { type: "number", description: "Filter by state anchor" },
          neighborhoodId: { type: "string", description: "Filter by neighborhood anchor (location entity ID)" },
          limit: { type: "number", description: "Maximum results to return (default 20)" },
        },
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const opts: any = {};

      if (args.type && VALID_ENTITY_TYPES.includes(args.type)) {
        opts.type = args.type as EntityType;
      }
      if (args.tag) opts.tag = String(args.tag);
      if (args.text) opts.text = String(args.text);

      const anchors: Record<string, any> = {};
      if (typeof args.burgId === "number") anchors.burgId = args.burgId;
      if (typeof args.stateId === "number") anchors.stateId = args.stateId;
      if (args.neighborhoodId) anchors.neighborhoodId = String(args.neighborhoodId);
      if (Object.keys(anchors).length) opts.anchors = anchors;

      opts.limit = typeof args.limit === "number" ? Math.min(args.limit, 20) : 20;

      const results = ctx.canon.listEntities(opts);
      return {
        count: results.length,
        entities: results.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: e.summary ? e.summary.slice(0, 150) : null,
          tags: e.tags,
          // Omit payload and anchors from list view - use canon_get for full details
        })),
      };
    }
  );

  // canon_get - Get a specific entity by ID
  registry.register(
    "canon_get",
    {
      name: "canon_get",
      description: "Get a specific canon entity by its ID.",
      parameters: {
        type: "object",
        properties: {
          entityId: { type: "string", description: "The entity ID to retrieve" },
        },
        required: ["entityId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const entityId = String(args.entityId);
      const entity = ctx.canon.getEntity(entityId);
      if (!entity) return { error: `Entity ${entityId} not found` };
      // Return entity but truncate very long details_md
      return {
        ...entity,
        details_md: entity.details_md && entity.details_md.length > 500
          ? entity.details_md.slice(0, 500) + "... [truncated]"
          : entity.details_md,
      };
    }
  );

  // canon_upsert - Create or update an entity
  registry.register(
    "canon_upsert",
    {
      name: "canon_upsert",
      description:
        "Create a new canon entity or update an existing one. Use this to persist generated content. Provide entityId to update, omit to create new.",
      parameters: {
        type: "object",
        properties: {
          entityId: { type: "string", description: "Entity ID to update (omit for new entity)" },
          type: {
            type: "string",
            description: "Entity type: npc, faction, location, event, rumor, hook, meta",
            enum: [...VALID_ENTITY_TYPES],
          },
          name: { type: "string", description: "Entity name" },
          summary: { type: "string", description: "Short summary/description" },
          details_md: { type: "string", description: "Longer markdown description" },
          tags: { type: "string", description: "Comma-separated tags" },
          burgId: { type: "number", description: "Anchor to a burg" },
          stateId: { type: "number", description: "Anchor to a state" },
          neighborhoodId: { type: "string", description: "Anchor to a neighborhood" },
          payload: { type: "string", description: "JSON payload with additional structured data" },
        },
        required: ["type", "name"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const type = args.type as EntityType;
      if (!VALID_ENTITY_TYPES.includes(type)) {
        return { error: `Invalid entity type: ${args.type}` };
      }

      const name = String(args.name || "");
      if (!name) return { error: "name is required" };

      const tags = args.tags ? String(args.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [];

      const anchors: Record<string, any> = {};
      if (typeof args.burgId === "number") anchors.burgId = args.burgId;
      if (typeof args.stateId === "number") anchors.stateId = args.stateId;
      if (args.neighborhoodId) anchors.neighborhoodId = String(args.neighborhoodId);

      let payload: Record<string, any> = {};
      if (args.payload) {
        try {
          payload = JSON.parse(String(args.payload));
        } catch {
          payload = {};
        }
      }

      if (args.entityId) {
        // Update existing
        const updated = ctx.canon.patchEntity(String(args.entityId), {
          name,
          summary: args.summary || null,
          details_md: args.details_md || null,
          tags,
          anchors,
          payload,
        });
        if (!updated) return { error: `Entity ${args.entityId} not found` };
        return { updated: true, entity: updated };
      }

      // Create new
      const entity = ctx.canon.addEntity({
        type,
        name,
        summary: args.summary || null,
        details_md: args.details_md || null,
        tags,
        anchors,
        payload,
        provenance: {
          generated_by: "azchat-director",
          provider: ctx.llm.provider,
          model: ctx.llm.model,
        },
      });

      return { created: true, entity };
    }
  );

  // canon_link - Create a relation between entities
  registry.register(
    "canon_link",
    {
      name: "canon_link",
      description:
        "Create a relation between two entities. Examples: NPC works_at location, faction controls location, NPC member_of faction.",
      parameters: {
        type: "object",
        properties: {
          fromId: { type: "string", description: "Source entity ID" },
          toId: { type: "string", description: "Target entity ID" },
          relationType: {
            type: "string",
            description: "Relation type: located_at, works_at, member_of, affiliated_with, front_for, protected_by, owes, rival_of, controls, owns",
          },
          strength: { type: "number", description: "Relation strength 0-1 (optional)" },
          notes: { type: "string", description: "Notes about the relation" },
        },
        required: ["fromId", "toId", "relationType"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const fromId = String(args.fromId);
      const toId = String(args.toId);
      const relationType = String(args.relationType);

      // Check entities exist
      const fromEntity = ctx.canon.getEntity(fromId);
      const toEntity = ctx.canon.getEntity(toId);

      if (!fromEntity) return { error: `Source entity ${fromId} not found` };
      if (!toEntity) return { error: `Target entity ${toId} not found` };

      // Check for duplicate
      const existingRels = ctx.canon.listRelations({ entity_id: fromId, limit: 500 });
      const dupe = existingRels.find((r) => r.from_id === fromId && r.to_id === toId && r.rel_type === relationType);
      if (dupe) {
        return { exists: true, relation: dupe, message: "Relation already exists" };
      }

      const relation = ctx.canon.addRelation({
        from_id: fromId,
        to_id: toId,
        rel_type: relationType,
        strength: typeof args.strength === "number" ? args.strength : null,
        notes: args.notes || null,
      });

      return { created: true, relation };
    }
  );

  // canon_unlink - Remove a relation
  registry.register(
    "canon_unlink",
    {
      name: "canon_unlink",
      description: "Remove a relation between two entities.",
      parameters: {
        type: "object",
        properties: {
          fromId: { type: "string", description: "Source entity ID" },
          toId: { type: "string", description: "Target entity ID" },
          relationType: { type: "string", description: "Relation type to remove" },
        },
        required: ["fromId", "toId", "relationType"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const fromId = String(args.fromId);
      const toId = String(args.toId);
      const relationType = String(args.relationType);

      // Find and delete the relation
      const existingRels = ctx.canon.listRelations({ entity_id: fromId, limit: 500 });
      const rel = existingRels.find((r) => r.from_id === fromId && r.to_id === toId && r.rel_type === relationType);

      if (!rel) {
        return { error: "Relation not found" };
      }

      // Delete via raw SQL (no dedicated method in CanonStore)
      ctx.canon.db.prepare("DELETE FROM relations WHERE id = ?").run(rel.id);

      return { deleted: true, relationId: rel.id };
    }
  );

  // canon_getActiveEvents - Get events affecting a location
  registry.register(
    "canon_getActiveEvents",
    {
      name: "canon_getActiveEvents",
      description:
        "Get active events affecting a location. Queries upward through scopes: neighborhood → burg → state → region → world.",
      parameters: {
        type: "object",
        properties: {
          burgId: { type: "number", description: "Burg to get events for" },
          stateId: { type: "number", description: "State to get events for" },
          neighborhoodId: { type: "string", description: "Neighborhood to get events for" },
          includeParentScopes: {
            type: "string",
            description: "Include events from parent scopes (true/false, default true)",
            enum: ["true", "false"],
          },
          recencyDays: { type: "number", description: "Only include events from last N days (default 90)" },
        },
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const burgId = typeof args.burgId === "number" ? args.burgId : undefined;
      const stateId = typeof args.stateId === "number" ? args.stateId : undefined;
      const neighborhoodId = args.neighborhoodId ? String(args.neighborhoodId) : undefined;
      const includeParentScopes = args.includeParentScopes !== "false";
      const recencyDays = typeof args.recencyDays === "number" ? args.recencyDays : 90;

      // Get all events
      const allEvents = ctx.canon.listEntities({ type: "event", limit: 500 });

      // Get state from burg if needed
      let inferredStateId = stateId;
      if (!inferredStateId && burgId) {
        const burg = ctx.world.getBurg(burgId);
        if (burg && typeof burg.state === "number") {
          inferredStateId = burg.state;
        }
      }

      const matchingEvents: CanonEntity[] = [];

      for (const event of allEvents) {
        const payload = event.payload || {};
        const scope = payload.scope || "burg";
        const daysAgo = typeof payload.daysAgo === "number" ? payload.daysAgo : 0;

        // Filter by recency
        if (daysAgo > recencyDays) continue;

        // Check scope matching
        let matches = false;

        if (scope === "world") {
          matches = true;
        } else if (scope === "region" && includeParentScopes) {
          // Region events always match if includeParentScopes
          matches = true;
        } else if (scope === "state") {
          const eventStateId = event.anchors?.stateId;
          if (eventStateId && eventStateId === inferredStateId) {
            matches = true;
          } else if (!eventStateId && includeParentScopes) {
            // State-scope event without specific anchor matches broadly
            matches = true;
          }
        } else if (scope === "burg") {
          const eventBurgId = event.anchors?.burgId;
          if (eventBurgId && eventBurgId === burgId) {
            matches = true;
          }
        } else if (scope === "neighborhood") {
          const eventNeighborhoodId = event.anchors?.neighborhoodId;
          if (eventNeighborhoodId && eventNeighborhoodId === neighborhoodId) {
            matches = true;
          }
        }

        if (matches) {
          matchingEvents.push(event);
        }
      }

      // Sort by daysAgo ascending (most recent first)
      matchingEvents.sort((a, b) => {
        const aDays = (a.payload?.daysAgo as number) ?? 0;
        const bDays = (b.payload?.daysAgo as number) ?? 0;
        return aDays - bDays;
      });

      // Limit to 10 most relevant events to reduce token usage
      const limitedEvents = matchingEvents.slice(0, 10);

      return {
        count: matchingEvents.length,
        showing: limitedEvents.length,
        events: limitedEvents.map((e) => ({
          id: e.id,
          name: e.name,
          summary: e.summary ? e.summary.slice(0, 100) : null,  // Truncate summaries
          scope: e.payload?.scope,
          severity: e.payload?.severity,
          daysAgo: e.payload?.daysAgo,
          ongoing: e.payload?.ongoing,
          // Omit full consequences - use canon_get for details
        })),
      };
    }
  );
}
