import { ToolRegistry, ToolContext } from "./index";

export function registerSessionTools(registry: ToolRegistry): void {
  // session_setLocation - Set current scene location
  registry.register(
    "session_setLocation",
    {
      name: "session_setLocation",
      description: "Set the current scene location. Updates the chat state so subsequent actions happen at this location.",
      parameters: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "The canon entity ID of the location" },
          burgId: { type: "number", description: "The burg ID (updates current city context)" },
        },
        required: ["locationId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const locationId = String(args.locationId);

      // Validate location exists
      const location = ctx.canon.getEntity(locationId);
      if (!location) {
        return { error: `Location ${locationId} not found in canon` };
      }

      if (location.type !== "location") {
        return { error: `Entity ${locationId} is not a location (type: ${location.type})` };
      }

      // Update state
      ctx.state.currentLocationId = locationId;

      // Update burg if provided or infer from location anchors
      if (typeof args.burgId === "number") {
        ctx.state.currentBurgId = args.burgId;
      } else if (typeof location.anchors?.burgId === "number") {
        ctx.state.currentBurgId = location.anchors.burgId;
      }

      return {
        success: true,
        location: {
          id: location.id,
          name: location.name,
          summary: location.summary,
        },
        burgId: ctx.state.currentBurgId,
      };
    }
  );

  // session_enterNpcMode - Switch to NPC roleplay mode
  registry.register(
    "session_enterNpcMode",
    {
      name: "session_enterNpcMode",
      description: "Switch the chat to NPC roleplay mode for a specific character.",
      parameters: {
        type: "object",
        properties: {
          npcId: { type: "string", description: "The canon entity ID of the NPC" },
        },
        required: ["npcId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const npcId = String(args.npcId);

      const npc = ctx.canon.getEntity(npcId);
      if (!npc) {
        return { error: `NPC ${npcId} not found in canon` };
      }

      if (npc.type !== "npc") {
        return { error: `Entity ${npcId} is not an NPC (type: ${npc.type})` };
      }

      ctx.state.currentNpcId = npcId;

      return {
        success: true,
        npc: {
          id: npc.id,
          name: npc.name,
          summary: npc.summary,
        },
        message: `Now in NPC mode as ${npc.name}`,
      };
    }
  );

  // session_narrate - Output narrative text to user
  registry.register(
    "session_narrate",
    {
      name: "session_narrate",
      description:
        "Output narrative text to the user. Use this as the final tool call to deliver the scene description or story content.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The narrative text to display to the user" },
          summary: { type: "string", description: "Optional short summary for history/logs" },
        },
        required: ["text"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const text = String(args.text || "");
      const summary = args.summary ? String(args.summary) : undefined;

      // Add to director history
      if (summary) {
        ctx.state.directorHistory.push({
          role: "assistant",
          content: summary,
        });
      }

      return {
        narration: text,
        displayed: true,
      };
    }
  );

  // session_getContext - Get current session context
  registry.register(
    "session_getContext",
    {
      name: "session_getContext",
      description: "Get the current session context including location, burg, and recent history.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const result: any = {
        currentBurgId: ctx.state.currentBurgId ?? null,
        currentLocationId: ctx.state.currentLocationId ?? null,
        currentNpcId: ctx.state.currentNpcId ?? null,
      };

      if (ctx.state.currentBurgId) {
        const burg = ctx.world.getBurg(ctx.state.currentBurgId);
        if (burg) {
          result.burg = { id: burg.id, name: burg.name };
        }
      }

      if (ctx.state.currentLocationId) {
        const location = ctx.canon.getEntity(ctx.state.currentLocationId);
        if (location) {
          result.location = {
            id: location.id,
            name: location.name,
            summary: location.summary,
            tags: location.tags,
          };
        }
      }

      // Get recent history summary
      const recentHistory = ctx.state.directorHistory.slice(-6);
      result.recentHistory = recentHistory.map((h) => ({
        role: h.role,
        preview: h.content.slice(0, 100) + (h.content.length > 100 ? "..." : ""),
      }));

      return result;
    }
  );

  // session_listNpcsHere - List NPCs at current location
  registry.register(
    "session_listNpcsHere",
    {
      name: "session_listNpcsHere",
      description: "List all NPCs currently at the active location.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      if (!ctx.state.currentLocationId) {
        return { error: "No current location set", npcs: [] };
      }

      const rels = ctx.canon.listRelations({ entity_id: ctx.state.currentLocationId, limit: 200 });
      const npcIds = rels
        .filter((r) => r.rel_type === "located_at" && r.to_id === ctx.state.currentLocationId)
        .map((r) => r.from_id);

      const npcs: any[] = [];
      for (const id of npcIds) {
        const npc = ctx.canon.getEntity(id);
        if (npc && npc.type === "npc") {
          npcs.push({
            id: npc.id,
            name: npc.name,
            summary: npc.summary,
            tags: npc.tags,
          });
        }
      }

      return {
        locationId: ctx.state.currentLocationId,
        count: npcs.length,
        npcs,
      };
    }
  );
}
