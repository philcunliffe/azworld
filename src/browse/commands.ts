/**
 * Command parser and handlers for azbrowse CLI
 */

import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity, EntityType } from "../canon/canon";
import {
  LLMClient,
  completeJson,
  listModels,
  createLLMClient,
  type LLMProviderName,
} from "../llm/providers";
import {
  type LLMConfig,
  saveConfig,
  getEffectiveModel,
  getEffectiveGenerationModel,
  validateProviderSwitch,
} from "../llm/config";
import { directScene, SceneContext } from "../chat/director";
import { npcTurn, resolveNpcByName } from "../chat/npc";
import { CampaignSettings } from "../chat/schema";
import { bestFuzzyMatch } from "../util/fuzzy";
import {
  BrowseState,
  EntityRef,
  currentRef,
  currentBurgId,
  currentLocationId,
  navigateTo,
  navigateUp,
  navigateBack,
  setStack,
  stackToPath,
  getCurrentEntity,
  isAtNpc,
} from "./state";
import {
  listStates,
  listBurgs,
  listLocations,
  listNpcs,
  listFactions,
  listEvents,
  listContextual,
  formatListResult,
} from "./listing";
import {
  planGeneration,
  executeGeneration,
  formatPlanForApproval,
  syncNavigationFromChatState,
  GenContext,
  planModification,
  executeModification,
  formatModPlanForApproval,
} from "./gen-agent";
import { selectPrompt } from "./select-prompt";

// Color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

export type CommandContext = {
  state: BrowseState;
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;
  campaignSettings?: CampaignSettings;
  useColors?: boolean;
  tuiMode?: boolean;  // When true, gen commands return plan for TUI approval instead of using console
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: any, elapsedMs: number) => void;
  onTokens?: (usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) => void;
  getTokens?: () => { promptTokens: number; completionTokens: number; totalTokens: number };
  // Entity generation progress callbacks
  onEntityStart?: (name: string, index: number, total: number) => void;
  onEntityComplete?: (entity: { id: string; name: string; type: string }, index: number, total: number, tokens: number, elapsedMs: number) => void;
  // Model switching support
  config?: LLMConfig;
  onConfigChange?: (config: LLMConfig) => void;
  onLlmChange?: (llm: LLMClient) => void;
  onGenerationLlmChange?: (llm: LLMClient | undefined) => void;
  setStatusBarProvider?: (provider: string, model: string) => void;
};

// Import GenPlan and ModPlan types for pending operations
import type { GenPlan, ModPlan } from "./gen-agent";

export type CommandResult = {
  output?: string;           // Text to display
  error?: string;            // Error message
  enterTalkMode?: boolean;   // Should enter NPC talk mode
  exitTalkMode?: boolean;    // Should exit NPC talk mode
  quit?: boolean;            // Should exit program
  scene?: SceneContext;      // Updated scene context
  runOnboarding?: boolean;   // Should run campaign settings onboarding
  // TUI-specific: pending generation needing approval
  pendingGeneration?: {
    plan: GenPlan;
    formattedPlan: string;
    genType: "location" | "npc" | "faction";
    kindHint: string | undefined;
    prompt: string;
  };
  // TUI-specific: pending modification needing approval
  pendingModification?: {
    plan: ModPlan;
    formattedPlan: string;
  };
};

// Parse command line into command and args
export function parseCommand(line: string): { cmd: string; args: string[] } {
  const trimmed = line.trim();
  if (!trimmed) return { cmd: "", args: [] };

  // Handle slash commands
  if (trimmed.startsWith("/")) {
    const parts = trimmed.slice(1).split(/\s+/);
    return { cmd: "/" + (parts[0] || ""), args: parts.slice(1) };
  }

  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0] || "", args: parts.slice(1) };
}

