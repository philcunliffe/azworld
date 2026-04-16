import { extname, join } from "node:path";
import { watch } from "node:fs";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, type CanonEntity, type CanonRelation, type EntityType, type ActorType, type AwarenessLevel } from "../canon/canon";
import { extractGlobals } from "../util/args";
import { loadConfig, saveConfig, getEffectiveProvider, getEffectiveModel, getEffectiveGenerationProvider, getEffectiveGenerationModel, getEffectiveTalkProvider, getEffectiveTalkModel, validateProviderSwitch, type LLMConfig } from "../llm/config";
import { createLLMClient, listModels, type LLMClient, type LLMProviderName } from "../llm/providers";
import { executeCommand, executePendingBurgGeneration, executePendingDescriptionGeneration, executePendingFieldRegeneration, executePendingGeneration, executePendingHookGeneration, executePendingModification, executePendingRumorGeneration, executePendingSimulation, planFieldRegen, type CommandContext, type CommandResult } from "../browse/commands";
import { newBrowseState, currentRef, navigateTo, setStack, stackToPath, type BrowseState, type EntityRef } from "../browse/state";
import { performSearch } from "../browse/tui/search";
import { buildTree, buildFactionsList, buildReligionsList, buildCulturesList, expandPathToNode, refToNodeId, nodeIdToRef } from "../browse/tui/tree";
import { syncNavigationFromChatState, type DescriptionPlan, type FieldRegenPlan, type GenPlan, type HookPlan, type ModPlan, type RumorPlan } from "../browse/gen-agent";
import { getCampaignSettings, saveCampaignSettings, type GenerationFlags } from "../chat/campaign-settings";
import { directScene, type SceneContext, type ChatBlock } from "../chat/director";
import { npcTurn, resolveNpcByName } from "../chat/npc";
import { generalChat } from "../chat/general";
import { parseSourceText } from "../canon/ingest";
import { exportWiki } from "../wiki/wiki";
import { formatPhasePlan, executePhasePlan, planCultureGeneration, planPantheonGeneration, planReligionGeneration, planStateGeneration, type PhasePlan, type WorldGenContext } from "../browse/world-init-gen";
import type { CampaignSettings } from "../chat/schema";

type TokenTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type TimelineItem = {
  id: string;
  time: string;
  kind: "command" | "chat" | "tool" | "system" | "export";
  title: string;
  body: string;
  status?: "ok" | "error" | "pending";
};

type PendingAction =
  | { kind: "generation"; plan: GenPlan; formattedPlan: string }
  | { kind: "modification"; plan: ModPlan; formattedPlan: string }
  | { kind: "simulation"; plan: import("../browse/sim-agent").SimulationPlan; formattedPlan: string }
  | { kind: "fieldSelection"; entityId: string; entityType: string; entityName: string; coreFields: string[]; payloadFields: string[]; hint: string }
  | { kind: "fieldRegeneration"; plan: FieldRegenPlan; formattedPlan: string }
  | { kind: "description"; plan: DescriptionPlan; formattedPlan: string }
  | { kind: "rumor"; plan: RumorPlan; formattedPlan: string }
  | { kind: "hook"; plan: HookPlan; formattedPlan: string }
  | { kind: "burg"; plan: GenPlan; formattedPlan: string }
  | { kind: "worldgen"; plan: PhasePlan; formattedPlan: string; queue: WorldGenQueue };

type WorldGenQueue = {
  flags: GenerationFlags;
  stateFilter?: number[];
};

type BrowseCommandResponse = {
  output?: string;
  error?: string;
  openPanel?: "settings" | "chat";
  message?: { title: string; content: string };
  pending?: ReturnType<WebSession["serializePending"]>;
};

