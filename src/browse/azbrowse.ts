/**
 * azbrowse - File-system-like navigation through world and canon entities
 *
 * Entry point and REPL loop for the browsable world navigation CLI.
 * Supports both readline REPL mode (default) and full-screen TUI mode (--tui).
 */

import readline from "node:readline";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { createLLMClient, type LLMProviderName, type TokenUsage } from "../llm/providers";
import {
  loadConfig,
  getEffectiveProvider,
  getEffectiveModel,
  getEffectiveGenerationProvider,
  getEffectiveGenerationModel,
  getEffectiveTalkProvider,
  getEffectiveTalkModel,
  type LLMConfig,
} from "../llm/config";
import { kickOffIdeaLabeling } from "../canon/idea-labeler";
import { extractGlobals } from "../util/args";
import { getCampaignSettings, runOnboarding, GenerationFlags, OnboardingResult } from "../chat/campaign-settings";
import { CampaignSettings } from "../chat/schema";
import {
  generateStateContent,
  generateReligionContent,
  generateCultureContent,
  planWorldGeneration,
  executeWorldGeneration,
  formatWorldGenPlan,
  WorldGenContext,
  WorldGenPlan,
} from "./world-init-gen";
import { npcTurn } from "../chat/npc";
import { SceneContext } from "../chat/director";
import { StatusBar } from "../chat/status-bar";
import { initDebugLog, debugLog, debugToolCall, debugToolResult, debugTokens } from "../chat/debug-log";

import { newBrowseState, BrowseState, stackToPath, isAtNpc, currentRef, currentBurgId, currentLocationId, currentStateId, navigateTo } from "./state";
import { getPrompt, getPromptPlain } from "./prompt";
import { executeCommand, CommandContext, CommandResult } from "./commands";
import { TuiController, type TuiControllerOptions } from "./tui";

// ANSI color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

/**
 * Create a tab-completion function for the readline interface.
 */
function createCompleter(
  world: AzgaarWorld,
  canon: CanonStore,
  getState: () => BrowseState
): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const state = getState();
    const cur = currentRef(state);
    const parts = line.split(/\s+/);
    const cmd = parts[0]?.toLowerCase() || "";
    const arg = parts.slice(1).join(" ").toLowerCase();

    // Commands that need completion
    const navCommands = ["loc", "cd", "state", "npc", "talk"];

    if (!navCommands.includes(cmd)) {
      // Complete command names
      if (parts.length === 1) {
        const commands = [
          "loc", "cd", "state", "npc", "ls", "info", "rels", "search",
          "gen", "ingest", "simplegen", "mod", "rm", "unlink",
          "ask", "scene", "help", "exit", "talk", "back", "pwd",
          "init", "tokens", "model", "genmodel", "talkmodel",
          "cat",
          ":idea-add", ":idea-list", ":idea-mark-used", ":idea-rm", ":idea-relabel",
        ];
        const matches = commands.filter(c => c.startsWith(cmd));
        return [matches, cmd];
      }
      return [[], line];
    }

    // Get candidates based on command and context
    let candidates: string[] = [];

    if (cmd === "state") {
      candidates = world.listStates().map(s => s.name);
    } else if (cmd === "npc" || cmd === "talk") {
      // NPCs in current context
      const burgId = currentBurgId(state);
      const locationId = currentLocationId(state);
      let npcs;
      if (locationId) {
        const rels = canon.listRelations({ entity_id: locationId, limit: 200 });
        const npcIds = rels.filter(r => r.rel_type === "located_at" && r.to_id === locationId).map(r => r.from_id);
        npcs = npcIds.map(id => canon.getEntity(id)).filter(e => e?.type === "npc");
      } else if (burgId !== undefined) {
        npcs = canon.listEntities({ type: "npc", anchors: { burgId }, limit: 100 });
      } else {
        npcs = canon.listEntities({ type: "npc", limit: 100 });
      }
      candidates = npcs.map(n => n!.name);
    } else if (cmd === "loc" || cmd === "cd") {
      // Context-dependent: burgs, locations, or both
      if (cur.kind === "world" || cur.kind === "state") {
        // Offer burgs
        const stateId = cur.kind === "state" ? cur.stateId : undefined;
        let burgs = world.listBurgs();
        if (stateId !== undefined) {
          burgs = burgs.filter(b => b.state === stateId);
        }
        candidates = burgs.map(b => b.name);
      } else if (cur.kind === "burg") {
        // Offer locations in this burg
        const locations = canon.listEntities({
          type: "location",
          anchors: { burgId: cur.burgId },
          limit: 100,
        });
        candidates = locations.map(l => l.name);
        // Also allow navigating to other burgs
        candidates.push(...world.listBurgs().map(b => b.name));
      } else {
        // At location or npc, offer burgs and all locations
        candidates = world.listBurgs().map(b => b.name);
        const locations = canon.listEntities({ type: "location", limit: 200 });
        candidates.push(...locations.map(l => l.name));
      }
    }

    // Filter by what user has typed
    const matches = candidates.filter(c => c.toLowerCase().startsWith(arg));

    // If exact match exists, don't show completions (user may want to execute)
    if (matches.length === 1 && matches[0].toLowerCase() === arg) {
      return [[], line];
    }

    // Return full completions (cmd + completed arg)
    const completions = matches.map(m => `${cmd} ${m}`);
    return [completions, line];
  };
}