// Execute a command
export async function executeCommand(
  line: string,
  ctx: CommandContext
): Promise<CommandResult> {
  const { cmd, args } = parseCommand(line);
  const argStr = args.join(" ");

  // Help
  if (cmd === "help" || cmd === "/help" || cmd === "?") {
    return { output: helpText(ctx.useColors) };
  }

  // Exit
  if (cmd === "exit" || cmd === "quit" || cmd === "/exit" || cmd === "/quit") {
    return { quit: true };
  }

  // pwd - print working path
  if (cmd === "pwd") {
    return { output: stackToPath(ctx.state, ctx.world, ctx.canon) };
  }

  // back - return to previous location
  if (cmd === "back" || cmd === "/back") {
    // If in NPC focus, exit talk mode first
    if (isAtNpc(ctx.state)) {
      navigateUp(ctx.state);
      return { output: "(Returned from NPC)", exitTalkMode: true };
    }
    if (navigateBack(ctx.state)) {
      return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
    }
    return { error: "No history to go back to" };
  }

  // Navigation: loc [name] or loc ..
  if (cmd === "loc") {
    if (!argStr || argStr === ".") {
      // Show current location
      const cur = currentRef(ctx.state);
      if (cur.kind === "burg") {
        const burg = ctx.world.getBurg(cur.burgId);
        return { output: formatBurgInfo(burg, ctx.world, ctx.useColors) };
      }
      if (cur.kind === "location") {
        const loc = ctx.canon.getEntity(cur.locationId);
        return { output: formatLocationInfo(loc, ctx.useColors) };
      }
      return { output: stackToPath(ctx.state, ctx.world, ctx.canon) };
    }

    if (argStr === "..") {
      if (navigateUp(ctx.state)) {
        return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
      }
      return { error: "Already at root" };
    }

    // Navigate to burg or location by name
    return navigateToLocation(argStr, ctx);
  }

  // Navigation: state [name]
  if (cmd === "state") {
    if (!argStr) {
      const cur = currentRef(ctx.state);
      if (cur.kind === "state") {
        const s = ctx.world.getState(cur.stateId);
        return { output: formatStateInfo(s, ctx.useColors) };
      }
      // Show states list
      const result = listStates(ctx.world);
      return { output: formatListResult(result, ctx.useColors) };
    }

    // Navigate to state
    return navigateToState(argStr, ctx);
  }

  // Navigation: npc [name]
  if (cmd === "npc") {
    if (!argStr) {
      // If at NPC, show info
      if (isAtNpc(ctx.state)) {
        const cur = currentRef(ctx.state);
        if (cur.kind === "npc") {
          const npc = ctx.canon.getEntity(cur.npcId);
          return { output: formatNpcInfo(npc, ctx.useColors) };
        }
      }
      // Otherwise list NPCs in context
      const burgId = currentBurgId(ctx.state);
      const locationId = currentLocationId(ctx.state);
      const result = listNpcs(ctx.canon, ctx.world, { locationId, burgId });
      return { output: formatListResult(result, ctx.useColors) };
    }

    // Navigate to NPC
    return navigateToNpc(argStr, ctx);
  }

  // Navigation: cd <path>
  if (cmd === "cd") {
    if (!argStr || argStr === "~") {
      setStack(ctx.state, [{ kind: "world" }]);
      return { output: "~" };
    }
    if (argStr === "..") {
      if (navigateUp(ctx.state)) {
        return { output: stackToPath(ctx.state, ctx.world, ctx.canon) };
      }
      return { error: "Already at root" };
    }
    // Parse path segments
    const segments = argStr.split("/").filter(Boolean);
    for (const seg of segments) {
      if (seg === "..") {
        navigateUp(ctx.state);
      } else {
        // Try to navigate to segment
        const result = await navigateToAny(seg, ctx);
        if (result.error) return result;
      }
    }
    return { output: stackToPath(ctx.state, ctx.world, ctx.canon) };
  }

  // Listing: ls [filter]
  if (cmd === "ls") {
    const filter = argStr || undefined;
    const result = listContextual(ctx.state, ctx.world, ctx.canon, filter);
    return { output: `${result.context}:\n${formatListResult(result, ctx.useColors)}` };
  }

  // Info: info [id]
  if (cmd === "info") {
    if (argStr) {
      // Show info for specific entity
      const entity = ctx.canon.getEntity(argStr);
      if (entity) {
        return { output: formatEntityInfo(entity, ctx.useColors) };
      }
      // Try as world entity
      const burg = ctx.world.getBurg(argStr);
      if (burg) return { output: formatBurgInfo(burg, ctx.world, ctx.useColors) };
      const state = ctx.world.getState(argStr);
      if (state) return { output: formatStateInfo(state, ctx.useColors) };
      return { error: `Entity not found: ${argStr}` };
    }

    // Show info for current entity
    const current = getCurrentEntity(ctx.state, ctx.world, ctx.canon);
    if (!current) return { error: "No current entity" };

    switch (current.kind) {
      case "world":
        return { output: formatWorldInfo(ctx.world, ctx.canon, ctx.useColors) };
      case "state":
        return { output: formatStateInfo(current.entity, ctx.useColors) };
      case "burg":
        return { output: formatBurgInfo(current.entity, ctx.world, ctx.useColors) };
      case "location":
        return { output: formatLocationInfo(current.entity, ctx.useColors) };
      case "npc":
        return { output: formatNpcInfo(current.entity, ctx.useColors) };
      default:
        return { output: JSON.stringify(current.entity, null, 2) };
    }
  }

  // Relations: rels [id]
  if (cmd === "rels") {
    const entityId = argStr || getCurrentEntityId(ctx.state);
    if (!entityId) return { error: "No entity selected" };

    const rels = ctx.canon.listRelations({ entity_id: entityId, limit: 50 });
    if (rels.length === 0) return { output: "(no relations)" };

    const lines = rels.map(r => {
      const fromName = ctx.canon.getEntity(r.from_id)?.name || r.from_id;
      const toName = ctx.canon.getEntity(r.to_id)?.name || r.to_id;
      return `  ${fromName} --[${r.rel_type}]--> ${toName}`;
    });
    return { output: lines.join("\n") };
  }

  // Search: search <term>
  if (cmd === "search") {
    if (!argStr) return { error: "Usage: search <term>" };
    return searchEntities(argStr, ctx);
  }

  // Delete: rm [id]
  if (cmd === "rm") {
    return deleteEntity(argStr, ctx);
  }

  // Unlink: unlink <id>
  if (cmd === "unlink") {
    if (!argStr) return { error: "Usage: unlink <relation_id>" };
    const deleted = ctx.canon.deleteRelation(argStr);
    if (deleted) {
      return { output: `Deleted relation: ${argStr}` };
    }
    return { error: `Relation not found: ${argStr}` };
  }

  // Smart Generation with planning and permission: gen location <kind> [hints]
  if (cmd === "gen") {
    const [subCmd, ...subArgs] = args;

    if (subCmd === "location" || subCmd === "npc" || subCmd === "faction") {
      const kind = subCmd === "npc" ? undefined : (subArgs[0] || (subCmd === "location" ? "tavern" : "guild"));
      const hints = subCmd === "npc" ? subArgs.join(" ") : subArgs.slice(1).join(" ");
      const fullPrompt = hints ? `${kind ? kind + " " : ""}${hints}`.trim() : (kind || subCmd);

      return runSmartGeneration(subCmd as "location" | "npc" | "faction", kind, fullPrompt, ctx);
    }
    return { error: "Usage: gen location|npc|faction <kind> [hints]" };
  }

  // Simple Generation (old behavior, no planning): simplegen location <kind> [hints]
  if (cmd === "simplegen") {
    const [subCmd, ...subArgs] = args;
    const hints = subArgs.slice(1).join(" ");

    if (subCmd === "location") {
      const kind = subArgs[0] || "tavern";
      return generateLocation(kind, hints, ctx);
    }
    if (subCmd === "npc") {
      return generateNpcs(hints, ctx);
    }
    if (subCmd === "faction") {
      const kind = subArgs[0] || "guild";
      return generateFaction(kind, hints, ctx);
    }
    return { error: "Usage: simplegen location|npc|faction <kind> [hints]" };
  }

  // Modification: mod [id] <hints>
  if (cmd === "mod") {
    return modifyEntity(args, ctx);
  }

  // Ask: ask <question>
  if (cmd === "ask") {
    if (!argStr) return { error: "Usage: ask <question>" };
    return askQuestion(argStr, ctx);
  }

  // Scene: scene <description>
  if (cmd === "scene") {
    if (!argStr) return { error: "Usage: scene <description>" };
    return runScene(argStr, ctx);
  }

  // Talk mode: /talk [npc]
  if (cmd === "/talk") {
    if (!argStr) {
      if (isAtNpc(ctx.state)) {
        return { output: "(Entering talk mode with current NPC)", enterTalkMode: true };
      }
      return { error: "Usage: /talk <npc name>" };
    }
    const result = await navigateToNpc(argStr, ctx);
    if (result.error) return result;
    return { ...result, enterTalkMode: true };
  }

  // Director mode: /director
  if (cmd === "/director") {
    return { output: "(Entering director mode. Use natural language.)" };
  }

  // Campaign settings: /init
  if (cmd === "/init" || cmd === "/setup") {
    return { runOnboarding: true };
  }

  // Token usage: /tokens
  if (cmd === "/tokens") {
    if (!ctx.getTokens) {
      return { output: "(Token tracking not available)" };
    }
    const tokens = ctx.getTokens();
    const formatNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return {
      output: `Session tokens: ${formatNum(tokens.totalTokens)} total (${formatNum(tokens.promptTokens)} prompt, ${formatNum(tokens.completionTokens)} completion)`,
    };
  }

  // Model switching: /model
  if (cmd === "/model") {
    return handleModelCommand(argStr, ctx);
  }

  // Generation model switching: /genmodel
  if (cmd === "/genmodel") {
    return handleGenModelCommand(argStr, ctx);
  }

  // Unknown command
  if (cmd) {
    return { error: `Unknown command: ${cmd}. Type 'help' for commands.` };
  }

  return {};
}

