import { AzgaarWorld } from "../../world/azgaar";
import { CanonStore, CanonEntity } from "../../canon/canon";
import { LLMClient, ToolDefinition } from "../../llm/providers";
import { ChatState } from "../director";
import { CampaignSettings } from "../schema";

export type ToolContext = {
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;  // Separate LLM for content generation (uses llm if not set)
  state: ChatState;
  campaignSettings?: CampaignSettings;
};

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<any>;

export type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(name: string, definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(name, { definition, handler });
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args, ctx);
  }
}

// Re-export tool registration functions
export { registerWorldTools } from "./world-tools";
export { registerCanonTools } from "./canon-tools";
export { registerGenerateTools } from "./generate-tools";
export { registerSessionTools } from "./session-tools";

// Create and configure a full director tool registry
export function createDirectorRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Import and register all tools
  const { registerWorldTools } = require("./world-tools");
  const { registerCanonTools } = require("./canon-tools");
  const { registerGenerateTools } = require("./generate-tools");
  const { registerSessionTools } = require("./session-tools");

  registerWorldTools(registry);
  registerCanonTools(registry);
  registerGenerateTools(registry);
  registerSessionTools(registry);

  return registry;
}

// Register the unified search tool on any registry
export function registerSearchTool(registry: ToolRegistry): void {
  const { performSearch } = require("../../browse/tui/search");

  registry.register(
    "search",
    {
      name: "search",
      description: `Unified search across the entire world. Searches states, burgs, cultures, religions AND all canon entities (NPCs, factions, locations, events, rumors, hooks, deities) in one call. Returns matching results with details and all relations (edges) for the top results. Use this as your primary lookup tool -- it replaces the need to call world_lookupBurg, world_lookupState, and canon_query separately.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term (name, partial name, or keyword)" },
          detailed: { type: "string", description: "Set to 'true' to include full details and relations for the top 3 results. Default: true." },
        },
        required: ["query"],
      },
    },
    async (args: Record<string, any>, ctx: ToolContext) => {
      const query = String(args.query || "").trim();
      if (query.length < 2) return { error: "Query must be at least 2 characters" };

      const includeDetails = args.detailed !== "false";
      const results = performSearch(query, ctx.world, ctx.canon, 10);

      if (results.length === 0) {
        return { matches: [], message: `No results found for "${query}"` };
      }

      // Build response with matches
      const matches = results.map((r: any) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        score: r.score,
        breadcrumb: r.breadcrumb,
        source: r.source,
      }));

      // For top results, fetch full details + relations
      const detailed: any[] = [];
      if (includeDetails) {
        const topResults = results.slice(0, 3);
        for (const r of topResults) {
          const [kind, rawId] = r.id.split(":");
          const detail: any = { id: r.id, name: r.name, kind: r.kind, relations: [] };

          if (r.source === "world") {
            // World entity details
            if (kind === "burg") {
              const burg = ctx.world.getBurg(Number(rawId));
              if (burg) {
                const state = typeof burg.state === "number" ? ctx.world.getState(burg.state) : undefined;
                detail.data = {
                  population: burg.population,
                  state: state?.name,
                  culture: burg.culture !== undefined ? ctx.world.getCulture(burg.culture)?.name : undefined,
                  religion: burg.religion !== undefined ? ctx.world.getReligion(burg.religion)?.name : undefined,
                  port: burg.port,
                  citadel: burg.citadel,
                  plaza: burg.plaza,
                  walls: burg.walls,
                  shanty: burg.shanty,
                  temple: burg.temple,
                };
                // Find canon entities anchored to this burg
                const anchored = ctx.canon.listEntities({ anchors: { burgId: Number(rawId) }, limit: 20 });
                detail.canonEntities = anchored.map((e: any) => ({ id: e.id, type: e.type, name: e.name, summary: e.summary }));
              }
            } else if (kind === "state") {
              const state = ctx.world.getState(Number(rawId));
              if (state) {
                detail.data = {
                  fullName: state.fullName,
                  form: state.form,
                  formName: state.formName,
                  capital: state.capital ? ctx.world.getBurg(state.capital)?.name : undefined,
                  color: state.color,
                  burgs: state.burgs,
                  area: state.area,
                  rural: state.rural,
                  urban: state.urban,
                };
                // Find canon entities anchored to this state
                const anchored = ctx.canon.listEntities({ anchors: { stateId: Number(rawId) }, limit: 20 });
                detail.canonEntities = anchored.map((e: any) => ({ id: e.id, type: e.type, name: e.name, summary: e.summary }));
              }
            } else if (kind === "culture") {
              const culture = ctx.world.getCulture(Number(rawId));
              if (culture) detail.data = culture;
            } else if (kind === "religion") {
              const religion = ctx.world.getReligion(Number(rawId));
              if (religion) {
                detail.data = religion;
                // Find deities for this religion
                const deities = ctx.canon.listEntities({ type: "deity", anchors: { azgaarReligionId: Number(rawId) }, limit: 20 });
                detail.canonEntities = deities.map((e: any) => ({ id: e.id, type: e.type, name: e.name, summary: e.summary }));
              }
            }
          } else {
            // Canon entity details
            const entity = ctx.canon.getEntity(rawId);
            if (entity) {
              detail.data = {
                type: entity.type,
                summary: entity.summary,
                details_md: entity.details_md ? entity.details_md.slice(0, 500) : null,
                tags: entity.tags,
                anchors: entity.anchors,
                payload: entity.payload,
              };
              // Fetch all relations
              const rels = ctx.canon.listRelations({ entity_id: rawId, limit: 50 });
              detail.relations = rels.map((rel: any) => {
                const isSource = rel.from_id === rawId;
                const otherId = isSource ? rel.to_id : rel.from_id;
                const other = ctx.canon.getEntity(otherId);
                return {
                  direction: isSource ? "outgoing" : "incoming",
                  relType: rel.rel_type,
                  otherEntity: other ? { id: other.id, type: other.type, name: other.name } : { id: otherId },
                  strength: rel.strength,
                  notes: rel.notes,
                };
              });
            }
          }

          detailed.push(detail);
        }
      }

      return { matches, detailed };
    }
  );
}

// Create a registry for general chat (no session tools, adds propose_plan)
export function createGeneralChatRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  const { registerWorldTools } = require("./world-tools");
  const { registerCanonTools } = require("./canon-tools");
  const { registerGenerateTools } = require("./generate-tools");

  registerWorldTools(registry);
  registerCanonTools(registry);
  registerGenerateTools(registry);
  registerSearchTool(registry);

  // propose_plan: LLM proposes a generation plan for user review
  registry.register(
    "propose_plan",
    {
      name: "propose_plan",
      description: `Propose a generation plan for the user to review and approve before execution. Use this instead of directly calling generate_* tools when the user asks to create new content. The plan will be displayed as an interactive card the user can approve or reject.

The entitiesJson parameter must be a JSON array of objects, each with: type (npc/location/faction/event/rumor/hook/deity/marker), name, reason, and optionally kind and hints.
For markers (wilderness locations), kind should be: ruin, tower, dungeon, shrine, cave, camp, monument, grove, mine, bridge, battlefield, portal, lair, oasis, lighthouse, shipwreck, or other.
Example: [{"type":"marker","name":"The Shattered Spire","reason":"Ancient wizard tower in the wilderness","kind":"tower"},{"type":"npc","name":"Kara Rill","reason":"Hermit living near the tower","kind":"hermit"}]`,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what this plan will create and why",
          },
          entitiesJson: {
            type: "string",
            description: "JSON array of entity plans. Each: {type, name, reason, kind?, hints?}",
          },
          burgId: { type: "number", description: "Target burg ID if applicable" },
          burgName: { type: "string", description: "Target burg name" },
        },
        required: ["summary", "entitiesJson"],
      },
    },
    async (args, ctx) => {
      // Parse entities from JSON string
      let entities: any[];
      try {
        entities = JSON.parse(args.entitiesJson);
        if (!Array.isArray(entities)) throw new Error("Not an array");
      } catch {
        return { error: "entitiesJson must be a valid JSON array" };
      }

      // Generate a plan ID and store on the context for extraction
      const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // Attach proposed plans to the context state for post-loop extraction
      if (!(ctx.state as any)._proposedPlans) {
        (ctx.state as any)._proposedPlans = [];
      }
      (ctx.state as any)._proposedPlans.push({
        planId,
        summary: args.summary,
        entities,
        burgId: args.burgId,
        burgName: args.burgName,
      });
      return {
        status: "proposed",
        planId,
        message: `Plan proposed with ${entities.length} entities. Waiting for user approval.`,
      };
    }
  );

  return registry;
}
