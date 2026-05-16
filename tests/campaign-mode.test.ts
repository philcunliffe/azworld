import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CampaignStore } from "../src/campaign/store";
import { CanonStore } from "../src/canon/canon";
import type {
  ChatMessage,
  CompleteOpts,
  CompleteResult,
  LLMClient,
  ToolCall,
} from "../src/llm/providers";
import { runCampaignMode, type ChatIO } from "../src/chat/campaign-mode";

// ── Scripted LLM ──────────────────────────────────────────────────────────
// Each script step is a fixed CompleteResult. Useful for driving the campaign
// REPL through deterministic turns without touching real providers.

interface MockLLM extends LLMClient {
  calls: Array<{ system?: string; messages: ChatMessage[]; tools?: any[] }>;
  setScript: (steps: CompleteResult[]) => void;
}

function newMockLLM(): MockLLM {
  let script: CompleteResult[] = [];
  const calls: Array<{ system?: string; messages: ChatMessage[]; tools?: any[] }> = [];
  const client: MockLLM = {
    provider: "ollama",
    model: "mock",
    calls,
    setScript(steps) {
      script = [...steps];
    },
    async complete(opts: CompleteOpts): Promise<CompleteResult> {
      calls.push({ system: opts.system, messages: opts.messages, tools: opts.tools });
      const step = script.shift();
      if (!step) {
        return { text: "(no more scripted replies)", stopReason: "end_turn" };
      }
      return step;
    },
  };
  return client;
}

function tc(id: string, name: string, args: Record<string, any>): ToolCall {
  return { id, name, arguments: args };
}

// ── Scripted IO ───────────────────────────────────────────────────────────

interface ScriptedIO extends ChatIO {
  output: string[];
  enqueue: (line: string) => void;
}

function newScriptedIO(initialInputs: string[]): ScriptedIO {
  const inputs = [...initialInputs];
  const output: string[] = [];
  return {
    output,
    enqueue(line) {
      inputs.push(line);
    },
    async ask(_prompt: string): Promise<string> {
      const next = inputs.shift();
      if (next === undefined) {
        // No more inputs → simulate user typing /exit so the REPL ends.
        return "/exit";
      }
      return next;
    },
    println(line: string) {
      output.push(line);
    },
  };
}

// ── Test rig ──────────────────────────────────────────────────────────────

interface Rig {
  canon: CanonStore;
  store: CampaignStore;
  llm: MockLLM;
}