// Navigation helpers
async function navigateToLocation(name: string, ctx: CommandContext): Promise<CommandResult> {
  const cur = currentRef(ctx.state);

  // If at burg, look for location
  if (cur.kind === "burg") {
    const locations = ctx.canon.listEntities({
      type: "location",
      anchors: { burgId: cur.burgId },
      limit: 100,
    });
    const match = findByName(name, locations);
    if (match) {
      navigateTo(ctx.state, { kind: "location", locationId: match.id });
      return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
    }
  }

  // Try as burg
  const burgId = ctx.world.resolveBurgId(name);
  if (burgId !== undefined) {
    navigateTo(ctx.state, { kind: "burg", burgId });
    return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
  }

  // Try as location anywhere
  const allLocations = ctx.canon.listEntities({ type: "location", limit: 500 });
  const locMatch = findByName(name, allLocations);
  if (locMatch) {
    const burgId = locMatch.anchors?.burgId as number | undefined;
    const newStack: EntityRef[] = [{ kind: "world" }];
    if (burgId !== undefined) {
      const burg = ctx.world.getBurg(burgId);
      if (burg?.state) {
        newStack.push({ kind: "state", stateId: burg.state });
      }
      newStack.push({ kind: "burg", burgId });
    }
    newStack.push({ kind: "location", locationId: locMatch.id });
    setStack(ctx.state, newStack);
    return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
  }

  return { error: `Location not found: ${name}` };
}

async function navigateToState(name: string, ctx: CommandContext): Promise<CommandResult> {
  const stateId = ctx.world.resolveStateId(name);
  if (stateId === undefined) {
    return { error: `State not found: ${name}` };
  }
  // States are top-level, so reset stack instead of pushing
  setStack(ctx.state, [{ kind: "world" }, { kind: "state", stateId }]);
  return { output: `Now at: ${stackToPath(ctx.state, ctx.world, ctx.canon)}` };
}

async function navigateToNpc(name: string, ctx: CommandContext): Promise<CommandResult> {
  const burgId = currentBurgId(ctx.state);
  const locationId = currentLocationId(ctx.state);

  // Search for NPC
  let npcs: CanonEntity[];
  if (locationId) {
    const rels = ctx.canon.listRelations({ entity_id: locationId, limit: 200 });
    const npcIds = rels.filter(r => r.rel_type === "located_at" && r.to_id === locationId).map(r => r.from_id);
    npcs = npcIds.map(id => ctx.canon.getEntity(id)).filter((e): e is CanonEntity => e?.type === "npc");
  } else if (burgId !== undefined) {
    npcs = ctx.canon.listEntities({ type: "npc", anchors: { burgId }, limit: 100 });
  } else {
    npcs = ctx.canon.listEntities({ type: "npc", limit: 200 });
  }

  const match = findByName(name, npcs);
  if (match) {
    navigateTo(ctx.state, { kind: "npc", npcId: match.id });
    return { output: `Now at: [${match.name}]` };
  }

  return { error: `NPC not found: ${name}` };
}

async function navigateToAny(name: string, ctx: CommandContext): Promise<CommandResult> {
  // Try state, burg, location, npc in order
  const stateId = ctx.world.resolveStateId(name);
  if (stateId !== undefined) {
    navigateTo(ctx.state, { kind: "state", stateId });
    return {};
  }

  const burgId = ctx.world.resolveBurgId(name);
  if (burgId !== undefined) {
    navigateTo(ctx.state, { kind: "burg", burgId });
    return {};
  }

  // Try location
  const locations = ctx.canon.listEntities({ type: "location", limit: 500 });
  const loc = findByName(name, locations);
  if (loc) {
    navigateTo(ctx.state, { kind: "location", locationId: loc.id });
    return {};
  }

  // Try NPC
  const npcs = ctx.canon.listEntities({ type: "npc", limit: 500 });
  const npc = findByName(name, npcs);
  if (npc) {
    navigateTo(ctx.state, { kind: "npc", npcId: npc.id });
    return {};
  }

  return { error: `Not found: ${name}` };
}

