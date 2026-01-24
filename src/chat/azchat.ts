import readline from "node:readline";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { createLLMClient, type LLMProviderName } from "../llm/providers";
import { loadConfig, saveConfig, getEffectiveProvider, getEffectiveModel, validateProviderSwitch, DEFAULT_MODELS, type LLMConfig } from "../llm/config";
import { exportWiki } from "../wiki/wiki";
import { extractGlobals } from "../util/args";
import { directScene, newChatState, SceneContext } from "./director";
import { npcTurn, resolveNpcByName } from "./npc";
import { getGlobalCache, closeGlobalCache } from "../llm/cache";

function helpText(): string {
  return [
    "Commands:",
    "  /help                       Show this help",
    "  /where                      Show current city/location",
    "  /talk <npc name>            Talk as an NPC in the current scene",
    "  /back                       Return to Director mode",
    "  /wiki <outDir>              Export wiki Markdown to a directory",
    "  /model                      Show current LLM provider/model",
    "  /model list                 List available providers and models",
    "  /model <provider>/<model>   Switch provider/model (e.g., /model openai/gpt-4o)",
    "  /cache                      Show cache statistics",
    "  /invalidate [tool]          Clear generation cache (optionally for specific tool)",
    "  /regen                      Re-run the last director query (invalidates cache first)",
    "  /exit                       Quit",
    "",
    "Tips:",
    "  - Try: My heroes enter a tavern in <CityName>",
    "  - Or: The party visits the miners' guild hall in <CityName>",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const { globals, rest } = extractGlobals(argv);

  const worldPath = globals.world || "./data/world.json";
  const canonPath = globals.canon || "./data/canon.db";

  const world = await AzgaarWorld.load(worldPath);
  const canon = new CanonStore(canonPath);
  canon.initDb();

  // Load persistent config
  let config = await loadConfig();
  const initialProvider = getEffectiveProvider(config);
  const initialModel = getEffectiveModel(config, initialProvider);
  let llm = createLLMClient({ provider: initialProvider, model: initialModel });

  let state = newChatState();
  let scene: SceneContext | undefined;
  let mode: "director" | "npc" = "director";

  console.log("azchat (bun+ts)" + `  provider=${llm.provider}  model=${llm.model}`);
  console.log(`world=${worldPath}`);
  console.log(`canon=${canonPath}`);
  console.log("Type /help for commands.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  // Basic REPL loop
  while (true) {
    const prompt = mode === "director" ? "🎲> " : "🗣️> ";
    const line = (await ask(prompt)).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      const argStr = args.join(" ").trim();

      if (cmd === "help") {
        console.log(helpText());
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
        try {
          const res = await directScene({
            llm,
            world,
            canon,
            state,
            userText: lastUserMsg.content,
            onToolCall: (name, args) => console.log(`  [tool] ${name}(${JSON.stringify(args).slice(0, 80)}...)`),
          });
          state = res.state;
          scene = res.scene;
          console.log("\n" + res.reply + "\n");
        } catch (e: any) {
          console.log(`(Error: ${e?.message ?? String(e)})`);
        }
        continue;
      }
      if (cmd === "model") {
        // No args: show current
        if (!argStr) {
          console.log(`Provider: ${llm.provider}`);
          console.log(`Model: ${llm.model}`);
          continue;
        }

        // List available
        if (argStr === "list") {
          console.log("Available providers:");
          console.log(`  ollama    - Local inference (default: ${DEFAULT_MODELS.ollama})`);
          console.log(`  openai    - OpenAI API (default: ${DEFAULT_MODELS.openai})`);
          console.log(`  anthropic - Anthropic API (default: ${DEFAULT_MODELS.anthropic})`);
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
          console.log(`Switched to ${llm.provider}/${llm.model}`);
        } catch (e: any) {
          console.log(`Failed to switch: ${e?.message ?? String(e)}`);
        }
        continue;
      }

      console.log("Unknown command. Type /help.");
      continue;
    }

    try {
      if (mode === "npc") {
        const reply = await npcTurn({ llm, world, canon, state, scene, userText: line });
        console.log("\n" + reply + "\n");
      } else {
        const res = await directScene({
          llm,
          world,
          canon,
          state,
          userText: line,
          onToolCall: (name, args) => console.log(`  [tool] ${name}(${JSON.stringify(args).slice(0, 80)}...)`),
        });
        state = res.state;
        scene = res.scene;
        console.log("\n" + res.reply + "\n");
      }
    } catch (e: any) {
      console.log(`(Error: ${e?.message ?? String(e)})`);
    }
  }

  rl.close();
  canon.close();
  closeGlobalCache();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
