import type { CanonStore } from "../canon/canon";
import type {
  ChatMessage,
  LLMClient,
  ToolCall,
  ToolDefinition,
} from "../llm/providers";
import { CampaignStore } from "../campaign/store";
import { CampaignSession } from "../campaign/session";
import {
  createCampaignToolRegistry,
  type CampaignToolRegistry,
} from "../campaign/tools";
import { CAMPAIGN_BUILDER_SYSTEM_PROMPT } from "../campaign/prompt";
import type {
  Campaign,
  HistoryEntry,
  MultiSlot,
  MultiSlotKind,
  Slot,
  SlotKind,
} from "../campaign/types";
import { buildCampaignGenerators } from "./campaign-generators";

export interface ChatIO {
  ask: (prompt: string) => Promise<string>;
  println: (line: string) => void;
}

export interface CampaignModeDeps {
  store: CampaignStore;
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;
  io: ChatIO;
  campaignName?: string;
}

const TURN_TOOL_CALL_BUDGET = 10;
const HISTORY_CONTEXT_TAIL = 30;
const SINGLETON_SLOTS: SlotKind[] = ["region", "location", "event", "faction"];
const MULTI_SLOTS: MultiSlotKind[] = ["npcs", "lore", "hooks"];

// OpenAI + Anthropic reject tool names containing `.` (regex ^[a-zA-Z0-9_-]+$).
// The az-pnp registry uses dotted names (`campaign.propose`). We rename them
// for the wire and translate back when dispatching to the registry.
function wireToolName(registryName: string): string {
  return registryName.replace(/\./g, "__");
}
function registryToolName(wireName: string): string {
  return wireName.replace(/__/g, ".");
}
function renameToolDefinitions(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((d) => ({ ...d, name: wireToolName(d.name) }));
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomShortSlug(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return uuid.slice(0, 8);
}

function findCampaignByName(store: CampaignStore, name: string): Campaign | undefined {
  // Look in both open and archived so /campaign <name> reliably resumes.
  const open = store.listCampaigns({ status: "open" });
  const archived = store.listCampaigns({ status: "archived" });
  return [...open, ...archived].find((c) => c.name === name);
}

async function resolveSession(
  deps: CampaignModeDeps
): Promise<CampaignSession> {
  const { store, io, campaignName } = deps;

  if (campaignName) {
    const existing = findCampaignByName(store, campaignName);
    if (existing) {
      io.println(`(Resuming campaign '${existing.name}' [${existing.id}].)`);
      return CampaignSession.load(store, existing.id);
    }
    io.println(`(Creating campaign '${campaignName}'.)`);
    return CampaignSession.create(store, { name: campaignName });
  }

  const proposed = `untitled-${randomShortSlug()}`;
  const reply = (await io.ask(`Campaign name (blank = '${proposed}'): `)).trim();
  const finalName = reply || proposed;
  const existing = findCampaignByName(store, finalName);
  if (existing) {
    io.println(`(Resuming campaign '${existing.name}' [${existing.id}].)`);
    return CampaignSession.load(store, existing.id);
  }
  io.println(`(Creating campaign '${finalName}'.)`);
  return CampaignSession.create(store, { name: finalName });
}

function renderSingletonSlot(name: SlotKind, slot: Slot): string {
  const notes = slot.notes ? ` (notes: ${slot.notes})` : "";
  if (slot.status === "open") return `  ${name}: open${notes}`;
  if (slot.status === "proposed") {
    const cands = slot.candidates ?? [];
    const list = cands.map((c) => `      [${c.id}] ${c.name} — ${c.summary}`).join("\n");
    return `  ${name}: proposed (${cands.length})${notes}\n${list}`;
  }
  // accepted
  const ent = slot.entityId ? ` → ${slot.entityId}` : "";
  return `  ${name}: accepted${ent}${notes}`;
}

function renderMultiSlot(name: MultiSlotKind, slot: MultiSlot): string {
  if (slot.entries.length === 0) return `  ${name}: (none)`;
  const lines = slot.entries
    .map((e) => `      [${e.candidateId}] ${e.entityId ?? "(no entity)"}`)
    .join("\n");
  return `  ${name}: ${slot.entries.length} entries\n${lines}`;
}

function printState(session: CampaignSession, io: ChatIO): void {
  const state = session.getState();
  io.println("Campaign state:");
  for (const k of SINGLETON_SLOTS) {
    io.println(renderSingletonSlot(k, state.slots[k]));
  }
  for (const k of MULTI_SLOTS) {
    io.println(renderMultiSlot(k, state.multi[k]));
  }
}

function renderHistoryEntry(entry: HistoryEntry): string {
  const t = entry.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
  if (entry.kind === "user") return `[${t}] user: ${entry.text}`;
  if (entry.kind === "assistant") return `[${t}] assistant: ${entry.text}`;
  if (entry.kind === "tool_call") {
    const argsStr = JSON.stringify(entry.args).slice(0, 200);
    return `[${t}] tool_call ${entry.tool}(${argsStr})`;
  }
  const resStr = JSON.stringify(entry.result).slice(0, 200);
  return `[${t}] tool_result ${entry.tool} -> ${resStr}`;
}

function printHistory(session: CampaignSession, io: ChatIO, n = 20): void {
  const history = session.getState().history;
  if (history.length === 0) {
    io.println("(no history yet)");
    return;
  }
  const tail = history.slice(-n);
  for (const entry of tail) {
    io.println(renderHistoryEntry(entry));
  }
}

function printHelp(io: ChatIO): void {
  io.println("Campaign-mode commands:");
  io.println("  /state     Show slot statuses (open/proposed/accepted) and entries");
  io.println("  /history   Print the last 20 history entries");
  io.println("  /help      Show this help");
  io.println("  /back      Leave campaign mode and return to azchat");
  io.println("  /exit      Same as /back");
  io.println("Anything else is sent to the campaign-builder LLM.");
}

function printExitSummary(session: CampaignSession, io: ChatIO): void {
  const state = session.getState();
  const camp = session.getCampaign();
  const acceptedSingletons = SINGLETON_SLOTS.filter(
    (k) => state.slots[k].status === "accepted"
  );
  const multiCount = MULTI_SLOTS.reduce(
    (acc, k) => acc + state.multi[k].entries.length,
    0
  );
  io.println(
    `[Exited campaign '${camp.name}'. ${acceptedSingletons.length}/4 singletons accepted, ${multiCount} multi entries.]`
  );
}

function summariseToolResult(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return `${name} -> ${JSON.stringify(result)}`;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return `${name} → error: ${r.error}`;
  if (name === "campaign.propose" || name === "campaign.refine") {
    const cands = Array.isArray(r.candidates) ? (r.candidates as Array<{ id: string; name: string }>) : [];
    const names = cands.map((c) => `${c.id}:${c.name}`).join(", ");
    return `${name} → ${cands.length} candidates [${names}]`;
  }
  if (name === "campaign.accept") {
    return `${name} → entityId=${r.entityId}`;
  }
  if (name === "campaign.revise") {
    return `${name} → revised ${r.entityId}`;
  }
  if (name === "campaign.unaccept") {
    return `${name} → removed ${r.removedEntityId} (deleted=${r.deleted})`;
  }
  if (name === "campaign.set_notes") {
    return `${name} → ${r.slot} notes set`;
  }
  if (name === "campaign.get_state") {
    return `${name} → state snapshot`;
  }
  return `${name} → ${JSON.stringify(result).slice(0, 200)}`;
}

function compactHistoryEntryForLLM(entry: HistoryEntry): string | null {
  // Render history into prose lines the LLM can read. We collapse tool exchanges
  // into a single annotated line so we don't need to reconstruct tool_call ids
  // for previous turns — the campaign session is the source of truth, and the
  // system prompt tells the LLM to call get_state at the start of each turn.
  if (entry.kind === "user") return `User: ${entry.text}`;
  if (entry.kind === "assistant") return `Assistant: ${entry.text}`;
  if (entry.kind === "tool_call") {
    const args = JSON.stringify(entry.args ?? {}).slice(0, 300);
    return `(prev tool call) ${entry.tool}(${args})`;
  }
  if (entry.kind === "tool_result") {
    const summary = summariseToolResult(entry.tool, entry.result);
    return `(prev tool result) ${summary}`;
  }
  return null;
}

function buildContextMessages(session: CampaignSession): ChatMessage[] {
  const history = session.getState().history;
  if (history.length === 0) return [];

  const tail = history.slice(-HISTORY_CONTEXT_TAIL - 1, -1); // exclude current user turn
  if (tail.length === 0) return [];

  const lines: string[] = [];
  for (const entry of tail) {
    const line = compactHistoryEntryForLLM(entry);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return [];

  return [
    {
      role: "user",
      content:
        "Earlier conversation in this campaign (for context only — do NOT re-do these actions):\n" +
        lines.join("\n"),
    },
    {
      role: "assistant",
      content: "Understood — that's prior context. I'll continue from here.",
    },
  ];
}

interface RunTurnOpts {
  llm: LLMClient;
  tools: CampaignToolRegistry;
  session: CampaignSession;
  userText: string;
  io: ChatIO;
}

async function runOneCampaignTurn(opts: RunTurnOpts): Promise<void> {
  const { llm, tools, session, userText, io } = opts;

  const wireTools = renameToolDefinitions(tools.toolDefinitions);

  const messages: ChatMessage[] = [
    ...buildContextMessages(session),
    { role: "user", content: userText },
  ];

  let toolBudgetUsed = 0;
  let assistantTextSoFar = "";
  let iterations = 0;
  const MAX_ITERS = TURN_TOOL_CALL_BUDGET + 2;

  while (iterations < MAX_ITERS) {
    iterations += 1;

    const result = await llm.complete({
      system: CAMPAIGN_BUILDER_SYSTEM_PROMPT,
      messages,
      tools: wireTools,
      toolChoice: "auto",
      maxTokens: 1800,
      temperature: 0.7,
    });

    if (result.text) {
      assistantTextSoFar += (assistantTextSoFar ? "\n" : "") + result.text;
    }

    const toolCalls: ToolCall[] = result.toolCalls ?? [];
    if (toolCalls.length === 0 || result.stopReason !== "tool_use") {
      break;
    }

    messages.push({
      role: "assistant",
      content: result.text ?? "",
      toolCalls,
    });

    for (const tc of toolCalls) {
      const realName = registryToolName(tc.name);

      if (toolBudgetUsed >= TURN_TOOL_CALL_BUDGET) {
        const note = `Tool-call budget (${TURN_TOOL_CALL_BUDGET}) exhausted this turn; remaining tool calls ignored.`;
        io.println(`(${note})`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: note }),
          toolCallId: tc.id,
        });
        continue;
      }
      toolBudgetUsed += 1;

      session.appendHistory({
        kind: "tool_call",
        tool: realName,
        args: tc.arguments ?? {},
        ts: nowIso(),
      });

      let toolResult: unknown;
      try {
        toolResult = await tools.execute(realName, tc.arguments ?? {});
      } catch (e) {
        toolResult = { error: (e as Error)?.message ?? String(e) };
      }

      session.appendHistory({
        kind: "tool_result",
        tool: realName,
        result: toolResult,
        ts: nowIso(),
      });

      io.println(`  · ${summariseToolResult(realName, toolResult)}`);

      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        toolCallId: tc.id,
      });
    }
  }

  if (assistantTextSoFar) {
    io.println(assistantTextSoFar);
    session.appendHistory({
      kind: "assistant",
      text: assistantTextSoFar,
      ts: nowIso(),
    });
  } else {
    io.println("(no narrative reply this turn)");
  }
}