// Search across world and canon
function searchEntities(term: string, ctx: CommandContext): CommandResult {
  const worldResults = ctx.world.search(term, undefined, 20);
  const canonResults: Array<{ score: number; kind: string; name: string; id: string }> = [];

  // Search canon entities
  const canonEntities = ctx.canon.listEntities({ text: term, limit: 50 });
  for (const e of canonEntities) {
    const nameLower = e.name.toLowerCase();
    const termLower = term.toLowerCase();
    let score = 0;
    if (nameLower === termLower) score = 1.0;
    else if (nameLower.startsWith(termLower)) score = 0.9;
    else if (nameLower.includes(termLower)) score = 0.7;
    else score = 0.5;

    canonResults.push({ score, kind: e.type, name: e.name, id: e.id });
  }

  // Combine and sort
  const all = [
    ...worldResults.map(r => ({ score: r.score, kind: r.kind, name: r.name, id: String(r.id) })),
    ...canonResults,
  ];
  all.sort((a, b) => b.score - a.score);

  if (all.length === 0) {
    return { output: `No results for: ${term}` };
  }

  const lines = all.slice(0, 20).map(r => {
    const scoreStr = (r.score * 100).toFixed(0).padStart(3);
    return `  ${scoreStr}%  ${r.name.padEnd(25)} (${r.kind})  ${r.id}`;
  });

  return { output: `Search results for "${term}":\n${lines.join("\n")}` };
}

// Delete entity
function deleteEntity(idOrEmpty: string, ctx: CommandContext): CommandResult {
  const entityId = idOrEmpty || getCurrentEntityId(ctx.state);
  if (!entityId) return { error: "No entity selected. Usage: rm <id>" };

  const entity = ctx.canon.getEntity(entityId);
  if (!entity) {
    return { error: `Entity not found: ${entityId}` };
  }

  const deleted = ctx.canon.deleteEntity(entityId);
  if (deleted) {
    // If we deleted current entity, navigate up
    const cur = currentRef(ctx.state);
    if ((cur.kind === "location" && cur.locationId === entityId) ||
        (cur.kind === "npc" && cur.npcId === entityId)) {
      navigateUp(ctx.state);
    }
    return { output: `Deleted: ${entity.name} (${entityId})` };
  }
  return { error: `Failed to delete: ${entityId}` };
}

// Smart generation with planning and permission prompt
async function runSmartGeneration(
  genType: "location" | "npc" | "faction",
  kindHint: string | undefined,
  prompt: string,
  ctx: CommandContext
): Promise<CommandResult> {
  const genCtx: GenContext = {
    state: ctx.state,
    world: ctx.world,
    canon: ctx.canon,
    llm: ctx.llm,
    generationLlm: ctx.generationLlm,
    campaignSettings: ctx.campaignSettings,
    onToolCall: ctx.onToolCall,
    onToolResult: ctx.onToolResult,
    onTokens: ctx.onTokens,
    onEntityStart: ctx.onEntityStart,
    onEntityComplete: ctx.onEntityComplete,
  };

  try {
    // Phase 1: Planning
    const plan = await planGeneration(prompt, genType, kindHint, genCtx);

    // Phase 2: Show permission prompt
    const approval = formatPlanForApproval(plan, ctx.useColors);

    // TUI Mode: Return plan for TUI approval instead of console output
    if (ctx.tuiMode) {
      return {
        pendingGeneration: {
          plan,
          formattedPlan: approval,
          genType,
          kindHint,
          prompt,
        },
      };
    }

    // Non-TUI: Use console and selectPrompt
    console.log(approval);

    // Ask for user approval with arrow-key selection
    const answer = await selectPrompt({
      message: "What would you like to do?",
      options: [
        { label: "Create", value: "create", hint: "Generate the planned entities" },
        { label: "Cancel", value: "cancel", hint: "Abort without creating anything" },
        { label: "Edit", value: "edit", hint: "Modify hints and try again" },
      ],
      useColors: ctx.useColors,
      defaultIndex: 0,
    });

    if (answer === null || answer === "cancel") {
      return { output: "(Cancelled)" };
    }

    if (answer === "edit") {
      return { output: "(Edit mode not yet implemented. Run the command again with modified hints.)" };
    }

    // Phase 3: Execute generation
    const result = await executeGeneration(plan, genCtx);

    // Phase 4: Sync navigation to new location
    syncNavigationFromChatState(genCtx);

    const green = ctx.useColors ? GREEN : "";
    const reset = ctx.useColors ? RESET : "";
    return { output: `${green}${result.summary}${reset}` };
  } catch (e: any) {
    return { error: `Generation failed: ${e?.message || String(e)}` };
  }
}

/**
 * Execute a pending generation after TUI approval
 */
export async function executePendingGeneration(
  plan: GenPlan,
  ctx: CommandContext
): Promise<CommandResult> {
  const genCtx: GenContext = {
    state: ctx.state,
    world: ctx.world,
    canon: ctx.canon,
    llm: ctx.llm,
    generationLlm: ctx.generationLlm,
    campaignSettings: ctx.campaignSettings,
    onToolCall: ctx.onToolCall,
    onToolResult: ctx.onToolResult,
    onTokens: ctx.onTokens,
    onEntityStart: ctx.onEntityStart,
    onEntityComplete: ctx.onEntityComplete,
  };

  try {
    const result = await executeGeneration(plan, genCtx);
    syncNavigationFromChatState(genCtx);

    const green = ctx.useColors ? GREEN : "";
    const reset = ctx.useColors ? RESET : "";
    return { output: `${green}${result.summary}${reset}` };
  } catch (e: any) {
    return { error: `Generation failed: ${e?.message || String(e)}` };
  }
}

/**
 * Execute a pending modification after TUI approval
 */
export function executePendingModification(
  plan: ModPlan,
  ctx: CommandContext
): CommandResult {
  const genCtx: GenContext = {
    state: ctx.state,
    world: ctx.world,
    canon: ctx.canon,
    llm: ctx.llm,
    generationLlm: ctx.generationLlm,
    campaignSettings: ctx.campaignSettings,
    onToolCall: ctx.onToolCall,
    onToolResult: ctx.onToolResult,
    onTokens: ctx.onTokens,
  };

  const result = executeModification(plan, genCtx);

  if (!result.success) {
    return { error: result.error || "Modification failed" };
  }

  const green = ctx.useColors ? GREEN : "";
  const reset = ctx.useColors ? RESET : "";
  return {
    output: `${green}${result.summary}${reset}\n` +
      (result.appliedChanges.length > 0 ? result.appliedChanges.map(c => `  + ${c}`).join("\n") : "  (no changes)"),
  };
}

