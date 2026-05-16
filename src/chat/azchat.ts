import readline from "node:readline";
import { homedir } from "os";
import { join } from "path";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { createLLMClient, listModels, type LLMProviderName } from "../llm/providers";
import { discoverSkills, loadSkill, SkillMetadata } from "./skills";
import {
  loadConfig,
  saveConfig,
  getEffectiveProvider,
  getEffectiveModel,
  getEffectiveGenerationProvider,
  getEffectiveGenerationModel,
  hasGenerationConfig,
  validateProviderSwitch,
  DEFAULT_MODELS,
  type LLMConfig,
} from "../llm/config";
import { exportWiki } from "../wiki/wiki";
import { kickOffIdeaLabeling } from "../canon/idea-labeler";
import { extractGlobals } from "../util/args";
import { directScene, newChatState, SceneContext } from "./director";
import { npcTurn, resolveNpcByName } from "./npc";
import { getGlobalCache, closeGlobalCache } from "../llm/cache";
import { getCampaignSettings, runOnboarding } from "./campaign-settings";
import { CampaignSettings } from "./schema";
import { initStatusBar, getStatusBar } from "./status-bar";
import {
  initDebugLog,
  setDebugEnabled,
  isDebugEnabled,
  getLogFile,
  debugToolCall,
  debugToolResult,
  debugTokens,
} from "./debug-log";
import { TuiController } from "./tui";
import { CampaignStore } from "../campaign/store";
import { runCampaignMode } from "./campaign-mode";