/**
 * Enter campaign-builder mode. Drives a multi-turn LLM conversation
 * over the campaign tool registry. Returns when the user types /exit or /back.
 */
export async function runCampaignMode(deps: CampaignModeDeps): Promise<void> {
  deps.canon.initDb();
  deps.store.initDb();

  const session = await resolveSession(deps);
  const camp = session.getCampaign();

  const generators = buildCampaignGenerators({
    llm: deps.generationLlm ?? deps.llm,
    canon: deps.canon,
  });
  const tools = createCampaignToolRegistry({
    session,
    canon: deps.canon,
    generators,
  });

  deps.io.println(
    `[Campaign builder — ${camp.name}. Type /exit to leave, /help for commands.]`
  );

  while (true) {
    const line = (await deps.io.ask("📜> ")).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd] = line.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "back") {
        session.flush();
        printExitSummary(session, deps.io);
        return;
      }
      if (cmd === "state") {
        printState(session, deps.io);
        continue;
      }
      if (cmd === "history") {
        printHistory(session, deps.io, 20);
        continue;
      }
      if (cmd === "help") {
        printHelp(deps.io);
        continue;
      }
      deps.io.println(`Unknown campaign command: /${cmd}. Try /help.`);
      continue;
    }

    session.appendHistory({ kind: "user", text: line, ts: nowIso() });

    try {
      await runOneCampaignTurn({
        llm: deps.llm,
        tools,
        session,
        userText: line,
        io: deps.io,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      deps.io.println(`(turn error: ${msg})`);
    }

    session.flush();
  }
}