// Simple generation commands (legacy single-shot behavior)
async function generateLocation(kind: string, hints: string, ctx: CommandContext): Promise<CommandResult> {
  const burgId = currentBurgId(ctx.state);
  if (burgId === undefined) {
    return { error: "Navigate to a burg first (use: loc <burg name>)" };
  }

  const genLlm = ctx.generationLlm || ctx.llm;
  const burg = ctx.world.getBurg(burgId);
  const state = typeof burg?.state === "number" ? ctx.world.getState(burg.state) : undefined;

  // Get active events for context
  const events = ctx.canon.getActiveEvents({ burgId, stateId: state?.id, recencyDays: 90 });
  const eventContext = events.map(e => ({
    name: e.name,
    scope: e.payload?.scope,
    severity: e.payload?.severity,
    daysAgo: e.payload?.daysAgo,
    summary: e.summary,
  }));

  const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} location for a fantasy city.
Output ONLY valid JSON matching this structure:
{
  "location": { "name": string, "summary": string, "details_md": string, "tags": string[], "payload": { "kind": string } },
  "npcs": [{ "name": string, "summary": string, "tags": string[] }],
  "narration": string
}`;

  const userPrompt = {
    kind,
    hints: hints || null,
    burg: { id: burg?.id, name: burg?.name, population: burg?.population ?? burg?.pop },
    state: state ? { id: state.id, name: state.name } : null,
    activeEvents: eventContext.length > 0 ? eventContext : null,
  };

  try {
    const result = await completeJson(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
      maxTokens: 3000,
      temperature: 0.7,
    }) as any;

    // Persist location
    const locEntity = ctx.canon.addEntity({
      type: "location",
      name: result.location?.name || `New ${kind}`,
      summary: result.location?.summary,
      details_md: result.location?.details_md,
      tags: result.location?.tags || [kind],
      anchors: { burgId },
      payload: result.location?.payload || { kind },
      provenance: { generated_by: "azbrowse", provider: genLlm.provider, model: genLlm.model },
    });

    // Persist NPCs
    const npcSummaries: string[] = [];
    for (const npc of result.npcs || []) {
      const npcEntity = ctx.canon.addEntity({
        type: "npc",
        name: npc.name,
        summary: npc.summary,
        tags: npc.tags || [],
        anchors: { burgId },
        payload: npc.payload || {},
        provenance: { generated_by: "azbrowse", provider: genLlm.provider, model: genLlm.model },
      });
      ctx.canon.addRelation({
        from_id: npcEntity.id,
        to_id: locEntity.id,
        rel_type: "located_at",
      });
      npcSummaries.push(`  - ${npc.name} (${npcEntity.id})`);
    }

    // Navigate to new location
    navigateTo(ctx.state, { kind: "location", locationId: locEntity.id });

    const green = ctx.useColors ? GREEN : "";
    const reset = ctx.useColors ? RESET : "";
    const output = [
      `${green}Created: ${locEntity.name}${reset} (${locEntity.id})`,
      ...(npcSummaries.length > 0 ? ["NPCs:", ...npcSummaries] : []),
      "",
      result.narration || "",
    ].join("\n");

    return { output };
  } catch (e: any) {
    return { error: `Generation failed: ${e?.message || String(e)}` };
  }
}

async function generateNpcs(hints: string, ctx: CommandContext): Promise<CommandResult> {
  const burgId = currentBurgId(ctx.state);
  if (burgId === undefined) {
    return { error: "Navigate to a burg first" };
  }

  const locationId = currentLocationId(ctx.state);
  const genLlm = ctx.generationLlm || ctx.llm;

  // Get existing factions in burg for potential membership
  const factions = ctx.canon.listEntities({ type: "faction", anchors: { burgId }, limit: 10 });
  const factionInfo = factions.map(f => ({ id: f.id, name: f.name, kind: f.payload?.kind }));

  const systemPrompt = `You are a tabletop GM assistant. Generate 3 detailed NPCs for a fantasy setting.
Output ONLY valid JSON:
{
  "npcs": [{
    "name": "Full Name",
    "summary": "One-line public description",
    "tags": ["role", "trait"],
    "payload": {
      "role": "their job/role",
      "personality": "key traits",
      "appearance": "physical description",
      "knows": {
        "public": ["facts they share freely"],
        "secret": ["things they know but hide"]
      },
      "secrets": ["personal secrets about themselves"],
      "motivations": ["what drives them"],
      "factionId": "optional faction ID if member",
      "factionRole": "member|senior|leader",
      "factionSecret": false
    }
  }]
}`;

  const userPrompt = {
    hints: hints || null,
    burgId,
    locationId,
    availableFactions: factionInfo.length > 0 ? factionInfo : null,
    instructions: "Create interesting NPCs with secrets and motivations. Some may be faction members.",
  };

  try {
    const result = await completeJson(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
      maxTokens: 4000,
      temperature: 0.7,
    }) as any;

    const lines: string[] = [];
    for (const npc of result.npcs || []) {
      const npcEntity = ctx.canon.addEntity({
        type: "npc",
        name: npc.name,
        summary: npc.summary,
        tags: npc.tags || [],
        anchors: { burgId },
        payload: npc.payload || {},
        provenance: { generated_by: "azbrowse" },
      });

      // Link to location if provided
      if (locationId) {
        ctx.canon.addRelation({ from_id: npcEntity.id, to_id: locationId, rel_type: "located_at" });
      }

      // Create faction membership relation if specified
      const payload = npc.payload || {};
      let factionNote = "";
      if (payload.factionId && typeof payload.factionId === "string") {
        const faction = ctx.canon.getEntity(payload.factionId);
        if (faction && faction.type === "faction") {
          const relType = payload.factionRole === "leader" ? "leads" : "member_of";
          const strength = payload.factionRole === "leader" ? 1.0 :
                          payload.factionRole === "senior" ? 0.8 : 0.5;
          const notes = payload.factionSecret ? "secret" : undefined;

          ctx.canon.addRelation({
            from_id: npcEntity.id,
            to_id: faction.id,
            rel_type: relType,
            strength,
            notes,
          });
          factionNote = ` [${faction.name}${payload.factionSecret ? " (secret)" : ""}]`;
        }
      }

      lines.push(`  - ${npc.name} (${npcEntity.id})${factionNote}`);
    }

    return { output: `Generated NPCs:\n${lines.join("\n")}` };
  } catch (e: any) {
    return { error: `Generation failed: ${e?.message || String(e)}` };
  }
}

async function generateFaction(kind: string, hints: string, ctx: CommandContext): Promise<CommandResult> {
  const burgId = currentBurgId(ctx.state);
  const genLlm = ctx.generationLlm || ctx.llm;

  const systemPrompt = `You are a tabletop GM assistant. Generate a ${kind} faction.