function newRig(): Rig {
  const canon = new CanonStore(":memory:");
  canon.initDb();
  // Reuse the canon DB for the campaign store so we test the real
  // single-database wiring used by azchat.
  const store = new CampaignStore(canon.db);
  store.initDb();
  const llm = newMockLLM();
  return { canon, store, llm };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("runCampaignMode", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = newRig();
  });

  test("/exit immediately after entering creates+leaves the campaign", async () => {
    const io = newScriptedIO(["/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "smoke-test",
    });

    const campaigns = rig.store.listCampaigns();
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]!.name).toBe("smoke-test");

    const bannerLine = io.output.find((l) => l.includes("Campaign builder"));
    expect(bannerLine).toBeDefined();
    expect(bannerLine).toContain("smoke-test");

    const exitLine = io.output.find((l) => l.includes("[Exited campaign"));
    expect(exitLine).toBeDefined();
  });

  test("/campaign <name> a second time resumes the same campaign", async () => {
    const io1 = newScriptedIO(["/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io: io1,
      campaignName: "resume-test",
    });
    const firstId = rig.store.listCampaigns()[0]!.id;

    const io2 = newScriptedIO(["/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io: io2,
      campaignName: "resume-test",
    });

    const campaigns = rig.store.listCampaigns();
    expect(campaigns).toHaveLength(1); // not duplicated
    expect(campaigns[0]!.id).toBe(firstId);

    const resumeLine = io2.output.find((l) => l.includes("Resuming"));
    expect(resumeLine).toBeDefined();
  });

  test("slash commands /state /history /help do NOT call the LLM", async () => {
    const io = newScriptedIO(["/state", "/history", "/help", "/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "no-llm-slash",
    });
    expect(rig.llm.calls).toHaveLength(0);
    // /state header is rendered
    expect(io.output.some((l) => l === "Campaign state:")).toBe(true);
    // /history on empty session prints the no-history line
    expect(io.output.some((l) => l.includes("no history yet"))).toBe(true);
    // /help lists at least /back
    expect(io.output.some((l) => l.includes("/back"))).toBe(true);
  });

  test("unknown slash command prints a hint, no LLM call", async () => {
    const io = newScriptedIO(["/wat", "/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "unknown-slash",
    });
    expect(rig.llm.calls).toHaveLength(0);
    expect(io.output.some((l) => l.includes("Unknown campaign command"))).toBe(true);
  });

  test("user turn drives propose → accept → canon entity end-to-end", async () => {
    // Script: a single user turn ("region please") produces:
    //   1. assistant calls get_state, then propose region count=2
    //   2. assistant calls accept region c-1
    //   3. assistant returns a final text reply, no more tool calls
    rig.llm.setScript([
      {
        text: "",
        stopReason: "tool_use",
        toolCalls: [
          tc("call-1", "campaign.get_state", {}),
          tc("call-2", "campaign.propose", { slot: "region", count: 2 }),
        ],
      },
      {
        text: "",
        stopReason: "tool_use",
        toolCalls: [tc("call-3", "campaign.accept", { slot: "region", candidateId: "c-1" })],
      },
      {
        text: "Region locked. Want a location next?",
        stopReason: "end_turn",
      },
    ]);

    const io = newScriptedIO(["region please", "/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "e2e-flow",
      // Scripted generation: bypass real LLM-backed generators by returning
      // the same client for both chat + generation. We override generation
      // by adding scripted completions to its pipeline.
      generationLlm: makeScriptedGenerationLLM(),
    });

    // Canon should now have a region entity.
    const regions = rig.canon.listEntities({ type: "region" as any, limit: 10 });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.name).toBe("Region One");
    expect((regions[0]!.provenance as any)?.campaign_id).toBeTruthy();

    // Session should reflect accepted region.
    const camp = rig.store.listCampaigns().find((c) => c.name === "e2e-flow");
    expect(camp).toBeDefined();
    expect(camp!.state.slots.region.status).toBe("accepted");
    expect(camp!.state.slots.region.entityId).toBe(regions[0]!.id);

    // History should record both user + assistant turn + tool exchanges.
    const userEntries = camp!.state.history.filter((h) => h.kind === "user");
    expect(userEntries).toHaveLength(1);
    const assistantEntries = camp!.state.history.filter((h) => h.kind === "assistant");
    expect(assistantEntries.length).toBeGreaterThanOrEqual(1);
    const toolCalls = camp!.state.history.filter((h) => h.kind === "tool_call");
    expect(toolCalls.length).toBe(3); // get_state, propose, accept

    // Final text rendered to the user.
    expect(io.output.some((l) => l.includes("Region locked"))).toBe(true);
  });

  test("tool-call budget caps a runaway LLM and surfaces the cap to the user", async () => {
    // Script: assistant repeatedly emits 6 tool calls per iteration to force
    // budget exhaustion (10/turn). We emit 12 cumulative tool calls.
    const calls: ToolCall[] = [];
    for (let i = 0; i < 12; i++) {
      calls.push(tc(`call-${i}`, "campaign.get_state", {}));
    }
    rig.llm.setScript([
      { text: "", stopReason: "tool_use", toolCalls: calls.slice(0, 6) },
      { text: "", stopReason: "tool_use", toolCalls: calls.slice(6) },
      { text: "ok", stopReason: "end_turn" },
    ]);

    const io = newScriptedIO(["go", "/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "budget-test",
    });

    const budgetLine = io.output.find((l) => l.includes("budget"));
    expect(budgetLine).toBeDefined();
  });

  test("named campaign auto-creates without asking when none exists", async () => {
    const io = newScriptedIO(["/exit"]);
    await runCampaignMode({
      store: rig.store,
      canon: rig.canon,
      llm: rig.llm,
      io,
      campaignName: "auto-created",
    });
    expect(rig.store.listCampaigns()).toHaveLength(1);
    expect(io.output.some((l) => l.includes("Creating campaign 'auto-created'"))).toBe(true);
  });
});

// ── Scripted generation LLM (used by buildCampaignGenerators) ──────────────
//
// The generators call completeJson, which calls llm.complete with jsonMode:
// true. We return a JSON candidates envelope so the propose tool gets back
// a sensible CandidateDraft[].

function makeScriptedGenerationLLM(): LLMClient {
  return {
    provider: "ollama",
    model: "mock-gen",
    async complete(_opts: CompleteOpts): Promise<CompleteResult> {
      const payload = {
        candidates: [
          { name: "Region One", summary: "First region summary", payload: { biome: "forest" } },
          { name: "Region Two", summary: "Second region summary", payload: { biome: "tundra" } },
        ],
      };
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
      };
    },
  };
}