/**
 * Build a SceneContext from the current browse navigation state.
 * This provides NPCs with location awareness when in /talk mode.
 */
function buildSceneFromState(
  state: BrowseState,
  world: AzgaarWorld,
  canon: CanonStore
): SceneContext | undefined {
  const burgId = currentBurgId(state);
  if (burgId === undefined) return undefined;

  const burg = world.getBurg(burgId);
  if (!burg) return undefined;

  const stateEntity = typeof burg.state === "number" ? world.getState(burg.state) : undefined;

  const locationId = currentLocationId(state);
  const location = locationId ? canon.getEntity(locationId) : undefined;

  // Get NPCs at location (if we have one)
  let npcs: import("../canon/canon").CanonEntity[] = [];
  if (location) {
    const rels = canon.listRelations({ entity_id: location.id, limit: 200 });
    const npcIds = rels
      .filter(r => r.rel_type === "located_at" && r.to_id === location.id)
      .map(r => r.from_id);
    npcs = npcIds
      .map(id => canon.getEntity(id))
      .filter((e): e is import("../canon/canon").CanonEntity => e !== undefined && e.type === "npc");
  }

  // Get factions in burg
  const factions = canon.listEntities({
    type: "faction",
    anchors: { burgId },
    limit: 20,
  });

  return {
    burgId,
    burg,
    state: stateEntity,
    location: location?.type === "location" ? location : undefined,
    npcs,
    factions,
  };
}