Output ONLY valid JSON: { "faction": { "name": string, "summary": string, "tags": string[], "payload": { "kind": string } } }`;

  const userPrompt = { kind, hints: hints || null, burgId };

  try {
    const result = await completeJson(genLlm, {
      system: systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(userPrompt) }],
      maxTokens: 1500,
      temperature: 0.7,
    }) as any;

    const faction = result.faction;
    const entity = ctx.canon.addEntity({
      type: "faction",
      name: faction?.name || `New ${kind}`,
      summary: faction?.summary,
      tags: faction?.tags || [kind],
      anchors: burgId !== undefined ? { burgId } : {},
      payload: faction?.payload || { kind },
      provenance: { generated_by: "azbrowse" },
    });

    const green = ctx.useColors ? GREEN : "";
    const reset = ctx.useColors ? RESET : "";
    return { output: `${green}Created: ${entity.name}${reset} (${entity.id})` };
  } catch (e: any) {
    return { error: `Generation failed: ${e?.message || String(e)}` };
  }
}

// Modification command with two-phase planning and approval
async function modifyEntity(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let entityId: string | undefined;
  let hints: string;

  // Check if first arg is an entity ID
  if (args.length > 0 && (args[0].includes("_") || ctx.canon.getEntity(args[0]))) {
    entityId = args[0];
    hints = args.slice(1).join(" ");
  } else {
    entityId = getCurrentEntityId(ctx.state);
    hints = args.join(" ");
  }

  if (!entityId) return { error: "No entity selected. Usage: mod [id] <hints>" };
  if (!hints) return { error: "Please provide modification hints" };

  const entity = ctx.canon.getEntity(entityId);
  if (!entity) return { error: `Entity not found: ${entityId}` };

  const genCtx: GenContext = {
    state: ctx.state,
    world: ctx.world,
    canon: ctx.canon,
    llm: ctx.llm,
    generationLlm: ctx.generationLlm,
    campaignSettings: ctx.campaignSettings,
    onToolCall: ctx.onToolCall,
    onToolResult: ctx.onToolResult,
    onTokens: ctx.onTokens,
  };

  try {
    // Phase 1: Planning
    const plan = await planModification(entityId, hints, genCtx);

    if (plan.changes.length === 0) {
      return { output: "(No changes proposed)" };
    }

    // Phase 2: Show permission prompt
    const approval = formatModPlanForApproval(plan, entity, ctx.useColors);

    // TUI Mode: Return plan for TUI approval instead of console output
    if (ctx.tuiMode) {
      return {
        pendingModification: {
          plan,
          formattedPlan: approval,
        },
      };
    }

    // Non-TUI: Use console and selectPrompt
    console.log(approval);

    // Ask for user approval with arrow-key selection
    const answer = await selectPrompt({
      message: "What would you like to do?",
      options: [
        { label: "Apply", value: "apply", hint: "Apply the modifications" },
        { label: "Cancel", value: "cancel", hint: "Abort without changing anything" },
      ],
      useColors: ctx.useColors,
      defaultIndex: 0,
    });

    if (answer === null || answer === "cancel") {
      return { output: "(Cancelled)" };
    }

    // Phase 3: Execute modification
    const result = executeModification(plan, genCtx);

    if (!result.success) {
      return { error: result.error || "Modification failed" };
    }

    const green = ctx.useColors ? GREEN : "";
    const reset = ctx.useColors ? RESET : "";
    return {
      output: `${green}${result.summary}${reset}\n` +
        (result.appliedChanges.length > 0 ? result.appliedChanges.map(c => `  + ${c}`).join("\n") : "  (no changes)"),
    };
  } catch (e: any) {
    return { error: `Modification failed: ${e?.message || String(e)}` };
  }
}

// Ask question with context
async function askQuestion(question: string, ctx: CommandContext): Promise<CommandResult> {
  const current = getCurrentEntity(ctx.state, ctx.world, ctx.canon);

  const context = current ? `Current context: ${current.kind} "${current.entity?.name || "unknown"}"` : "";

  const result = await ctx.llm.complete({
    system: `You are a helpful tabletop RPG assistant. Answer questions about the world and canon entities. ${context}`,
    messages: [{ role: "user", content: question }],
    maxTokens: 500,
    temperature: 0.7,
  });

  return { output: result.text };
}

// Run scene through director
async function runScene(description: string, ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await directScene({
      llm: ctx.llm,
      generationLlm: ctx.generationLlm,
      world: ctx.world,
      canon: ctx.canon,
      state: ctx.state.chatState,
      userText: description,
      campaignSettings: ctx.campaignSettings,
      onToolCall: ctx.onToolCall,
      onToolResult: ctx.onToolResult,
    });

    ctx.state.chatState = result.state;
    return { output: result.reply, scene: result.scene };
  } catch (e: any) {
    return { error: `Scene failed: ${e?.message || String(e)}` };
  }
}

// Helper: find entity by name with fuzzy matching
function findByName(name: string, entities: CanonEntity[]): CanonEntity | undefined {
  const q = name.trim().toLowerCase();
  const exact = entities.find(e => e.name.toLowerCase() === q);
  if (exact) return exact;

  const starts = entities.find(e => e.name.toLowerCase().startsWith(q));
  if (starts) return starts;

  const names = entities.map(e => e.name.toLowerCase());
  const fuzzy = bestFuzzyMatch(q, names, 0.6);
  if (fuzzy) {
    return entities.find(e => e.name.toLowerCase() === fuzzy);
  }

  return undefined;
}

// Helper: get current entity ID
function getCurrentEntityId(state: BrowseState): string | undefined {
  const cur = currentRef(state);
  if (cur.kind === "location") return cur.locationId;
  if (cur.kind === "npc") return cur.npcId;
  return undefined;
}

// Formatting helpers
function formatWorldInfo(world: AzgaarWorld, canon: CanonStore, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  const counts = world.counts();
  const canonCounts = {
    entities: canon.listEntities({ limit: 100000 }).length,
    relations: canon.listRelations({ limit: 200000 }).length,
  };
  return [
    `${bold}World Overview${reset}`,
    `  States: ${counts.states}`,
    `  Burgs: ${counts.burgs}`,
    `  Cultures: ${counts.cultures}`,
    `  Religions: ${counts.religions}`,
    `  Rivers: ${counts.rivers}`,
    "",
    `${bold}Canon${reset}`,
    `  Entities: ${canonCounts.entities}`,
    `  Relations: ${canonCounts.relations}`,
  ].join("\n");
}

function formatStateInfo(state: any, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  if (!state) return "(no state)";
  return [
    `${bold}${state.name}${reset}`,
    `  ID: ${state.id}`,
    `  Form: ${state.formName || state.form || "unknown"}`,
    state.color ? `  Color: ${state.color}` : "",
  ].filter(Boolean).join("\n");
}

function formatBurgInfo(burg: any, world: AzgaarWorld, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  if (!burg) return "(no burg)";
  const state = typeof burg.state === "number" ? world.getState(burg.state) : undefined;
  return [
    `${bold}${burg.name}${reset}`,
    `  ID: ${burg.id}`,
    `  Population: ${burg.population ?? burg.pop ?? "?"}`,
    `  State: ${state?.name || "(none)"}`,
    burg.capital ? "  Capital: yes" : "",
    burg.port ? "  Port: yes" : "",
  ].filter(Boolean).join("\n");
}

function formatLocationInfo(loc: CanonEntity | undefined, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  if (!loc) return "(no location)";
  return [
    `${bold}${loc.name}${reset}`,
    `  ID: ${loc.id}`,
    `  Kind: ${loc.payload?.kind || "unknown"}`,
    loc.summary ? `  Summary: ${loc.summary}` : "",
    loc.tags?.length ? `  Tags: ${loc.tags.join(", ")}` : "",
    loc.details_md ? `\n${loc.details_md}` : "",
  ].filter(Boolean).join("\n");
}

function formatNpcInfo(npc: CanonEntity | undefined, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  if (!npc) return "(no NPC)";
  return [
    `${bold}${npc.name}${reset}`,
    `  ID: ${npc.id}`,
    npc.summary ? `  Summary: ${npc.summary}` : "",
    npc.tags?.length ? `  Tags: ${npc.tags.join(", ")}` : "",
    npc.details_md ? `\n${npc.details_md}` : "",
  ].filter(Boolean).join("\n");
}

function formatEntityInfo(entity: CanonEntity, useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const reset = useColors ? RESET : "";
  return [
    `${bold}${entity.name}${reset} (${entity.type})`,
    `  ID: ${entity.id}`,
    entity.summary ? `  Summary: ${entity.summary}` : "",
    entity.tags?.length ? `  Tags: ${entity.tags.join(", ")}` : "",
    Object.keys(entity.payload || {}).length > 0 ? `  Payload: ${JSON.stringify(entity.payload)}` : "",
    entity.details_md ? `\n${entity.details_md}` : "",
  ].filter(Boolean).join("\n");
}

// Model command handler
async function handleModelCommand(argStr: string, ctx: CommandContext): Promise<CommandResult> {
  // No args: show current
  if (!argStr) {
    const lines = [`Chat:       ${ctx.llm.provider}/${ctx.llm.model}`];
    if (ctx.generationLlm) {
      lines.push(`Generation: ${ctx.generationLlm.provider}/${ctx.generationLlm.model}`);
    } else {
      lines.push(`Generation: (using chat model)`);
    }
    return { output: lines.join("\n") };
  }

  // List available
  if (argStr === "list") {
    const lines: string[] = ["Fetching available models...\n"];

    // Ollama
    lines.push("ollama:");
    const ollamaModels = await listModels("ollama");
    if (ollamaModels.length === 0) {
      lines.push("  (none found - is Ollama running?)");
    } else {
      for (const m of ollamaModels) {
        const sizeStr = m.size ? ` (${m.size})` : "";
        lines.push(`  ${m.id}${sizeStr}`);
      }
    }

    // OpenAI
    lines.push("\nopenai:");
    const openaiModels = await listModels("openai");
    if (openaiModels.length === 0) {
      lines.push("  (no API key or failed to fetch)");
    } else {
      for (const m of openaiModels.slice(0, 15)) {
        lines.push(`  ${m.id}`);
      }
      if (openaiModels.length > 15) {
        lines.push(`  ... and ${openaiModels.length - 15} more`);
      }
    }

    // Anthropic
    lines.push("\nanthropic:");
    const anthropicModels = await listModels("anthropic");
    for (const m of anthropicModels) {
      lines.push(`  ${m.id}`);
    }

    return { output: lines.join("\n") };
  }

  // Parse provider/model
  const parts = argStr.split("/", 2);
  const newProvider = parts[0] as LLMProviderName;
  const newModel = parts[1]; // may be undefined

  if (!["ollama", "openai", "anthropic"].includes(newProvider)) {
    return { error: `Unknown provider: ${newProvider}. Use: ollama, openai, anthropic` };
  }

  // Validate API key requirements
  const validationError = validateProviderSwitch(newProvider);
  if (validationError) {
    return { error: `Cannot switch: ${validationError}` };
  }

  if (!ctx.config || !ctx.onConfigChange || !ctx.onLlmChange) {
    return { error: "Model switching not available (no config context)" };
  }

  try {
    // Determine effective model
    const effectiveModel = newModel || getEffectiveModel(ctx.config, newProvider);

    // Create new client
    const newLlm = createLLMClient({ provider: newProvider, model: effectiveModel });

    // Update and save config
    const newConfig: LLMConfig = {
      ...ctx.config,
      provider: newProvider,
      models: {
        ...ctx.config.models,
        [newProvider]: effectiveModel,
      },
    };
    await saveConfig(newConfig);

    // Hot-swap via callbacks
    ctx.onConfigChange(newConfig);
    ctx.onLlmChange(newLlm);
    if (ctx.setStatusBarProvider) {
      ctx.setStatusBarProvider(newLlm.provider, newLlm.model);
    }

    return { output: `Chat model: ${newLlm.provider}/${newLlm.model}` };
  } catch (e: any) {
    return { error: `Failed to switch: ${e?.message ?? String(e)}` };
  }
}

// Generation model command handler
async function handleGenModelCommand(argStr: string, ctx: CommandContext): Promise<CommandResult> {
  // Disable separate generation model
  if (argStr === "off" || argStr === "none" || argStr === "disable") {
    if (!ctx.config || !ctx.onConfigChange || !ctx.onGenerationLlmChange) {
      return { error: "Model switching not available (no config context)" };
    }

    const newConfig: LLMConfig = {
      ...ctx.config,
      generationProvider: undefined,
      generationModels: undefined,
    };
    await saveConfig(newConfig);
    ctx.onConfigChange(newConfig);
    ctx.onGenerationLlmChange(undefined);
    return { output: "Generation model disabled (using chat model)" };
  }

  // No args: show current
  if (!argStr) {
    if (ctx.generationLlm) {
      return { output: `Generation: ${ctx.generationLlm.provider}/${ctx.generationLlm.model}` };
    } else {
      return { output: `Generation: (using chat model: ${ctx.llm.provider}/${ctx.llm.model})` };
    }
  }

  // Parse provider/model
  const parts = argStr.split("/", 2);
  const newProvider = parts[0] as LLMProviderName;
  const newModel = parts[1];

  if (!["ollama", "openai", "anthropic"].includes(newProvider)) {
    return { error: `Unknown provider: ${newProvider}. Use: ollama, openai, anthropic` };
  }

  const validationError = validateProviderSwitch(newProvider);
  if (validationError) {
    return { error: `Cannot switch: ${validationError}` };
  }

  if (!ctx.config || !ctx.onConfigChange || !ctx.onGenerationLlmChange) {
    return { error: "Model switching not available (no config context)" };
  }

  try {
    const effectiveModel = newModel || getEffectiveGenerationModel(ctx.config, newProvider);
    const newGenLlm = createLLMClient({ provider: newProvider, model: effectiveModel });

    // Update and save config
    const newConfig: LLMConfig = {
      ...ctx.config,
      generationProvider: newProvider,
      generationModels: {
        ...ctx.config.generationModels,
        [newProvider]: effectiveModel,
      },
    };
    await saveConfig(newConfig);

    ctx.onConfigChange(newConfig);
    ctx.onGenerationLlmChange(newGenLlm);

    return { output: `Generation model: ${newGenLlm.provider}/${newGenLlm.model}` };
  } catch (e: any) {
    return { error: `Failed to switch: ${e?.message ?? String(e)}` };
  }
}

// Help text
function helpText(useColors?: boolean): string {
  const bold = useColors ? BOLD : "";
  const cyan = useColors ? CYAN : "";
  const reset = useColors ? RESET : "";
  return `
