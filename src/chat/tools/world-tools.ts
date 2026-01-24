import { ToolRegistry, ToolContext } from "./index";

export function registerWorldTools(registry: ToolRegistry): void {
  // world_lookupBurg - Fuzzy search for cities by name
  registry.register(
    "world_lookupBurg",
    {
      name: "world_lookupBurg",
      description: "Fuzzy search for a city (burg) by name. Returns matching cities with their IDs and basic info.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The city name or partial name to search for" },
        },
        required: ["query"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const query = String(args.query || "");
      if (!query) return { error: "query is required" };

      const burgId = ctx.world.resolveBurgId(query);
      if (burgId === undefined) {
        // Try search as fallback
        const results = ctx.world.search(query, ["burgs"], 5);
        if (results.length) {
          return {
            found: false,
            suggestions: results.map((r) => ({
              burgId: r.id,
              name: r.name,
              score: r.score,
            })),
          };
        }
        return { found: false, message: `No burg matching '${query}' found` };
      }

      const burg = ctx.world.getBurg(burgId);
      return {
        found: true,
        burgId,
        name: burg?.name,
        population: burg?.population ?? burg?.pop,
        stateId: burg?.state,
        capital: burg?.capital,
        port: burg?.port,
      };
    }
  );

  // world_lookupState - Fuzzy search for states/countries
  registry.register(
    "world_lookupState",
    {
      name: "world_lookupState",
      description: "Fuzzy search for a state/country by name. Returns matching states with their IDs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The state name or partial name to search for" },
        },
        required: ["query"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const query = String(args.query || "");
      if (!query) return { error: "query is required" };

      const stateId = ctx.world.resolveStateId(query);
      if (stateId === undefined) {
        const results = ctx.world.search(query, ["states"], 5);
        if (results.length) {
          return {
            found: false,
            suggestions: results.map((r) => ({
              stateId: r.id,
              name: r.name,
              score: r.score,
            })),
          };
        }
        return { found: false, message: `No state matching '${query}' found` };
      }

      const state = ctx.world.getState(stateId);
      return {
        found: true,
        stateId,
        name: state?.name,
        form: state?.formName ?? state?.form,
        capital: state?.capital,
      };
    }
  );

  // world_getBurgDetails - Get full burg data
  registry.register(
    "world_getBurgDetails",
    {
      name: "world_getBurgDetails",
      description: "Get detailed information about a city (burg) including population, culture, religion, trade characteristics.",
      parameters: {
        type: "object",
        properties: {
          burgId: { type: "number", description: "The numeric ID of the burg" },
        },
        required: ["burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const burgId = Number(args.burgId);
      if (!Number.isFinite(burgId)) return { error: "burgId must be a number" };

      const burg = ctx.world.getBurg(burgId);
      if (!burg) return { error: `Burg ${burgId} not found` };

      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;

      return {
        burgId: burg.id,
        name: burg.name,
        population: burg.population ?? burg.pop,
        state: state ? { stateId: state.id, name: state.name, form: state.formName ?? state.form } : null,
        cultureId: burg.culture,
        religionId: burg.religion,
        x: burg.x,
        y: burg.y,
        capital: burg.capital,
        port: burg.port,
        citadel: burg.citadel,
        walls: burg.walls,
        shanty: burg.shanty,
        temple: burg.temple,
      };
    }
  );

  // world_getStateDetails - Get full state data
  registry.register(
    "world_getStateDetails",
    {
      name: "world_getStateDetails",
      description: "Get detailed information about a state/country including ruler type, neighbors, military characteristics.",
      parameters: {
        type: "object",
        properties: {
          stateId: { type: "number", description: "The numeric ID of the state" },
        },
        required: ["stateId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const stateId = Number(args.stateId);
      if (!Number.isFinite(stateId)) return { error: "stateId must be a number" };

      const state = ctx.world.getState(stateId);
      if (!state) return { error: `State ${stateId} not found` };

      // Find capital burg
      const burgs = ctx.world.listBurgs().filter((b) => b.state === stateId);
      const capital = burgs.find((b) => b.capital);

      return {
        stateId: state.id,
        name: state.name,
        form: state.formName ?? state.form,
        color: state.color,
        capital: capital ? { burgId: capital.id, name: capital.name } : null,
        burgCount: burgs.length,
        neighbors: state.neighbors,
        military: state.military,
        alert: state.alert,
        diplomacy: state.diplomacy,
      };
    }
  );

  // world_getRegion - Get geographic context around a burg
  registry.register(
    "world_getRegion",
    {
      name: "world_getRegion",
      description: "Get geographic context around a city: nearby burgs, terrain, and regional info.",
      parameters: {
        type: "object",
        properties: {
          burgId: { type: "number", description: "The numeric ID of the burg to get regional context for" },
          radius: { type: "number", description: "Number of nearby burgs to include (default 5)" },
        },
        required: ["burgId"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const burgId = Number(args.burgId);
      if (!Number.isFinite(burgId)) return { error: "burgId must be a number" };

      const burg = ctx.world.getBurg(burgId);
      if (!burg) return { error: `Burg ${burgId} not found` };

      const radius = Number(args.radius) || 5;
      const allBurgs = ctx.world.listBurgs();

      // Calculate distances and find nearby burgs
      const withDistance = allBurgs
        .filter((b) => b.id !== burgId)
        .map((b) => {
          const dx = (b.x ?? 0) - (burg.x ?? 0);
          const dy = (b.y ?? 0) - (burg.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy);
          return { ...b, distance: dist };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, radius);

      const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;

      return {
        center: { burgId: burg.id, name: burg.name, x: burg.x, y: burg.y },
        state: state ? { stateId: state.id, name: state.name } : null,
        nearbyBurgs: withDistance.map((b) => ({
          burgId: b.id,
          name: b.name,
          distance: Math.round(b.distance),
          population: b.population ?? b.pop,
          sameState: b.state === burg.state,
        })),
      };
    }
  );
}