type CanonEntityInput = {
  id?: string;
  type: EntityType;
  name: string;
  summary?: string | null;
  details_md?: string | null;
  tags?: string[];
  anchors?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 4310;
const STATIC_ROOT = join(import.meta.dir, "public");
const CANON_TYPE_ORDER: EntityType[] = [
  "location",
  "npc",
  "faction",
  "event",
  "rumor",
  "hook",
  "culture",
  "religion",
  "deity",
  "marker",
  "era",
  "phenomena",
  "relation_type",
  "source_text",
  "meta",
];

function nowId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function addTokens(totals: TokenTotals, usage?: Partial<TokenTotals>): void {
  if (!usage) return;
  totals.promptTokens += usage.promptTokens ?? 0;
  totals.completionTokens += usage.completionTokens ?? 0;
  totals.totalTokens += usage.totalTokens ?? 0;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseRef(raw: any): EntityRef {
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") {
    return { kind: "world" };
  }
  switch (raw.kind) {
    case "world":
      return { kind: "world" };
    case "state":
      return { kind: "state", stateId: Number(raw.stateId) };
    case "burg":
      return { kind: "burg", burgId: Number(raw.burgId) };
    case "location":
      return { kind: "location", locationId: String(raw.locationId) };
    case "npc":
      return { kind: "npc", npcId: String(raw.npcId) };
    case "faction":
      return { kind: "faction", factionId: String(raw.factionId) };
    case "culture":
      return { kind: "culture", cultureId: Number(raw.cultureId) };
    case "religion":
      return { kind: "religion", religionId: Number(raw.religionId) };
    case "event":
      return { kind: "event", eventId: String(raw.eventId) };
    case "rumor":
      return { kind: "rumor", rumorId: String(raw.rumorId) };
    case "hook":
      return { kind: "hook", hookId: String(raw.hookId) };
    case "deity":
      return { kind: "deity", deityId: String(raw.deityId) };
    case "marker":
      return { kind: "marker", markerId: String(raw.markerId) };
    default:
      return { kind: "world" };
  }
}

function resolvePathRef(path: string): EntityRef {
  const trimmed = path.trim();
  if (!trimmed) return { kind: "world" };
  if (trimmed === "world") return { kind: "world" };
  return nodeIdToRef(trimmed);
}

function mimeType(pathname: string): string {
  switch (extname(pathname)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

class WebSession {
  readonly worldPath: string;
  readonly canonPath: string;
  readonly world: AzgaarWorld;
  readonly canon: CanonStore;
  browseState: BrowseState;
  config: LLMConfig;
  llm: LLMClient;
  generationLlm?: LLMClient;
  talkLlm?: LLMClient;
  campaignSettings?: CampaignSettings;
  browseTalkMode = false;
  talkScene?: SceneContext;
  pending: PendingAction | null = null;
  tokens: TokenTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  timeline: TimelineItem[] = [];
  generalChatPlans: Map<string, { entities: any[]; summary: string; burgId?: number; burgName?: string }> = new Map();
  fullMapCache: any = null;

  private constructor(opts: {
    worldPath: string;
    canonPath: string;
    world: AzgaarWorld;
    canon: CanonStore;
    config: LLMConfig;
    llm: LLMClient;
    generationLlm?: LLMClient;
    talkLlm?: LLMClient;
  }) {
    this.worldPath = opts.worldPath;
    this.canonPath = opts.canonPath;
    this.world = opts.world;
    this.canon = opts.canon;
    this.browseState = newBrowseState();
    this.config = opts.config;
    this.llm = opts.llm;
    this.generationLlm = opts.generationLlm;
    this.talkLlm = opts.talkLlm;
    this.campaignSettings = getCampaignSettings(this.canon);
    this.pushTimeline("system", "Session Ready", `World: ${this.worldPath}\nCanon: ${this.canonPath}`, "ok");
  }

  static async create(worldPath: string, canonPath: string): Promise<WebSession> {
    const world = await AzgaarWorld.load(worldPath);
    const canon = new CanonStore(canonPath);
    canon.initDb();
    const config = await loadConfig();
    const provider = getEffectiveProvider(config);
    const model = getEffectiveModel(config, provider);
    const llm = createLLMClient({ provider, model });

    const genProvider = getEffectiveGenerationProvider(config);
    const generationLlm = genProvider
      ? createLLMClient({ provider: genProvider, model: getEffectiveGenerationModel(config, genProvider) })
      : undefined;

    const talkProvider = getEffectiveTalkProvider(config);
    const talkLlm = talkProvider
      ? createLLMClient({ provider: talkProvider, model: getEffectiveTalkModel(config, talkProvider) })
      : undefined;

    return new WebSession({
      worldPath,
      canonPath,
      world,
      canon,
      config,
      llm,
      generationLlm,
      talkLlm,
    });
  }

  close(): void {
    this.canon.close();
  }

  private pushTimeline(kind: TimelineItem["kind"], title: string, body: string, status?: TimelineItem["status"]): void {
    this.timeline.unshift({
      id: nowId("timeline"),
      time: new Date().toISOString(),
      kind,
      title,
      body,
      status,
    });
    this.timeline = this.timeline.slice(0, 60);
  }

  private buildCommandContext(): CommandContext {
    return {
      state: this.browseState,
      world: this.world,
      canon: this.canon,
      llm: this.llm,
      generationLlm: this.generationLlm,
      talkLlm: this.talkLlm,
      campaignSettings: this.campaignSettings,
      tuiMode: true,
      useColors: false,
      onToolCall: (name, args) => {
        this.pushTimeline("tool", `Tool: ${name}`, JSON.stringify(args, null, 2), "pending");
      },
      onToolResult: (name, result, elapsedMs) => {
        this.pushTimeline("tool", `Tool Result: ${name}`, `${JSON.stringify(result, null, 2)}\n\n${elapsedMs}ms`, "ok");
      },
      onTokens: (usage) => addTokens(this.tokens, usage),
      getTokens: () => ({ ...this.tokens }),
      onConfigChange: (config) => {
        this.config = config;
      },
      onLlmChange: (llm) => {
        this.llm = llm;
      },
      onGenerationLlmChange: (llm) => {
        this.generationLlm = llm;
      },
      onTalkLlmChange: (llm) => {
        this.talkLlm = llm;
      },
    };
  }

  private buildTalkScene(): SceneContext | undefined {
    const state = this.browseState;
    let burgId: number | undefined;
    for (let i = state.stack.length - 1; i >= 0; i--) {
      const ref = state.stack[i];
      if (ref.kind === "burg") {
        burgId = ref.burgId;
        break;
      }
      if (ref.kind === "location") {
        const location = this.canon.getEntity(ref.locationId);
        const anchoredBurg = location?.anchors?.burgId;
        if (typeof anchoredBurg === "number") {
          burgId = anchoredBurg;
          break;
        }
      }
    }

    if (burgId === undefined) return undefined;
    const burg = this.world.getBurg(burgId);
    if (!burg) return undefined;

    const locationId = this.browseState.chatState.currentLocationId;
    const location = locationId ? this.canon.getEntity(locationId) : undefined;
    let npcs: CanonEntity[] = [];

    if (location) {
      const rels = this.canon.listRelations({ entity_id: location.id, limit: 200 });
      const npcIds = rels
        .filter((relation) => relation.rel_type === "located_at" && relation.to_id === location.id)
        .map((relation) => relation.from_id);
      npcs = npcIds
        .map((id) => this.canon.getEntity(id))
        .filter((entity): entity is CanonEntity => !!entity && entity.type === "npc");
    }

    const factions = this.canon.listEntities({
      type: "faction",
      anchors: { burgId },
      limit: 20,
    });

    return {
      burgId,
      burg,
      state: typeof burg.state === "number" ? this.world.getState(burg.state) : undefined,
      location: location?.type === "location" ? location : undefined,
      npcs,
      factions,
    };
  }

  private resolveCurrentDetail(): any {
    return this.resolveDetail(currentRef(this.browseState));
  }

  private resolveDetail(ref: EntityRef): any {
    const detailBase = {
      ref,
      nodeId: refToNodeId(ref),
      path: stackToPath({ ...this.browseState, stack: this.buildPathStack(ref) }, this.world, this.canon),
    };

    switch (ref.kind) {
      case "world":
        return {
          ...detailBase,
          kind: "world",
          title: "World",
          raw: this.world.counts(),
          sections: {
            states: this.world.listStates().slice(0, 50),
            cultures: this.world.listCultures().slice(0, 50),
            religions: this.world.listReligions().slice(0, 50),
          },
        };
      case "state": {
        const state = this.world.getState(ref.stateId);
        return {
          ...detailBase,
          kind: "state",
          title: state?.name ?? `State ${ref.stateId}`,
          raw: state,
          sections: {
            burgs: this.world.listBurgs().filter((burg) => burg.state === ref.stateId).slice(0, 80),
            locations: this.canon.listEntities({ type: "location", anchors: { stateId: ref.stateId }, limit: 200 }),
            npcs: this.canon.listEntities({ type: "npc", anchors: { stateId: ref.stateId }, limit: 200 }),
            events: this.canon.getActiveEvents({ stateId: ref.stateId, recencyDays: 365 }),
          },
        };
      }
      case "burg": {
        const burg = this.world.getBurg(ref.burgId);
        const burgCell = typeof burg?.cell === "number" ? this.world.getCell(burg.cell) : undefined;
        return {
          ...detailBase,
          kind: "burg",
          title: burg?.name ?? `Burg ${ref.burgId}`,
          raw: burg,
          mapMeta: {
            seed: this.world.root?.info?.seed,
            populationRate: this.world.root?.settings?.populationRate ?? 1000,
            urbanization: this.world.root?.settings?.urbanization ?? 1,
            urbanDensity: this.world.root?.settings?.urbanDensity ?? 10,
            cellRiver: burgCell?.riverId ?? 0,
            cellBiome: burgCell?.biomeId ?? 0,
            cellHaven: typeof burg?.cell === "number" ? (this.world.pack?.cells?.[String(burg.cell)]?.haven ?? 0) : 0,
          },
          sections: {
            locations: this.canon.listEntities({ type: "location", anchors: { burgId: ref.burgId }, limit: 200 }),
            npcs: this.canon.listEntities({ type: "npc", anchors: { burgId: ref.burgId }, limit: 200 }),
            factions: this.canon.listEntities({ type: "faction", anchors: { burgId: ref.burgId }, limit: 100 }),
            events: this.canon.getActiveEvents({ burgId: ref.burgId, stateId: typeof burg?.state === "number" ? burg.state : undefined, recencyDays: 365 }),
            rumors: this.canon.listEntities({ type: "rumor", anchors: { burgId: ref.burgId }, limit: 100 }),
            hooks: this.canon.listEntities({ type: "hook", anchors: { burgId: ref.burgId }, limit: 100 }),
          },
        };
      }
      case "culture":
        return {
          ...detailBase,
          kind: "culture",
          title: this.world.getCulture(ref.cultureId)?.name ?? `Culture ${ref.cultureId}`,
          raw: this.world.getCulture(ref.cultureId),
          sections: {
            canon: this.canon.listEntities({ type: "culture", anchors: { cultureId: ref.cultureId }, limit: 50 }),
          },
        };
      case "religion":
        return {
          ...detailBase,
          kind: "religion",
          title: this.world.getReligion(ref.religionId)?.name ?? `Religion ${ref.religionId}`,
          raw: this.world.getReligion(ref.religionId),
          sections: {
            canon: this.canon.listEntities({ type: "religion", anchors: { azgaarReligionId: ref.religionId }, limit: 50 }),
            deities: this.canon.listEntities({ type: "deity", anchors: { azgaarReligionId: ref.religionId }, limit: 100 }),
          },
        };
      case "location":
        return this.resolveCanonDetail("location", ref.locationId, detailBase);
      case "npc":
        return this.resolveCanonDetail("npc", ref.npcId, detailBase);
      case "faction":
        return this.resolveCanonDetail("faction", ref.factionId, detailBase);
      case "event":
        return this.resolveCanonDetail("event", ref.eventId, detailBase);
      case "rumor":
        return this.resolveCanonDetail("rumor", ref.rumorId, detailBase);
      case "hook":
        return this.resolveCanonDetail("hook", ref.hookId, detailBase);
      case "deity":
        return this.resolveCanonDetail("deity", ref.deityId, detailBase);
      case "marker":
        return this.resolveCanonDetail("marker", ref.markerId, detailBase);
      default:
        return { ...detailBase, kind: "unknown", title: "Unknown", raw: null, sections: {} };
    }
  }

  private resolveCanonDetail(kind: string, entityId: string, base: Record<string, unknown>): any {
    const entity = this.canon.getEntity(entityId);
    const relations = this.canon.listRelations({ entity_id: entityId, limit: 200 }).map((relation) => this.enrichRelation(relation));
    return {
      ...base,
      kind,
      title: entity?.name ?? entityId,
      raw: entity,
      sections: {
        relations,
        awareness: entity?.type === "event" ? this.canon.getAwareness({ eventId: entityId }) : [],
      },
    };
  }

  private enrichRelation(relation: CanonRelation): CanonRelation & { fromName?: string; toName?: string } {
    return {
      ...relation,
      fromName: this.resolveEntityLabel(relation.from_id),
      toName: this.resolveEntityLabel(relation.to_id),
    };
  }

  private resolveEntityLabel(id: string): string {
    const entity = this.canon.getEntity(id);
    return entity?.name ?? id;
  }

  private buildPathStack(ref: EntityRef): EntityRef[] {
    switch (ref.kind) {
      case "world":
        return [{ kind: "world" }];
      case "state":
        return [{ kind: "world" }, ref];
      case "burg": {
        const burg = this.world.getBurg(ref.burgId);
        const stack: EntityRef[] = [{ kind: "world" }];
        if (typeof burg?.state === "number") {
          stack.push({ kind: "state", stateId: burg.state });
        }
        stack.push(ref);
        return stack;
      }
      case "location": {
        const entity = this.canon.getEntity(ref.locationId);
        const stack: EntityRef[] = [{ kind: "world" }];
        const burgId = entity?.anchors?.burgId;
        if (typeof burgId === "number") {
          const burg = this.world.getBurg(burgId);
          if (typeof burg?.state === "number") {
            stack.push({ kind: "state", stateId: burg.state });
          }
          stack.push({ kind: "burg", burgId });
        }
        stack.push(ref);
        return stack;
      }
      case "npc": {
        const entity = this.canon.getEntity(ref.npcId);
        const stack: EntityRef[] = [{ kind: "world" }];
        const burgId = entity?.anchors?.burgId;
        if (typeof burgId === "number") {
          const burg = this.world.getBurg(burgId);
          if (typeof burg?.state === "number") {
            stack.push({ kind: "state", stateId: burg.state });
          }
          stack.push({ kind: "burg", burgId });
        }
        const locationRelation = this.canon.listRelations({ entity_id: ref.npcId, limit: 50 }).find(
          (relation) => relation.rel_type === "located_at" && relation.from_id === ref.npcId
        );
        if (locationRelation) {
          stack.push({ kind: "location", locationId: locationRelation.to_id });
        }
        stack.push(ref);
        return stack;
      }
      default:
        return [{ kind: "world" }, ref];
    }
  }

  private currentSceneSummary(): any {
    return {
      browseTalkMode: this.browseTalkMode,
      scene: this.talkScene,
      chatState: this.browseState.chatState,
    };
  }

  private currentModelState(): any {
    const primaryProvider = getEffectiveProvider(this.config);
    const generationProvider = getEffectiveGenerationProvider(this.config);
    const talkProvider = getEffectiveTalkProvider(this.config);
    return {
      config: this.config,
      chat: { provider: this.llm.provider, model: this.llm.model },
      generation: generationProvider
        ? { provider: generationProvider, model: getEffectiveGenerationModel(this.config, generationProvider) }
        : null,
      talk: talkProvider
        ? { provider: talkProvider, model: getEffectiveTalkModel(this.config, talkProvider) }
        : null,
      defaults: {
        provider: primaryProvider,
        model: getEffectiveModel(this.config, primaryProvider),
      },
    };
  }

  serializePending(): any {
    if (!this.pending) return null;
    switch (this.pending.kind) {
      case "fieldSelection":
        return this.pending;
      case "worldgen":
        return {
          kind: this.pending.kind,
          formattedPlan: this.pending.formattedPlan,
          phase: this.pending.plan.phase,
          queue: this.pending.queue,
        };
      default:
        return {
          kind: this.pending.kind,
          formattedPlan: this.pending.formattedPlan,
          entities: (this.pending as any).plan?.entities ?? [],
          changes: (this.pending as any).plan?.changes ?? [],
        };
    }
  }

  snapshot(): any {
    const currentNodeId = refToNodeId(currentRef(this.browseState));
    const expandedNodes = expandPathToNode(currentNodeId, new Set<string>(["world"]), this.world, this.canon);
    return {
      paths: { worldPath: this.worldPath, canonPath: this.canonPath },
      counts: {
        world: this.world.counts(),
        canon: {
          entities: this.canon.listEntities({ limit: 100000 }).length,
          relations: this.canon.listRelations({ limit: 200000 }).length,
        },
      },
      browse: {
        currentRef: currentRef(this.browseState),
        currentPath: stackToPath(this.browseState, this.world, this.canon),
        detail: this.resolveCurrentDetail(),
        explorer: {
          world: buildTree(this.world, this.canon, expandedNodes, currentNodeId),
          factions: buildFactionsList(this.canon, currentNodeId),
          religions: buildReligionsList(this.world, currentNodeId, this.canon, expandedNodes),
          cultures: buildCulturesList(this.world, currentNodeId),
          canonTypes: CANON_TYPE_ORDER.map((type) => ({
            type,
            count: this.canon.listEntities({ type, limit: 100000 }).length,
          })),
        },
      },
      scene: this.currentSceneSummary(),
      campaignSettings: this.campaignSettings,
      models: this.currentModelState(),
      tokens: this.tokens,
      pending: this.serializePending(),
      timeline: this.timeline,
    };
  }

  async runBrowseCommand(command: string): Promise<BrowseCommandResponse> {
    const result = await executeCommand(command, this.buildCommandContext());
    const response = await this.handleCommandResult(command, result);
    return response;
  }

  private async handleCommandResult(command: string, result: CommandResult): Promise<BrowseCommandResponse> {
    this.capturePending(result);

    if (result.enterTalkMode) {
      this.browseTalkMode = true;
      this.talkScene = this.buildTalkScene();
    }
    if (result.exitTalkMode) {
      this.browseTalkMode = false;
    }
    if (result.runOnboarding) {
      this.pushTimeline("system", "Settings Requested", "Open the settings panel to edit campaign settings and run world generation.", "pending");
      return {
        output: result.output,
        error: result.error,
        openPanel: "settings",
        message: result.messageModal ? { title: result.messageModal.title, content: result.messageModal.content } : undefined,
        pending: this.serializePending(),
      };
    }

    if (result.output || result.error || result.messageModal) {
      this.pushTimeline(
        "command",
        `Command: ${command}`,
        result.error || result.messageModal?.content || result.output || "",
        result.error ? "error" : this.pending ? "pending" : "ok"
      );
    }

    return {
      output: result.output,
      error: result.error,
      message: result.messageModal ? { title: result.messageModal.title, content: result.messageModal.content } : undefined,
      pending: this.serializePending(),
    };
  }

  private capturePending(result: CommandResult): void {
    this.pending = null;
    if (result.pendingGeneration) {
      this.pending = { kind: "generation", plan: result.pendingGeneration.plan, formattedPlan: result.pendingGeneration.formattedPlan };
    } else if (result.pendingModification) {
      this.pending = { kind: "modification", plan: result.pendingModification.plan, formattedPlan: result.pendingModification.formattedPlan };
    } else if (result.pendingSimulation) {
      this.pending = { kind: "simulation", plan: result.pendingSimulation.plan, formattedPlan: result.pendingSimulation.formattedPlan };
    } else if (result.showFieldSelection) {
      this.pending = { kind: "fieldSelection", ...result.showFieldSelection };
    } else if (result.pendingFieldRegeneration) {
      this.pending = { kind: "fieldRegeneration", plan: result.pendingFieldRegeneration.plan, formattedPlan: result.pendingFieldRegeneration.formattedPlan };
    } else if (result.pendingDescriptionGeneration) {
      this.pending = { kind: "description", plan: result.pendingDescriptionGeneration.plan, formattedPlan: result.pendingDescriptionGeneration.formattedPlan };
    } else if (result.pendingRumorGeneration) {
      this.pending = { kind: "rumor", plan: result.pendingRumorGeneration.plan, formattedPlan: result.pendingRumorGeneration.formattedPlan };
    } else if (result.pendingHookGeneration) {
      this.pending = { kind: "hook", plan: result.pendingHookGeneration.plan, formattedPlan: result.pendingHookGeneration.formattedPlan };
    } else if (result.pendingBurgGeneration) {
      this.pending = { kind: "burg", plan: result.pendingBurgGeneration.plan, formattedPlan: result.pendingBurgGeneration.formattedPlan };
    }
  }

  async approvePending(): Promise<BrowseCommandResponse> {
    if (!this.pending) {
      return { error: "No pending action to approve." };
    }

    let result: CommandResult;
    const ctx = this.buildCommandContext();

    switch (this.pending.kind) {
      case "generation":
        result = await executePendingGeneration(this.pending.plan, ctx);
        break;
      case "modification":
        result = executePendingModification(this.pending.plan, ctx);
        break;
      case "simulation":
        result = await executePendingSimulation(this.pending.plan, ctx);
        break;
      case "fieldRegeneration":
        result = await executePendingFieldRegeneration(this.pending.plan, ctx);
        break;
      case "description":
        result = await executePendingDescriptionGeneration(this.pending.plan, ctx);
        break;
      case "rumor":
        result = await executePendingRumorGeneration(this.pending.plan, ctx);
        break;
      case "hook":
        result = await executePendingHookGeneration(this.pending.plan, ctx);
        break;
      case "burg":
        result = await executePendingBurgGeneration(this.pending.plan, ctx);
        break;
      case "worldgen": {
        const worldCtx = this.buildWorldGenContext(this.pending.queue.stateFilter);
        const queue = this.pending.queue;
        const plan = this.pending.plan;
        const execResult = await executePhasePlan(worldCtx, plan);
        this.pushTimeline("system", `Worldgen Applied: ${plan.phase}`, `Created: ${execResult.created}\nErrors: ${execResult.errors.length}`, execResult.errors.length ? "error" : "ok");
        const next = await this.advanceWorldGenQueue(queue, plan.phase);
        if (next) {
          return {
            output: `Applied ${plan.phase}. Next phase ready.`,
            pending: this.serializePending(),
          };
        }
        this.pending = null;
        return {
          output: `Applied ${plan.phase}. World generation queue complete.`,
          pending: null,
        };
      }
      case "fieldSelection":
        return { error: "Choose fields first before approving." };
    }

    this.pending = null;
    return this.handleCommandResult("approve", result);
  }

  rejectPending(): BrowseCommandResponse {
    if (!this.pending) {
      return { error: "No pending action to reject." };
    }
    const description = this.pending.kind === "worldgen"
      ? `Cancelled worldgen phase ${this.pending.plan.phase}.`
      : `Cancelled pending ${this.pending.kind}.`;
    this.pending = null;
    this.pushTimeline("system", "Pending Action Cancelled", description, "ok");
    return { output: description, pending: null };
  }

  planFieldRegeneration(selectedFields: string[], hint: string): BrowseCommandResponse {
    if (!this.pending || this.pending.kind !== "fieldSelection") {
      return { error: "No field-selection step is active." };
    }
    const response = planFieldRegen(this.pending.entityId, selectedFields, hint, this.buildCommandContext());
    this.capturePending(response);
    return {
      output: response.output,
      error: response.error,
      pending: this.serializePending(),
    };
  }

  async navigate(ref: EntityRef): Promise<void> {
    const stack = this.buildPathStack(ref);
    setStack(this.browseState, stack);
    this.talkScene = this.buildTalkScene();
  }

  async setCurrentRef(ref: EntityRef): Promise<any> {
    await this.navigate(ref);
    return this.resolveCurrentDetail();
  }

  async runDirector(message: string): Promise<any> {
    const result = await directScene({
      llm: this.llm,
      generationLlm: this.generationLlm,
      world: this.world,
      canon: this.canon,
      state: this.browseState.chatState,
      userText: message,
      campaignSettings: this.campaignSettings,
      onToolCall: (name, args) => this.pushTimeline("tool", `Director Tool: ${name}`, JSON.stringify(args, null, 2), "pending"),
      onToolResult: (name, value, elapsedMs) => this.pushTimeline("tool", `Director Result: ${name}`, `${JSON.stringify(value, null, 2)}\n\n${elapsedMs}ms`, "ok"),
      onLLMComplete: (usage) => addTokens(this.tokens, usage),
    });
    syncNavigationFromChatState({
      state: this.browseState,
      world: this.world,
      canon: this.canon,
      llm: this.llm,
      generationLlm: this.generationLlm,
      campaignSettings: this.campaignSettings,
    });
    this.talkScene = result.scene || this.buildTalkScene();
    this.pushTimeline("chat", "Director", result.reply, "ok");
    return {
      reply: result.reply,
      scene: result.scene,
      history: this.browseState.chatState.directorHistory,
    };
  }

  async runNpcChat(message: string, npcName?: string): Promise<any> {
    if (npcName) {
      const burgId = this.browseState.chatState.currentBurgId;
      const npcId = resolveNpcByName(this.canon, burgId, npcName);
      if (!npcId) {
        throw new Error(`NPC not found: ${npcName}`);
      }
      this.browseState.chatState.currentNpcId = npcId;
      this.browseTalkMode = true;
    }

    const scene = this.buildTalkScene();
    this.talkScene = scene;
    const reply = await npcTurn({
      llm: this.llm,
      talkLlm: this.talkLlm,
      world: this.world,
      canon: this.canon,
      state: this.browseState.chatState,
      scene,
      userText: message,
      campaignSettings: this.campaignSettings,
      onTokens: (usage) => addTokens(this.tokens, usage),
    });
    this.pushTimeline("chat", "NPC", reply, "ok");
    return {
      reply,
      npcId: this.browseState.chatState.currentNpcId,
      scene,
      history: this.browseState.chatState.currentNpcId
        ? this.browseState.chatState.npcHistories[this.browseState.chatState.currentNpcId] ?? []
        : [],
    };
  }

  async runGeneralChat(message: string): Promise<any> {
    const result = await generalChat({
      llm: this.llm,
      generationLlm: this.generationLlm,
      world: this.world,
      canon: this.canon,
      state: this.browseState.chatState,
      userText: message,
      campaignSettings: this.campaignSettings,
      onToolCall: (name, args) => this.pushTimeline("tool", `General Tool: ${name}`, JSON.stringify(args, null, 2), "pending"),
      onToolResult: (name, value, elapsedMs) => this.pushTimeline("tool", `General Result: ${name}`, `${JSON.stringify(value, null, 2)}\n\n${elapsedMs}ms`, "ok"),
      onLLMComplete: (usage) => addTokens(this.tokens, usage),
    });

    // Store proposed plans for later approval
    for (const block of result.blocks) {
      if (block.type === "plan" && block.status === "pending") {
        this.generalChatPlans.set(block.planId, {
          entities: block.entities,
          summary: block.summary,
          burgId: (block as any).burgId,
          burgName: (block as any).burgName,
        });
      }
    }

    this.pushTimeline("chat", "General Chat", result.reply, "ok");
    return {
      reply: result.reply,
      blocks: result.blocks,
      history: result.history,
    };
  }

  async approveGeneralPlan(planId: string): Promise<any> {
    const planData = this.generalChatPlans.get(planId);
    if (!planData) {
      return { error: "Plan not found or already processed." };
    }

    // Convert proposed plan entities into a GenPlan and set as pending
    const genPlan: GenPlan = {
      description: planData.summary,
      userPrompt: planData.summary,
      entities: planData.entities.map((e: any) => ({
        type: e.type,
        name: e.name,
        kind: e.kind,
        reason: e.reason,
        customPrompt: e.hints,
        connectsTo: [],
      })),
      context: {
        burgId: planData.burgId || 0,
        burgName: planData.burgName || "",
        activeEvents: [],
        existingEntities: [],
      },
    };

    this.pending = {
      kind: "generation",
      plan: genPlan,
      formattedPlan: `General Chat Plan: ${planData.summary}\n\n${planData.entities.map((e: any, i: number) => `${i + 1}. ${e.type}: ${e.name} - ${e.reason}`).join("\n")}`,
    };

    // Execute immediately
    const result = await this.approvePending();

    // Update plan status in general history
    this.updateGeneralPlanStatus(planId, "approved");
    this.generalChatPlans.delete(planId);

    return result;
  }

  rejectGeneralPlan(planId: string): any {
    if (!this.generalChatPlans.has(planId)) {
      return { error: "Plan not found or already processed." };
    }
    this.updateGeneralPlanStatus(planId, "rejected");
    this.generalChatPlans.delete(planId);
    this.pushTimeline("system", "Plan Rejected", `Rejected plan ${planId}`, "ok");
    return { ok: true };
  }

  private updateGeneralPlanStatus(planId: string, status: "approved" | "rejected"): void {
    for (const msg of this.browseState.chatState.generalHistory) {
      if (!msg.blocks) continue;
      for (const block of msg.blocks) {
        if (block.type === "plan" && block.planId === planId) {
          block.status = status;
        }
      }
    }
  }

  async updateCampaignSettings(settings: CampaignSettings): Promise<void> {
    saveCampaignSettings(this.canon, settings);
    this.campaignSettings = getCampaignSettings(this.canon);
    this.pushTimeline("system", "Campaign Settings Updated", JSON.stringify(settings, null, 2), "ok");
  }

  private rebuildLlmClients(): void {
    const provider = getEffectiveProvider(this.config);
    this.llm = createLLMClient({ provider, model: getEffectiveModel(this.config, provider) });

    const generationProvider = getEffectiveGenerationProvider(this.config);
    this.generationLlm = generationProvider
      ? createLLMClient({ provider: generationProvider, model: getEffectiveGenerationModel(this.config, generationProvider) })
      : undefined;

    const talkProvider = getEffectiveTalkProvider(this.config);
    this.talkLlm = talkProvider
      ? createLLMClient({ provider: talkProvider, model: getEffectiveTalkModel(this.config, talkProvider) })
      : undefined;
  }

  async updateModel(slot: "chat" | "generation" | "talk", provider?: LLMProviderName, model?: string, disable?: boolean): Promise<void> {
    const next = structuredClone(this.config) as LLMConfig;

    if (slot === "chat") {
      if (!provider || !model) throw new Error("Chat model requires provider and model.");
      const providerError = validateProviderSwitch(provider);
      if (providerError) throw new Error(providerError);
      next.provider = provider;
      next.models = { ...(next.models ?? {}), [provider]: model };
    } else if (slot === "generation") {
      if (disable) {
        delete next.generationProvider;
      } else {
        if (!provider || !model) throw new Error("Generation model requires provider and model.");
        const providerError = validateProviderSwitch(provider);
        if (providerError) throw new Error(providerError);
        next.generationProvider = provider;
        next.generationModels = { ...(next.generationModels ?? {}), [provider]: model };
      }
    } else if (slot === "talk") {
      if (disable) {
        delete next.talkProvider;
      } else {
        if (!provider || !model) throw new Error("Talk model requires provider and model.");
        const providerError = validateProviderSwitch(provider);
        if (providerError) throw new Error(providerError);
        next.talkProvider = provider;
        next.talkModels = { ...(next.talkModels ?? {}), [provider]: model };
      }
    }

    await saveConfig(next);
    this.config = next;
    this.rebuildLlmClients();
    this.pushTimeline("system", "Models Updated", JSON.stringify(this.currentModelState(), null, 2), "ok");
  }

  getCanonTypeList(type: EntityType): CanonEntity[] {
    return this.canon.listEntities({ type, limit: 300 });
  }

  search(query: string): any[] {
    return performSearch(query, this.world, this.canon, 40);
  }

  async ingestSource(input: {
    name?: string;
    text?: string;
    filePath?: string;
    scope?: string;
    apply?: boolean;
    anchors?: Record<string, unknown>;
  }): Promise<any> {
    let text = normalizeText(input.text);
    if (!text && input.filePath) {
      text = await Bun.file(input.filePath).text();
    }
    if (!text) {
      throw new Error("Source ingest requires text or a readable file path.");
    }

    const llm = this.generationLlm || this.llm;
    const result = await parseSourceText(
      { canon: this.canon, world: this.world, llm },
      {
        name: input.name,
        text,
        scope: input.scope ?? "world",
        anchors: input.anchors ?? {},
        apply: !!input.apply,
      }
    );
    this.pushTimeline("system", "Source Ingest", result.plan.summary, input.apply ? "ok" : "pending");
    return result;
  }

  async exportWiki(outDir: string): Promise<any> {
    const result = await exportWiki(outDir, this.world, this.canon);
    this.pushTimeline("export", "Wiki Export", JSON.stringify(result, null, 2), "ok");
    return result;
  }

  async exportCanon(outFile: string): Promise<any> {
    const snapshot = this.canon.exportSnapshot();
    await Bun.write(outFile, JSON.stringify(snapshot, null, 2));
    const result = { written: outFile, entities: snapshot.entities.length, relations: snapshot.relations.length };
    this.pushTimeline("export", "Canon Export", JSON.stringify(result, null, 2), "ok");
    return result;
  }

  async importCanon(inputFile: string, mode: "upsert" | "insert"): Promise<any> {
    const text = await Bun.file(inputFile).text();
    const payload = JSON.parse(text);
    const result = this.canon.importSnapshot(payload, mode);
    this.pushTimeline("export", "Canon Import", JSON.stringify({ inputFile, mode, ...result }, null, 2), "ok");
    return result;
  }

  createEntity(input: CanonEntityInput): CanonEntity {
    const entity = this.canon.addEntity({
      type: input.type,
      name: input.name,
      summary: input.summary ?? null,
      details_md: input.details_md ?? null,
      tags: input.tags ?? [],
      anchors: input.anchors ?? {},
      payload: input.payload ?? {},
      meta: input.meta ?? {},
      provenance: input.provenance ?? {},
      entity_id: input.id,
    });
    this.pushTimeline("system", `Created ${entity.type}`, `${entity.name} (${entity.id})`, "ok");
    return entity;
  }

  patchEntity(entityId: string, patch: Partial<CanonEntity>): CanonEntity | undefined {
    const updated = this.canon.patchEntity(entityId, patch);
    if (updated) {
      this.pushTimeline("system", `Patched ${updated.type}`, `${updated.name} (${updated.id})`, "ok");
    }
    return updated;
  }

  deleteEntity(entityId: string): boolean {
    const success = this.canon.deleteEntity(entityId);
    if (success) {
      this.pushTimeline("system", "Deleted Entity", entityId, "ok");
    }
    return success;
  }

  createRelation(input: {
    from_id: string;
    to_id: string;
    rel_type: string;
    strength?: number | null;
    notes?: string | null;
  }): CanonRelation {
    const relation = this.canon.addRelation(input);
    this.pushTimeline("system", "Created Relation", `${input.from_id} ${input.rel_type} ${input.to_id}`, "ok");
    return relation;
  }

  deleteRelation(relationId: string): boolean {
    const success = this.canon.deleteRelation(relationId);
    if (success) {
      this.pushTimeline("system", "Deleted Relation", relationId, "ok");
    }
    return success;
  }

  setAwareness(input: { actorType: ActorType; actorId: string; eventId: string; level: AwarenessLevel }): any {
    const record = this.canon.setAwareness(input);
    this.pushTimeline("system", "Awareness Updated", JSON.stringify(record, null, 2), "ok");
    return record;
  }

  private buildWorldGenContext(stateFilter?: number[]): WorldGenContext {
    return {
      world: this.world,
      canon: this.canon,
      llm: this.generationLlm || this.llm,
      campaignSettings: this.campaignSettings,
      stateFilter,
      onTokens: (usage) => addTokens(this.tokens, usage),
      onProgress: (message) => this.pushTimeline("tool", "Worldgen Progress", message, "pending"),
    };
  }

  async startWorldgen(flags: GenerationFlags, stateFilter?: number[]): Promise<any> {
    const queue: WorldGenQueue = { flags, stateFilter };
    const next = await this.advanceWorldGenQueue(queue);
    if (!next) {
      return { error: "No worldgen phases selected." };
    }
    this.pushTimeline("system", "Worldgen Planned", `Prepared ${next.phase} phase.`, "pending");
    return {
      pending: this.serializePending(),
    };
  }

  private async advanceWorldGenQueue(queue: WorldGenQueue, justCompletedPhase?: PhasePlan["phase"]): Promise<PhasePlan | null> {
    const remainingFlags: GenerationFlags = { ...queue.flags };
    if (justCompletedPhase === "religions") remainingFlags.religions = false;
    if (justCompletedPhase === "pantheons") remainingFlags.pantheons = false;
    if (justCompletedPhase === "cultures") remainingFlags.cultures = false;
    if (justCompletedPhase === "states") remainingFlags.states = false;
    queue.flags = remainingFlags;

    const worldCtx = this.buildWorldGenContext(queue.stateFilter);
    let plan: PhasePlan | null = null;
    if (remainingFlags.religions) {
      plan = await planReligionGeneration(worldCtx);
    } else if (remainingFlags.pantheons) {
      plan = await planPantheonGeneration(worldCtx);
    } else if (remainingFlags.cultures) {
      plan = await planCultureGeneration(worldCtx);
    } else if (remainingFlags.states) {
      plan = await planStateGeneration(worldCtx);
    }

    if (!plan) {
      this.pending = null;
      return null;
    }

    this.pending = {
      kind: "worldgen",
      plan,
      formattedPlan: formatPhasePlan(plan, false),
      queue,
    };
    return plan;
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const normalized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  const filePath = join(STATIC_ROOT, normalized);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return notFound();
  }
  return new Response(file, {
    headers: { "content-type": mimeType(filePath) },
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { globals, rest } = extractGlobals(argv);

  const portFlag = rest.find((value) => value.startsWith("--port="));
  const inlinePort = portFlag ? Number(portFlag.split("=", 2)[1]) : undefined;
  const portIndex = rest.indexOf("--port");
  const port = inlinePort || (portIndex >= 0 ? Number(rest[portIndex + 1]) : DEFAULT_PORT);
  const worldPath = globals.world || "./data/world.json";
  const canonPath = globals.canon || "./data/canon.db";

  const session = await WebSession.create(worldPath, canonPath);

  // --- Livereload: watch public dir and notify connected SSE clients ---
  const livereloadClients = new Set<ReadableStreamDefaultController>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  watch(STATIC_ROOT, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const controller of livereloadClients) {
        try { controller.enqueue(`data: reload\n\n`); } catch { livereloadClients.delete(controller); }
      }
    }, 150);
  });

  const server = Bun.serve({
    hostname: LOCAL_HOST,
    port,
    async fetch(request) {
      const url = new URL(request.url);

      try {
        // Livereload SSE endpoint
        if (url.pathname === "/api/livereload" && request.method === "GET") {
          const stream = new ReadableStream({
            start(controller) {
              livereloadClients.add(controller);
              controller.enqueue(`data: connected\n\n`);
            },
            cancel(controller) {
              livereloadClients.delete(controller);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive",
            },
          });
        }

        if (url.pathname === "/api/bootstrap" && request.method === "GET") {
          return json(session.snapshot());
        }

        if (url.pathname === "/api/explorer" && request.method === "GET") {
          const view = url.searchParams.get("view") ?? "world";
          if (view === "canon") {
            const type = (url.searchParams.get("type") ?? "location") as EntityType;
            return json({ items: session.getCanonTypeList(type) });
          }
          return json(session.snapshot().browse.explorer);
        }

        if (url.pathname === "/api/detail" && request.method === "GET") {
          const ref = resolvePathRef(url.searchParams.get("ref") ?? "world");
          return json({ detail: await session.setCurrentRef(ref), snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/navigate" && request.method === "POST") {
          const body = await readJson<{ ref: EntityRef }>(request);
          const detail = await session.setCurrentRef(parseRef(body.ref));
          return json({ detail, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/search" && request.method === "GET") {
          const query = url.searchParams.get("q") ?? "";
          return json({ results: session.search(query) });
        }

        if (url.pathname === "/api/map/full" && request.method === "GET") {
          if (!session.fullMapCache) {
            session.fullMapCache = session.world.getFullMap();
          }
          const allMarkers = session.canon.listEntities({ type: "marker", limit: 500 });
          const markers = allMarkers
            .filter((m: any) => m.payload?.x != null && m.payload?.y != null)
            .map((m: any) => ({ id: m.id, name: m.name, kind: m.payload?.kind || "marker", icon: m.payload?.icon, x: m.payload.x, y: m.payload.y, dangerLevel: m.payload?.dangerLevel }));
          return json({ ...session.fullMapCache, markers });
        }

        if (url.pathname === "/api/map/burg" && request.method === "GET") {
          const burgId = Number(url.searchParams.get("id") ?? "0");
          const radius = Number(url.searchParams.get("radius") ?? "150");
          if (!burgId) return badRequest("Missing burg id.");
          const region = session.world.getMapRegion(burgId, radius);
          if (!region) return badRequest("Burg not found.");
          // Add canon markers that have coordinates in this region
          const allMarkers = session.canon.listEntities({ type: "marker", limit: 500 });
          const regionMarkers = allMarkers
            .filter((m: any) => {
              const mx = m.payload?.x;
              const my = m.payload?.y;
              if (mx == null || my == null) return false;
              return mx >= region.bounds.x && mx <= region.bounds.x + region.bounds.w &&
                     my >= region.bounds.y && my <= region.bounds.y + region.bounds.h;
            })
            .map((m: any) => ({
              id: m.id,
              name: m.name,
              kind: m.payload?.kind || "marker",
              icon: m.payload?.icon || "?",
              x: m.payload.x,
              y: m.payload.y,
              dangerLevel: m.payload?.dangerLevel,
            }));
          return json({ ...region, markers: regionMarkers });
        }

        if (url.pathname === "/api/command" && request.method === "POST") {
          const body = await readJson<{ command: string }>(request);
          const result = await session.runBrowseCommand(body.command);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/pending/approve" && request.method === "POST") {
          const result = await session.approvePending();
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/pending/reject" && request.method === "POST") {
          const result = session.rejectPending();
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/pending/field-plan" && request.method === "POST") {
          const body = await readJson<{ selectedFields: string[]; hint?: string }>(request);
          const result = session.planFieldRegeneration(body.selectedFields ?? [], body.hint ?? "");
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/chat/director" && request.method === "POST") {
          const body = await readJson<{ message: string }>(request);
          const result = await session.runDirector(body.message);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/chat/npc" && request.method === "POST") {
          const body = await readJson<{ message: string; npcName?: string }>(request);
          const result = await session.runNpcChat(body.message, body.npcName);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/chat/general" && request.method === "POST") {
          const body = await readJson<{ message: string }>(request);
          const result = await session.runGeneralChat(body.message);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/chat/general/plan/approve" && request.method === "POST") {
          const body = await readJson<{ planId: string }>(request);
          const result = await session.approveGeneralPlan(body.planId);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/chat/general/plan/reject" && request.method === "POST") {
          const body = await readJson<{ planId: string }>(request);
          const result = session.rejectGeneralPlan(body.planId);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/settings/campaign" && request.method === "POST") {
          const body = await readJson<{ settings: CampaignSettings }>(request);
          await session.updateCampaignSettings(body.settings);
          return json({ ok: true, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/settings/models" && request.method === "GET") {
          const provider = url.searchParams.get("provider") as LLMProviderName | null;
          if (!provider) {
            return badRequest("Missing provider.");
          }
          return json({ provider, models: await listModels(provider) });
        }

        if (url.pathname === "/api/settings/model" && request.method === "POST") {
          const body = await readJson<{ slot: "chat" | "generation" | "talk"; provider?: LLMProviderName; model?: string; disable?: boolean }>(request);
          await session.updateModel(body.slot, body.provider, body.model, body.disable);
          return json({ ok: true, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/worldgen/start" && request.method === "POST") {
          const body = await readJson<{ flags: GenerationFlags; stateFilter?: number[] }>(request);
          const result = await session.startWorldgen(body.flags ?? {}, body.stateFilter);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/tools/ingest" && request.method === "POST") {
          const body = await readJson<{ name?: string; text?: string; filePath?: string; scope?: string; apply?: boolean; anchors?: Record<string, unknown> }>(request);
          const result = await session.ingestSource(body);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/tools/wiki-export" && request.method === "POST") {
          const body = await readJson<{ outDir: string }>(request);
          const result = await session.exportWiki(body.outDir);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/tools/canon-export" && request.method === "POST") {
          const body = await readJson<{ outFile: string }>(request);
          const result = await session.exportCanon(body.outFile);
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/tools/canon-import" && request.method === "POST") {
          const body = await readJson<{ inputFile: string; mode?: "upsert" | "insert" }>(request);
          const result = await session.importCanon(body.inputFile, body.mode ?? "upsert");
          return json({ result, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/canon/entity" && request.method === "POST") {
          const body = await readJson<{ entity: CanonEntityInput }>(request);
          const entity = session.createEntity(body.entity);
          return json({ entity, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/canon/entity" && request.method === "PATCH") {
          const body = await readJson<{ entityId: string; patch: Partial<CanonEntity> }>(request);
          const entity = session.patchEntity(body.entityId, body.patch);
          if (!entity) return notFound("Entity not found.");
          return json({ entity, snapshot: session.snapshot() });
        }

        if (url.pathname.startsWith("/api/canon/entity/") && request.method === "DELETE") {
          const entityId = decodeURIComponent(url.pathname.replace("/api/canon/entity/", ""));
          const ok = session.deleteEntity(entityId);
          if (!ok) return notFound("Entity not found.");
          return json({ ok, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/canon/relation" && request.method === "POST") {
          const body = await readJson<{ relation: { from_id: string; to_id: string; rel_type: string; strength?: number | null; notes?: string | null } }>(request);
          const relation = session.createRelation(body.relation);
          return json({ relation, snapshot: session.snapshot() });
        }

        if (url.pathname.startsWith("/api/canon/relation/") && request.method === "DELETE") {
          const relationId = decodeURIComponent(url.pathname.replace("/api/canon/relation/", ""));
          const ok = session.deleteRelation(relationId);
          if (!ok) return notFound("Relation not found.");
          return json({ ok, snapshot: session.snapshot() });
        }

        if (url.pathname === "/api/canon/awareness" && request.method === "POST") {
          const body = await readJson<{ actorType: ActorType; actorId: string; eventId: string; level: AwarenessLevel }>(request);
          const record = session.setAwareness(body);
          return json({ record, snapshot: session.snapshot() });
        }

        return serveStatic(url.pathname);
      } catch (error) {
        return json({ error: toErrorMessage(error) }, { status: 500 });
      }
    },
    error(error) {
      return json({ error: toErrorMessage(error) }, { status: 500 });
    },
  });

  process.on("SIGINT", () => {
    session.close();
    server.stop(true);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    session.close();
    server.stop(true);
    process.exit(0);
  });

  console.log(`azweb running at http://${LOCAL_HOST}:${server.port}`);
  console.log(`world=${worldPath}`);
  console.log(`canon=${canonPath}`);
}

main().catch((error) => {
  console.error(toErrorMessage(error));
  process.exit(1);
});