${bold}azbrowse - World Navigation CLI${reset}

${cyan}Navigation${reset}
  loc [name]         Navigate to burg or location (no arg = show current)
  loc ..             Navigate up one level
  state [name]       Navigate to state
  npc [name]         Focus on NPC
  cd <path>          Navigate using path syntax
  back               Return to previous location
  pwd                Print current path

${cyan}Listing${reset}
  ls                 List contents at current level
  ls burgs           Burgs in state (or all if at root)
  ls locations       Locations in current burg
  ls npcs            NPCs at current location
  ls factions        Factions in context
  ls events          Active events affecting context

${cyan}Information${reset}
  info               Show details of current entity
  info <id>          Show details of specific entity
  rels [id]          Show relations for entity
  search <term>      Fuzzy search across world and canon

${cyan}Generation (LLM)${reset}
  gen location <kind> [hints]   Smart generation with planning & approval
  gen npc [hints]               Smart NPC generation with connections
  gen faction <kind> [hints]    Smart faction generation with context
  simplegen location <kind>     Quick generation (no planning step)
  simplegen npc [hints]         Quick NPC generation
  simplegen faction <kind>      Quick faction generation

${cyan}Modification${reset}
  mod <hints>        Modify current entity with natural language
  mod <id> <hints>   Modify specific entity

${cyan}Deletion${reset}
  rm                 Delete current entity (canon only)
  rm <id>            Delete specific entity
  unlink <id>        Remove relation by ID

${cyan}LLM/Chat${reset}
  ask <question>     Ask about current context
  scene <desc>       Run director for scene description
  /talk [npc]        Enter NPC roleplay mode
  /back              Exit roleplay mode

${cyan}Settings${reset}
  /init              Configure campaign settings (vibe, quest, tone, rating)
  /tokens            Show session token usage
  /model             Show current LLM provider/model (chat + generation)
  /model list        List available providers and models
  /model <p>/<m>     Switch chat model (e.g., /model openai/gpt-4o)
  /genmodel <p>/<m>  Switch generation model (e.g., /genmodel anthropic/claude-sonnet-4-5-20250929)
  /genmodel off      Use chat model for generation (disable separate model)

${cyan}Other${reset}
  help               Show this help
  exit               Quit
`.trim();
}