function helpText(skills: SkillMetadata[] = []): string {
  const lines = [
    "Commands:",
    "  /help                       Show this help",
    "  /setup                      Configure campaign settings (tone, rating, vibe)",
    "  /where                      Show current city/location",
    "  /talk <npc name>            Talk as an NPC in the current scene",
    "  /back                       Return to Director mode",
    "  /campaign [name]            Enter campaign-builder mode (resumes by name if exists)",
    "  /nav                        Enter TUI navigation mode (Ctrl+N also works)",
    "  /wiki <outDir>              Export wiki Markdown to a directory",
    "  /model                      Show current LLM provider/model (chat + generation)",
    "  /model list                 List available providers and models",
    "  /model <provider>/<model>   Switch chat model (e.g., /model openai/gpt-4o)",
    "  /genmodel <provider>/<model> Switch generation model (NPCs, locations, etc.)",
    "  /genmodel off               Use chat model for generation (disable separate model)",
    "  /cache                      Show cache statistics",
    "  /invalidate [tool]          Clear generation cache (optionally for specific tool)",
    "  /regen                      Re-run the last director query (invalidates cache first)",
    "  /tokens                     Show session token usage",
    "  /debug                      Toggle debug mode (show tool results, log to file)",
    "  /skills                     List available skills",
    "  /exit                       Quit",
    "",
    "Navigation Mode (press /nav or Ctrl+N):",
    "  j/k or arrows               Move up/down through items",
    "  Enter                       Expand tool call or select NPC",
    "  c                           Copy content to clipboard",
    "  Esc or q                    Exit navigation mode",
    "",
    "Flags:",
    "  --debug, -d                 Show tool results and token usage per call",
    "",
    "Tips:",
    "  - Try: My heroes enter a tavern in <CityName>",
    "  - Or: The party visits the miners' guild hall in <CityName>",
  ];

  if (skills.length > 0) {
    lines.push("");
    lines.push("Skills:");
    for (const s of skills) {
      const desc = s.description.length > 50 ? s.description.slice(0, 50) + "..." : s.description;
      lines.push(`  /${s.name.padEnd(22)} ${desc}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const { globals, rest } = extractGlobals(argv);

  const worldPath = globals.world || "./data/world.json";
  const canonPath = globals.canon || "./data/canon.db";
  const debugMode = argv.includes("--debug") || argv.includes("-d");
  const logFile = initDebugLog(debugMode);

  const world = await AzgaarWorld.load(worldPath);
  const canon = new CanonStore(canonPath);
  canon.initDb();

  // Load persistent config
  let config = await loadConfig();
  const initialProvider = getEffectiveProvider(config);
  const initialModel = getEffectiveModel(config, initialProvider);
  let llm = createLLMClient({ provider: initialProvider, model: initialModel });

  // Create separate generation LLM if configured
  let generationLlm: ReturnType<typeof createLLMClient> | undefined;
  const genProvider = getEffectiveGenerationProvider(config);
  if (genProvider) {
    const genModel = getEffectiveGenerationModel(config, genProvider);
    generationLlm = createLLMClient({ provider: genProvider, model: genModel });
  }

  // Drain any backlog of unlabeled ideas in the background. Never await — UI
  // should not wait for LLM calls at startup.
  kickOffIdeaLabeling(canon, generationLlm ?? llm);

  // Initialize status bar
  const statusBar = initStatusBar(llm.provider, llm.model);

  let state = newChatState();
  let scene: SceneContext | undefined;
  let mode: "director" | "npc" = "director";
  let tuiNavigating = false;

  // Create TUI controller
  const tui = new TuiController(canon, {
    onTalkToNpc: (npcId: string) => {
      state.currentNpcId = npcId;
      mode = "npc";
      const npcName = canon.getEntity(npcId)?.name ?? npcId;
      console.log(`\n(Now talking as ${npcName}.)`);
      tuiNavigating = false;
    },
    onCopyToClipboard: (_text: string) => {
      // Clipboard copy is handled internally by TuiController
    },
    onExitNavigation: () => {
      tuiNavigating = false;
      // Restore readline prompt
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    },
    onInputSubmit: (_text: string) => {
      // Not used - input handled by readline
    },
  });

  const genInfo = generationLlm ? `  gen=${generationLlm.provider}/${generationLlm.model}` : "";
  console.log("azchat (bun+ts)" + `  chat=${llm.provider}/${llm.model}` + genInfo + (debugMode ? "  [DEBUG]" : ""));
  console.log(`world=${worldPath}`);
  console.log(`canon=${canonPath}`);
  if (logFile) {
    console.log(`debug log: ${logFile}`);
  }
  console.log("Type /help for commands.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  // Check for existing campaign settings; prompt for onboarding if missing
  let campaignSettings: CampaignSettings | undefined = getCampaignSettings(canon);
  if (!campaignSettings) {
    const doSetup = (await ask("No campaign settings found. Configure now? [y/N]: ")).trim().toLowerCase();
    if (doSetup === "y" || doSetup === "yes") {
      const onboardingResult = await runOnboarding(rl, canon);
      campaignSettings = onboardingResult.settings;
    } else {
      console.log("(Skipped setup. Use /setup anytime to configure.)\n");
    }
  } else {
    console.log("(Campaign settings loaded.)\n");
  }

  // Discover skills from project and user directories
  const skillSearchPaths = [
    join(process.cwd(), "skills"),
    join(homedir(), ".azworld", "skills"),
  ];
  const skills: SkillMetadata[] = discoverSkills(skillSearchPaths);
  if (skills.length > 0) {
    console.log(`Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(", ")}`);
  }

  // Basic REPL loop
  while (true) {
    const prompt = mode === "director" ? "🎲> " : "🗣️> ";
    const line = (await ask(prompt)).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      const argStr = args.join(" ").trim();

      if (cmd === "help") {
        console.log(helpText(skills));
        continue;
      }
      if (cmd === "setup") {
        const onboardingResult = await runOnboarding(rl, canon);
        if (onboardingResult.settings) {
          campaignSettings = onboardingResult.settings;
        }
        continue;
      }
      if (cmd === "exit" || cmd === "quit") {
        break;
      }
      if (cmd === "where") {
        const burgId = state.currentBurgId;
        const locId = state.currentLocationId;
        const burg = burgId !== undefined ? world.getBurg(burgId) : undefined;
        const loc = locId ? canon.getEntity(locId) : undefined;
        console.log(
          [
            burg ? `City: ${burg.name} (burg ${burg.id})` : "City: (none)",
            loc ? `Location: ${loc.name} (${loc.id})` : "Location: (none)",
            mode === "npc" && state.currentNpcId ? `NPC: ${canon.getEntity(state.currentNpcId)?.name ?? state.currentNpcId}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
        continue;
      }
      if (cmd === "back") {
        mode = "director";
        state.currentNpcId = undefined;
        console.log("(Back to Director mode.)");
        continue;
      }
      if (cmd === "nav") {
        if (!tui.isEnabled()) {
          console.log("(TUI navigation not available in non-TTY mode)");
          continue;
        }
        if (tui.getFeedItems().length === 0) {
          console.log("(No items to navigate. Run a scene first.)");
          continue;
        }

        // Pause readline and enter navigation mode
        rl.pause();
        console.log("(Entering navigation mode. Press Esc or q to exit.)");
        tui.enterNavigationMode();

        // Wait for navigation to complete
        await new Promise<void>((resolve) => {
          if (!process.stdin.isTTY) {
            resolve();
            return;
          }

          process.stdin.setRawMode(true);
          process.stdin.resume();

          const handleKey = (key: Buffer) => {
            // Check for Ctrl+C to exit
            if (key[0] === 3) {
              cleanup();
              console.log("\n(Exited navigation mode.)");
              resolve();
              return;
            }

            tui.handleKeypress(key);

            if (!tui.isInNavigationMode()) {
              cleanup();
              console.log("(Exited navigation mode.)");
              resolve();
            }
          };

          const cleanup = () => {
            process.stdin.off("data", handleKey);
            process.stdin.setRawMode(false);
          };

          process.stdin.on("data", handleKey);
        });

        // Resume readline
        rl.resume();
        continue;
      }
      if (cmd === "talk") {
        if (!state.currentBurgId) {
          console.log("(Pick a city first: 'My heroes are in a tavern in <CityName>...')");
          continue;
        }
        if (!argStr) {
          console.log("Usage: /talk <npc name>");
          continue;
        }
        const npcId = resolveNpcByName(canon, state.currentBurgId, argStr);
        if (!npcId) {
          console.log(`(Couldn't find an NPC named '${argStr}' in canon. Try generating a tavern scene first.)`);
          continue;
        }
        state.currentNpcId = npcId;
        mode = "npc";
        console.log(`(Now talking as ${canon.getEntity(npcId)?.name ?? npcId}.)`);
        continue;
      }
      if (cmd === "wiki") {
        const outDir = argStr || "./wiki";
        const res = await exportWiki(outDir, world, canon);
        console.log(`Exported wiki to ${res.out_dir}. Entities: ${res.entities_written}, Cities: ${res.cities_written}`);
        continue;
      }
      if (cmd === "cache") {
        const cache = getGlobalCache();
        const stats = cache.stats();
        console.log(`Cache: ${stats.total} entries, ${stats.expired} expired, ${stats.totalHits} total hits`);
        continue;
      }
      if (cmd === "invalidate") {
        const cache = getGlobalCache();
        let cleared: number;
        if (argStr) {
          cleared = cache.invalidate({ toolName: argStr });
          console.log(`Cleared ${cleared} cache entries for tool '${argStr}'`);
        } else {
          cleared = cache.invalidate({});
          console.log(`Cleared ${cleared} cache entries`);
        }
        continue;
      }
      if (cmd === "tokens") {
        const tokens = statusBar.getTokens();
        console.log(`Session tokens: ${tokens.totalTokens} (prompt: ${tokens.promptTokens}, completion: ${tokens.completionTokens})`);
        continue;
      }
      if (cmd === "debug") {
        const newState = !isDebugEnabled();
        setDebugEnabled(newState);
        const currentLogFile = getLogFile();
        if (newState && !currentLogFile) {
          // First time enabling mid-session - init log file
          const newLogFile = initDebugLog(true);
          console.log(`Debug mode: ON (logging to ${newLogFile})`);
        } else if (newState && currentLogFile) {
          console.log(`Debug mode: ON (logging to ${currentLogFile})`);
        } else {
          console.log("Debug mode: OFF");
        }
        continue;
      }
      if (cmd === "regen") {
        // Get last user message and re-run
        const lastUserMsg = state.directorHistory.filter((h) => h.role === "user").pop();
        if (!lastUserMsg) {
          console.log("(No previous query to regenerate)");
          continue;
        }
        // Invalidate cache for generate tools
        const cache = getGlobalCache();
        cache.invalidate({ olderThanDays: 0 }); // Just mark for fresh generation
        console.log(`(Regenerating: "${lastUserMsg.content.slice(0, 50)}...")`);
        tui.addUserInput(`(regen) ${lastUserMsg.content}`);
        try {
          const res = await directScene({
            llm,
            generationLlm,
            world,
            canon,
            state,
            userText: lastUserMsg.content,
            campaignSettings,
            onToolCall: (name, args) => {
              statusBar.toolStart(name);
              debugToolCall(name, args);
              tui.addToolCall(name, args);
            },
            onToolResult: (name, result, elapsedMs) => {
              statusBar.toolEnd();
              debugToolResult(name, result, elapsedMs);
              tui.addToolResult(name, result, elapsedMs);
            },
            onLLMComplete: (usage) => {
              if (usage) {
                statusBar.addTokens(usage);
                debugTokens(usage);
              }
            },
          });
          state = res.state;
          scene = res.scene;
          // Add scene context to TUI
          if (res.scene) {
            tui.addSceneContext(res.scene);
          }
          tui.addNarration(res.reply);
          console.log("\n" + res.reply + "\n");
        } catch (e: any) {
          console.log(`(Error: ${e?.message ?? String(e)})`);
        }
        continue;
      }
      if (cmd === "model") {
        // No args: show current
        if (!argStr) {
          console.log(`Chat:       ${llm.provider}/${llm.model}`);
          if (generationLlm) {
            console.log(`Generation: ${generationLlm.provider}/${generationLlm.model}`);
          } else {
            console.log(`Generation: (using chat model)`);
          }
          continue;
        }

        // List available
        if (argStr === "list") {
          console.log("Fetching available models...\n");

          // Ollama
          console.log("ollama:");
          const ollamaModels = await listModels("ollama");
          if (ollamaModels.length === 0) {
            console.log("  (none found - is Ollama running?)");
          } else {
            for (const m of ollamaModels) {
              const sizeStr = m.size ? ` (${m.size})` : "";
              console.log(`  ${m.id}${sizeStr}`);
            }
          }

          // OpenAI
          console.log("\nopenai:");
          const openaiModels = await listModels("openai");
          if (openaiModels.length === 0) {
            console.log("  (no API key or failed to fetch)");
          } else {
            for (const m of openaiModels.slice(0, 15)) {
              console.log(`  ${m.id}`);
            }
            if (openaiModels.length > 15) {
              console.log(`  ... and ${openaiModels.length - 15} more`);
            }
          }

          // Anthropic
          console.log("\nanthropic:");
          const anthropicModels = await listModels("anthropic");
          for (const m of anthropicModels) {
            console.log(`  ${m.id}`);
          }

          continue;
        }

        // Parse provider/model
        const parts = argStr.split("/", 2);
        const newProvider = parts[0] as LLMProviderName;
        const newModel = parts[1]; // may be undefined

        if (!["ollama", "openai", "anthropic"].includes(newProvider)) {
          console.log(`Unknown provider: ${newProvider}. Use: ollama, openai, anthropic`);
          continue;
        }

        // Validate API key requirements
        const validationError = validateProviderSwitch(newProvider);
        if (validationError) {
          console.log(`Cannot switch: ${validationError}`);
          continue;
        }

        try {
          // Determine effective model
          const effectiveModel = newModel || getEffectiveModel(config, newProvider);

          // Create new client
          const newLlm = createLLMClient({ provider: newProvider, model: effectiveModel });

          // Update and save config
          config = {
            ...config,
            provider: newProvider,
            models: {
              ...config.models,
              [newProvider]: effectiveModel,
            },
          };
          await saveConfig(config);

          // Hot-swap
          llm = newLlm;
          statusBar.setProvider(llm.provider, llm.model);
          console.log(`Chat model: ${llm.provider}/${llm.model}`);
        } catch (e: any) {
          console.log(`Failed to switch: ${e?.message ?? String(e)}`);
        }
        continue;
      }

      if (cmd === "genmodel") {
        // Disable separate generation model
        if (argStr === "off" || argStr === "none" || argStr === "disable") {
          generationLlm = undefined;
          config = {
            ...config,
            generationProvider: undefined,
            generationModels: undefined,
          };
          await saveConfig(config);
          console.log("Generation model disabled (using chat model)");
          continue;
        }

        // No args: show current
        if (!argStr) {
          if (generationLlm) {
            console.log(`Generation: ${generationLlm.provider}/${generationLlm.model}`);
          } else {
            console.log(`Generation: (using chat model: ${llm.provider}/${llm.model})`);
          }
          continue;
        }

        // Parse provider/model
        const parts = argStr.split("/", 2);
        const newProvider = parts[0] as LLMProviderName;
        const newModel = parts[1];

        if (!["ollama", "openai", "anthropic"].includes(newProvider)) {
          console.log(`Unknown provider: ${newProvider}. Use: ollama, openai, anthropic`);
          continue;
        }

        const validationError = validateProviderSwitch(newProvider);
        if (validationError) {
          console.log(`Cannot switch: ${validationError}`);
          continue;
        }

        try {
          const effectiveModel = newModel || getEffectiveGenerationModel(config, newProvider);
          const newGenLlm = createLLMClient({ provider: newProvider, model: effectiveModel });

          // Update and save config
          config = {
            ...config,
            generationProvider: newProvider,
            generationModels: {
              ...config.generationModels,
              [newProvider]: effectiveModel,
            },
          };
          await saveConfig(config);

          generationLlm = newGenLlm;
          console.log(`Generation model: ${generationLlm.provider}/${generationLlm.model}`);
        } catch (e: any) {
          console.log(`Failed to switch: ${e?.message ?? String(e)}`);
        }
        continue;
      }

      if (cmd === "campaign") {
        const campaignName = argStr || undefined;
        const campaignStore = new CampaignStore(canon.db);
        try {
          await runCampaignMode({
            store: campaignStore,
            canon,
            llm,
            generationLlm,
            campaignName,
            io: {
              ask,
              println: (line: string) => console.log(line),
            },
          });
        } catch (e: any) {
          console.log(`(Campaign error: ${e?.message ?? String(e)})`);
        }
        continue;
      }

      if (cmd === "skills") {
        if (skills.length === 0) {
          console.log("No skills found. Add skills to ./skills/ or ~/.azworld/skills/");
        } else {
          console.log("Available skills:");
          for (const s of skills) {
            console.log(`  /${s.name} - ${s.description}`);
          }
        }
        continue;
      }

      // Check if command matches a discovered skill
      const matchedSkill = skills.find(s => s.name === cmd);
      if (matchedSkill) {
        if (mode !== "director") {
          console.log("Skills can only be invoked in director mode. Type /back first.");
          continue;
        }

        const skill = loadSkill(matchedSkill);
        const skillMessage = `<skill name="${skill.name}">
${skill.instructions}
</skill>

User context: ${argStr || "Execute this skill for the current location."}`;

        tui.addUserInput(`/${skill.name} ${argStr || ""}`);
        try {
          const res = await directScene({
            llm,
            generationLlm,
            world,
            canon,
            state,
            userText: skillMessage,
            campaignSettings,
            onToolCall: (name, args) => {
              statusBar.toolStart(name);
              debugToolCall(name, args);
              tui.addToolCall(name, args);
            },
            onToolResult: (name, result, elapsedMs) => {
              statusBar.toolEnd();
              debugToolResult(name, result, elapsedMs);
              tui.addToolResult(name, result, elapsedMs);
            },
            onLLMComplete: (usage) => {
              if (usage) {
                statusBar.addTokens(usage);
                debugTokens(usage);
              }
            },
          });
          state = res.state;
          scene = res.scene;
          if (res.scene) {
            tui.addSceneContext(res.scene);
          }
          tui.addNarration(res.reply);
          console.log("\n" + res.reply + "\n");
        } catch (e: any) {
          console.log(`(Error: ${e?.message ?? String(e)})`);
        }
        continue;
      }

      console.log("Unknown command. Type /help.");
      continue;
    }

    try {
      tui.addUserInput(line);
      if (mode === "npc") {
        const reply = await npcTurn({ llm, world, canon, state, scene, userText: line, campaignSettings });
        tui.addNarration(reply);
        console.log("\n" + reply + "\n");
      } else {
        const res = await directScene({
          llm,
          generationLlm,
          world,
          canon,
          state,
          userText: line,
          campaignSettings,
          onToolCall: (name, args) => {
            statusBar.toolStart(name);
            debugToolCall(name, args);
            tui.addToolCall(name, args);
          },
          onToolResult: (name, result, elapsedMs) => {
            statusBar.toolEnd();
            debugToolResult(name, result, elapsedMs);
            tui.addToolResult(name, result, elapsedMs);
          },
          onLLMComplete: (usage) => {
            if (usage) {
              statusBar.addTokens(usage);
              debugTokens(usage);
            }
          },
        });
        state = res.state;
        scene = res.scene;
        // Add scene context to TUI
        if (res.scene) {
          tui.addSceneContext(res.scene);
        }
        tui.addNarration(res.reply);
        console.log("\n" + res.reply + "\n");
      }
    } catch (e: any) {
      console.log(`(Error: ${e?.message ?? String(e)})`);
    }
  }

  tui.cleanup();
  statusBar.clear();
  rl.close();
  canon.close();
  closeGlobalCache();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
