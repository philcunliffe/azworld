import readline from "node:readline";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { createLLMClient } from "../llm/providers";
import { exportWiki } from "../wiki/wiki";
import { extractGlobals } from "../util/args";
import { ensureSceneFromUserText, newChatState, SceneContext } from "./director";
import { npcTurn, resolveNpcByName } from "./npc";

function helpText(): string {
  return [
    "Commands:",
    "  /help                       Show this help",
    "  /where                      Show current city/location",
    "  /talk <npc name>            Talk as an NPC in the current scene",
    "  /back                       Return to Director mode",
    "  /wiki <outDir>              Export wiki Markdown to a directory",
    "  /exit                       Quit",
    "",
    "Tips:",
    "  - Try: My heroes are in a tavern in <CityName> with ties to the criminal underworld.",
    "  - Or: We're in an extremely large miners' guild bar in <CityName>.",
    "  - Use LLM_PROVIDER=ollama|openai|anthropic in your env.",
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

  const llm = createLLMClient();

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

      console.log("Unknown command. Type /help.");
      continue;
    }

    try {
      if (mode === "npc") {
        const reply = await npcTurn({ llm, world, canon, state, scene, userText: line });
        console.log("\n" + reply + "\n");
      } else {
        const res = await ensureSceneFromUserText({ llm, world, canon, state, userText: line });
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