function usage(): string {
  return `
azbrowse - Browsable World Navigation CLI

Usage:
  bun run azbrowse -- [options]

Options:
  --world <path>    World JSON path (default: ./data/world.json)
  --canon <path>    Canon SQLite DB path (default: ./data/canon.db)
  --tui             Enable full-screen TUI mode with tree navigation
  --no-color        Disable colored output
  --debug           Enable debug logging to ./logs/session-<timestamp>.log

TUI Mode Keys:
  j/k or arrows     Navigate tree / scroll detail
  Enter             Expand/collapse node or select
  l/h or arrows     Move between panels
  :                 Enter command mode
  q                 Quit

REPL Commands (type 'help' once running):
  loc <name>        Navigate to burg or location
  ls                List contents at current level
  gen location      Generate new location with NPCs
  ingest <file>     Parse source prose into a canon plan
  /talk <npc>       Enter NPC roleplay mode
  /init             Configure campaign settings (vibe, quest, tone)

Example:
  bun run azbrowse -- --world data/world.json --canon data/canon.db
  bun run azbrowse -- --tui    # Full-screen TUI mode
`.trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const { globals, rest } = extractGlobals(argv);

  // Check for help flag
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage());
    return;
  }

  const worldPath = globals.world || "./data/world.json";
  const canonPath = globals.canon || "./data/canon.db";
  const useColors = !rest.includes("--no-color") && process.stdout.isTTY;
  const tuiMode = rest.includes("--tui");
  const debugMode = rest.includes("--debug");

  // Initialize debug logging
  const logFile = initDebugLog(debugMode, "./logs", "azbrowse");
  if (logFile) {
    console.log(`Debug logging to: ${logFile}`);
  }

  // Load world and canon
  console.log(`Loading world: ${worldPath}`);
  const world = await AzgaarWorld.load(worldPath);
  const canon = new CanonStore(canonPath);
  canon.initDb();

  // Load LLM config (mutable for runtime model switching)
  let config: LLMConfig = await loadConfig();
  const provider = getEffectiveProvider(config);
  const model = getEffectiveModel(config, provider);
  let llm = createLLMClient({ provider, model });

  // Optional generation LLM
  let generationLlm: ReturnType<typeof createLLMClient> | undefined;
  const genProvider = getEffectiveGenerationProvider(config);
  if (genProvider) {
    const genModel = getEffectiveGenerationModel(config, genProvider);
    generationLlm = createLLMClient({ provider: genProvider, model: genModel });
  }

  // Optional talk LLM (for NPC conversations)
  let talkLlm: ReturnType<typeof createLLMClient> | undefined;
  const talkProvider = getEffectiveTalkProvider(config);
  if (talkProvider) {
    const talkModel = getEffectiveTalkModel(config, talkProvider);
    talkLlm = createLLMClient({ provider: talkProvider, model: talkModel });
  }

  // Drain any backlog of unlabeled ideas in the background.
  kickOffIdeaLabeling(canon, generationLlm ?? llm);

  // Load campaign settings if they exist
  let campaignSettings: CampaignSettings | undefined = getCampaignSettings(canon);

  // Initialize browse state
  const state = newBrowseState();

  // Initialize status bar for token tracking (disabled in TUI mode - TUI has its own footer)
  const statusBar = new StatusBar(llm.provider, llm.model, useColors && !tuiMode);

  // Display startup info
  const counts = world.counts();
  console.log(`\nazbrowse - World Navigation CLI`);
  console.log(`  World: ${counts.states} states, ${counts.burgs} burgs`);
  console.log(`  Canon: ${canon.listEntities({ limit: 100000 }).length} entities`);
  const genInfo = generationLlm ? ` (gen: ${generationLlm.provider}/${generationLlm.model})` : "";
  const talkInfo = talkLlm ? ` (talk: ${talkLlm.provider}/${talkLlm.model})` : "";
  console.log(`  LLM: ${llm.provider}/${llm.model}${genInfo}${talkInfo}`);
  console.log(`\nType 'help' for commands.\n`);

  // Create readline interface with tab completion
  const completer = createCompleter(world, canon, () => state);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Helper to run world generation based on flags (two-phase: plan then parallel execution)
  async function runWorldGeneration(flags: GenerationFlags) {
    const genLlm = generationLlm || llm;
    const genCtx: WorldGenContext = {
      world,
      canon,
      llm: genLlm,
      campaignSettings,
      onProgress: (msg) => console.log(`\n${msg}`),
      onPlanProgress: (msg) => {
        if (useColors) {
          console.log(`${DIM}${msg}${RESET}`);
        } else {
          console.log(msg);
        }
      },
      onEntityStart: (name, index, total) => {
        if (useColors) {
          console.log(`${DIM}[${index + 1}/${total}] Generating: ${name}...${RESET}`);
        }
      },
      onEntityComplete: (name, index, total, tokens, elapsedMs) => {
        const secs = (elapsedMs / 1000).toFixed(1);
        if (useColors) {
          console.log(`${GREEN}[${index + 1}/${total}] ✓ ${name}${RESET} ${DIM}(${tokens} tokens, ${secs}s)${RESET}`);
        } else {
          console.log(`[${index + 1}/${total}] Created: ${name} (${tokens} tokens, ${secs}s)`);
        }
      },
      onTokens: (usage) => statusBar.addTokens(usage),
    };

    // Check if any generation flags are set
    const hasGeneration = flags.states || flags.religions || flags.cultures;
    if (!hasGeneration) {
      console.log("No generation flags selected.");
      return;
    }

    // PHASE 1: Create generation plan
    console.log(`\n${useColors ? BOLD : ""}Phase 1: Planning generation...${useColors ? RESET : ""}`);
    let plan: WorldGenPlan;
    try {
      plan = await planWorldGeneration(genCtx, flags);
    } catch (e: any) {
      console.log(`${useColors ? RED : ""}Planning failed: ${e?.message || String(e)}${useColors ? RESET : ""}`);
      return;
    }

    // Show plan to user
    console.log("");
    console.log(formatWorldGenPlan(plan, useColors));

    // Ask for approval
    const approval = (await ask("Proceed with generation? [Y/n]: ")).trim().toLowerCase();
    if (approval === "n" || approval === "no") {
      console.log("Generation cancelled.");
      return;
    }

    // PHASE 2: Execute generation in parallel
    console.log(`\n${useColors ? BOLD : ""}Phase 2: Generating entities in parallel...${useColors ? RESET : ""}`);
    const result = await executeWorldGeneration(genCtx, plan);

    console.log(`\n${useColors ? GREEN : ""}Generation complete:${useColors ? RESET : ""}`);
    console.log(`  Created: ${result.created} entities`);

    if (result.errors.length > 0) {
      console.log(`\n${useColors ? RED : ""}Errors (${result.errors.length}):${useColors ? RESET : ""}`);
      for (const e of result.errors.slice(0, 5)) {
        console.log(`  ${e}`);
      }
      if (result.errors.length > 5) {
        console.log(`  ... and ${result.errors.length - 5} more`);
      }
    }
  }

  // Check for existing campaign settings; prompt for onboarding if missing
  if (!campaignSettings && !tuiMode) {
    const doSetup = (await ask("No campaign settings found. Configure now? [y/N]: ")).trim().toLowerCase();
    if (doSetup === "y" || doSetup === "yes") {
      const onboardingResult = await runOnboarding(rl, canon);
      campaignSettings = onboardingResult.settings;
      if (onboardingResult.generate) {
        await runWorldGeneration(onboardingResult.generate);
      }
    } else {
      console.log("(Skipped setup. Use /init anytime to configure.)\n");
    }
  } else if (!tuiMode) {
    console.log("(Campaign settings loaded.)\n");
  }

  // TUI Mode - full-screen interface
  if (tuiMode) {
    rl.close(); // Close readline for TUI mode

    // Build command context for TUI
    const commandContext: CommandContext = {
      state,
      world,
      canon,
      llm,
      generationLlm,
      talkLlm,
      campaignSettings,
      useColors,
      onToolCall: (name, args) => {
        debugToolCall(name, args);
        statusBar.toolStart(name);
      },
      onToolResult: (name, result, elapsedMs) => {
        debugToolResult(name, result, elapsedMs);
        statusBar.toolEnd();
      },
      onTokens: (usage) => {
        statusBar.addTokens(usage);
        if (usage.totalTokens) {
          debugTokens(usage as any);
        }
      },
      getTokens: () => statusBar.getTokens(),
      onEntityStart: (name, index, total) => {
        // TUI will handle progress display via its own context override
      },
      onEntityComplete: (entity, index, total, tokens, elapsedMs) => {
        // TUI will handle progress display via its own context override
      },
      config,
      onConfigChange: (newConfig) => { config = newConfig; },
      onLlmChange: (newLlm) => { llm = newLlm; },
      onGenerationLlmChange: (newGenLlm) => { generationLlm = newGenLlm; },
      onTalkLlmChange: (newTalkLlm) => { talkLlm = newTalkLlm; },
      setStatusBarProvider: (p, m) => statusBar.setProvider(p as any, m),
    };

    const tuiOptions: TuiControllerOptions = {
      world,
      canon,
      browseState: state,
      commandContext,
      useColors,
      onQuit: () => {
        statusBar.clear();
        canon.close();
      },
      onNavigate: (ref) => {
        navigateTo(state, ref);
      },
    };

    const tui = new TuiController(tuiOptions);
    await tui.start();
    return;
  }

  // Track modes
  let talkMode = false;
  let scene: SceneContext | undefined;

  // Main REPL loop (non-TUI mode)
  while (true) {
    try {
      // Get appropriate prompt
      const prompt = useColors
        ? getPrompt(state, world, canon)
        : getPromptPlain(state, world, canon);

      const line = (await ask(prompt)).trim();
      if (!line) continue;

      debugLog(`\n--- User command: ${line} ---`);

      // Handle talk mode (NPC roleplay)
      if (talkMode && !line.startsWith("/")) {
        // Send to NPC (use talk LLM if available, else generation LLM, else main LLM)
        const reply = await npcTurn({
          llm,
          talkLlm: talkLlm || generationLlm,
          world,
          canon,
          state: state.chatState,
          scene,
          userText: line,
          campaignSettings,
          onTokens: (usage) => statusBar.addTokens(usage),
        });
        console.log();
        console.log(reply);
        console.log();
        continue;
      }

      // Build command context
      const ctx: CommandContext = {
        state,
        world,
        canon,
        llm,
        generationLlm,
        talkLlm,
        campaignSettings,
        useColors,
        onToolCall: (name, args) => {
          if (useColors) {
            console.log(`${DIM}[tool] ${name}${RESET}`);
          }
          debugToolCall(name, args);
          statusBar.toolStart(name);
        },
        onToolResult: (name, result, elapsedMs) => {
          if (useColors) {
            console.log(`${DIM}[done] ${name} (${elapsedMs}ms)${RESET}`);
          }
          debugToolResult(name, result, elapsedMs);
          statusBar.toolEnd();
        },
        onTokens: (usage) => {
          statusBar.addTokens(usage);
          if (usage.totalTokens) {
            debugTokens(usage as any);
          }
        },
        getTokens: () => statusBar.getTokens(),
        // Entity generation progress
        onEntityStart: (name, index, total) => {
          if (useColors) {
            console.log(`${DIM}[${index + 1}/${total}] Generating: ${name}...${RESET}`);
          }
        },
        onEntityComplete: (entity, index, total, tokens, elapsedMs) => {
          const secs = (elapsedMs / 1000).toFixed(1);
          if (useColors) {
            console.log(`${GREEN}[${index + 1}/${total}] ✓ ${entity.name}${RESET} ${DIM}(${tokens} tokens, ${secs}s)${RESET}`);
          } else {
            console.log(`[${index + 1}/${total}] Created: ${entity.name} (${tokens} tokens, ${secs}s)`);
          }
        },
        // Model switching support
        config,
        onConfigChange: (newConfig) => { config = newConfig; },
        onLlmChange: (newLlm) => { llm = newLlm; },
        onGenerationLlmChange: (newGenLlm) => { generationLlm = newGenLlm; },
        onTalkLlmChange: (newTalkLlm) => { talkLlm = newTalkLlm; },
        setStatusBarProvider: (p, m) => statusBar.setProvider(p as any, m),
      };

      // Execute command
      const result = await executeCommand(line, ctx);

      // Handle result
      if (result.quit) {
        console.log("Goodbye!");
        break;
      }

      if (result.error) {
        console.log(useColors ? `${RED}Error: ${result.error}${RESET}` : `Error: ${result.error}`);
      }

      if (result.output) {
        console.log(result.output);
      }

      if (result.scene) {
        scene = result.scene;
      }

      if (result.enterTalkMode) {
        talkMode = true;
        // Build scene context from current navigation state
        scene = buildSceneFromState(state, world, canon);
        const cur = currentRef(state);
        if (cur.kind === "npc") {
          const npc = canon.getEntity(cur.npcId);
          const locationInfo = scene?.location ? ` at ${scene.location.name}` : "";
          const burgInfo = scene?.burg ? ` in ${scene.burg.name}` : "";
          console.log(`\n(Entering roleplay mode with ${npc?.name || "NPC"}${locationInfo}${burgInfo}. Type /back to exit.)\n`);
        }
      }

      if (result.exitTalkMode) {
        talkMode = false;
        console.log("(Exited roleplay mode.)");
      }

      if (result.runOnboarding) {
        const onboardingResult = await runOnboarding(rl, canon);
        if (onboardingResult.settings) {
          campaignSettings = onboardingResult.settings;
        }
        if (onboardingResult.generate) {
          await runWorldGeneration(onboardingResult.generate);
        }
      }

      console.log(); // Blank line for readability
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      console.log(useColors ? `${RED}Error: ${errorMsg}${RESET}` : `Error: ${errorMsg}`);
      debugLog(`[ERROR] ${errorMsg}`);
      if (e?.stack) {
        debugLog(`[STACK] ${e.stack}`);
      }
    }
  }

  // Cleanup
  statusBar.clear();
  rl.close();
  canon.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
