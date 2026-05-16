import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, EntityType } from "../canon/canon";
import { parseSourceText } from "../canon/ingest";
import { addIdea, listIdeas, getIdea, markIdeaUsed, deleteIdea, setIdeaLabels } from "../canon/ideas";
import { runPendingIdeaLabeling, suggestLabelsForIdea, kickOffIdeaLabeling } from "../canon/idea-labeler";
import { CampaignStore } from "../campaign/store";
import { exportWiki } from "../wiki/wiki";
import { extractGlobals, readJsonArgAsync } from "../util/args";
import { jsonDumps } from "../util/json";
import { ok, err } from "../util/envelope";
import { createLLMClient, type LLMClient } from "../llm/providers";
import { loadConfig, getEffectiveGenerationModel, getEffectiveGenerationProvider, getEffectiveModel, getEffectiveProvider, type LLMConfig } from "../llm/config";

function print(globals: { json?: boolean; pretty?: boolean }, value: any) {
  const pretty = !!globals.pretty;
  const text = jsonDumps(value, pretty);
  console.log(text);
}

function buildGenerationLLM(config: LLMConfig): LLMClient | undefined {
  try {
    const provider = getEffectiveGenerationProvider(config) || getEffectiveProvider(config);
    const model = getEffectiveGenerationProvider(config)
      ? getEffectiveGenerationModel(config, provider)
      : getEffectiveModel(config, provider);
    return createLLMClient({ provider, model });
  } catch {
    return undefined;
  }
}

function usage(): string {
  return [
    "azcli (bun+ts)",
    "",
    "Global flags:",
    "  --world <path>             World JSON path (Azgaar export)",
    "  --canon <path>             Canon SQLite DB path",
    "  --json                     Wrap results in {ok:true,data:...}",
    "  --pretty                   Pretty JSON",
    "",
    "Commands:",
    "  info",
    "  list states",
    "  list burgs [--state <idOrName>] [--top <N>]",
    "  show state <idOrName>",
    "  show burg <idOrName>",
    "  cell <cellId>",
    "  search <term> [--kinds states,burgs,cultures,religions,rivers] [--limit N]",
    "  canon init",
    "  canon add <npc|faction|location|event|rumor|hook|meta|culture|religion|era|phenomena|relation_type|source_text> --name <name> [--summary ...] [--details-md ...] [--tags a,b] [--payload-json <jsonOr@file>] [--burg <id>] [--state <id>]",
    "  canon ingest --file <notes.md> [--name <title>] [--apply] [--scope <scope>] [--burg <id>] [--state <id>] [--era-id <id>]",
    "  canon show <id>",
    "  canon list [--type ...] [--burg <id>] [--tag <tag>] [--text <substr>] [--campaign <name>] [--limit N]",
    "  canon patch <id> --patch-json <jsonOr@file>",
    "  canon link --from-id <id> --to-id <id> --rel <type> [--strength n] [--notes ...]",
    "  canon export --out <file.json>",
    "  canon import --input <file.json> [--mode upsert|insert]",
    "  idea add <text> [--labels a,b] [--no-label]",
    "  idea list [--status pending|used|all] [--label X] [--limit N]",
    "  idea show <id>",
    "  idea mark-used <id> [--by-entity <entityId>]",
    "  idea remove <id>",
    "  idea relabel <id>",
    "  idea label-pending [--concurrency N]",
    "  export wiki --out <dir>",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const { globals, rest } = extractGlobals(argv);
  const config = await loadConfig();

  const worldPath = globals.world || "./data/world.json";
  const canonPath = globals.canon || "./data/canon.db";

  const world = await AzgaarWorld.load(worldPath);
  const canon = new CanonStore(canonPath);

  const wrap = (data: any) => (globals.json ? ok(data) : data);

  const [cmd, sub, ...args] = rest;
  if (!cmd) {
    print(globals, wrap({ help: usage() }));
    return;
  }

  try {
    if (cmd === "info") {
      canon.initDb();
      const counts = world.counts();
      const canonCounts = {
        entities: canon.listEntities({ limit: 100000 }).length,
        relations: canon.listRelations({ limit: 200000 }).length,
      };
      print(globals, wrap({ world: counts, canon: canonCounts, worldPath, canonPath }));
      return;
    }

    if (cmd === "list" && sub === "states") {
      const states = world.listStates().map((s) => ({ id: s.id, name: s.name, form: s.formName ?? s.form, color: s.color }));
      states.sort((a, b) => a.name.localeCompare(b.name));
      print(globals, wrap(states));
      return;
    }

    if (cmd === "list" && sub === "burgs") {
      let stateFilter: string | undefined;
      let top = 50;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--state") stateFilter = args[++i];
        else if (a && a.startsWith("--state=")) stateFilter = a.split("=", 2)[1];
        else if (a === "--top") top = Number(args[++i]);
        else if (a && a.startsWith("--top=")) top = Number(a.split("=", 2)[1]);
      }

      let burgs = world.listBurgs();
      if (stateFilter) {
        const sid = world.resolveStateId(stateFilter);
        if (sid !== undefined) burgs = burgs.filter((b) => b.state === sid);
      }

      burgs.sort((a, b) => Number(b.population ?? b.pop ?? 0) - Number(a.population ?? a.pop ?? 0));
      burgs = burgs.slice(0, top);
      const out = burgs.map((b) => ({
        id: b.id,
        name: b.name,
        state: b.state,
        population: b.population ?? b.pop,
        capital: b.capital,
        port: b.port,
      }));
      print(globals, wrap(out));
      return;
    }

    if (cmd === "show" && sub === "state") {
      const q = args.join(" ").trim();
      if (!q) throw new Error("Missing state id or name");
      const state = world.getState(q);
      if (!state) throw new Error("State not found");
      print(globals, wrap(state));
      return;
    }

    if (cmd === "show" && sub === "burg") {
      const q = args.join(" ").trim();
      if (!q) throw new Error("Missing burg id or name");
      const burg = world.getBurg(q);
      if (!burg) throw new Error("Burg not found");
      print(globals, wrap(burg));
      return;
    }

    if (cmd === "cell") {
      const q = args[0];
      if (!q) throw new Error("Missing cell id");
      const id = Number(q);
      const cell = world.getCell(id);
      if (!cell) throw new Error("Cell not found");
      print(globals, wrap(cell));
      return;
    }

    if (cmd === "search") {
      const term = args[0];
      if (!term) throw new Error("Missing search term");
      let kinds: string[] | undefined;
      let limit = globals.limit ?? 20;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "--kinds") kinds = String(args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (a?.startsWith("--kinds=")) kinds = a.split("=", 2)[1].split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--limit") limit = Number(args[++i]);
        else if (a?.startsWith("--limit=")) limit = Number(a.split("=", 2)[1]);
      }
      const res = world.search(term, kinds, limit);
      print(globals, wrap(res));
      return;
    }

    if (cmd === "canon") {
      canon.initDb();

      const action = sub;
      if (action === "init") {
        print(globals, wrap({ ok: true, canonPath }));
        return;
      }

      if (action === "add") {
        const type = args[0] as EntityType | undefined;
        if (!type) throw new Error("Missing entity type");

        const flags = args.slice(1);
        const get = (name: string): string | undefined => {
          const idx = flags.indexOf(name);
          if (idx >= 0) return flags[idx + 1];
          const pref = name + "=";
          const hit = flags.find((x) => x.startsWith(pref));
          return hit ? hit.slice(pref.length) : undefined;
        };

        const name = get("--name");
        if (!name) throw new Error("--name is required");

        const summary = get("--summary") ?? null;
        const details_md = get("--details-md") ?? null;
        const tags = (get("--tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const payload = (await readJsonArgAsync(get("--payload-json"))) as any;
        const burgId = get("--burg") ? Number(get("--burg")) : undefined;
        const stateId = get("--state") ? Number(get("--state")) : undefined;

        const anchors: any = {};
        if (typeof burgId === "number" && !Number.isNaN(burgId)) anchors.burgId = burgId;
        if (typeof stateId === "number" && !Number.isNaN(stateId)) anchors.stateId = stateId;

        const ent = canon.addEntity({ type, name, summary, details_md, tags, anchors, payload: payload ?? {} });
        print(globals, wrap(ent));
        return;
      }

      if (action === "show") {
        const id = args[0];
        if (!id) throw new Error("Missing entity id");
        const e = canon.getEntity(id);
        if (!e) throw new Error("Not found");
        const rels = canon.listRelations({ entity_id: id, limit: 500 });
        print(globals, wrap({ entity: e, relations: rels }));
        return;
      }

      if (action === "list") {
        const flags = args;
        const get = (name: string): string | undefined => {
          const idx = flags.indexOf(name);
          if (idx >= 0) return flags[idx + 1];
          const pref = name + "=";
          const hit = flags.find((x) => x.startsWith(pref));
          return hit ? hit.slice(pref.length) : undefined;
        };
        const type = (get("--type") as EntityType | undefined) ?? undefined;
        const tag = get("--tag") ?? undefined;
        const text = get("--text") ?? undefined;
        const limit = get("--limit") ? Number(get("--limit")) : (globals.limit ?? 50);
        const burgId = get("--burg") ? Number(get("--burg")) : undefined;
        const stateId = get("--state") ? Number(get("--state")) : undefined;
        const campaignName = get("--campaign") ?? undefined;

        const anchors: any = {};
        if (typeof burgId === "number" && !Number.isNaN(burgId)) anchors.burgId = burgId;
        if (typeof stateId === "number" && !Number.isNaN(stateId)) anchors.stateId = stateId;

        let ents = canon.listEntities({ type, tag, text, limit, anchors: Object.keys(anchors).length ? anchors : undefined });

        if (campaignName) {
          const campaignStore = new CampaignStore(canon.db);
          campaignStore.initDb();
          const camp =
            campaignStore.listCampaigns({ status: "open" }).find((c) => c.name === campaignName) ??
            campaignStore.listCampaigns({ status: "archived" }).find((c) => c.name === campaignName);
          if (!camp) {
            throw new Error(`No campaign named '${campaignName}'`);
          }
          ents = ents.filter((e) => (e.provenance as any)?.campaign_id === camp.id);
        }

        print(globals, wrap(ents));
        return;
      }

      if (action === "patch") {
        const id = args[0];
        if (!id) throw new Error("Missing entity id");
        const flags = args.slice(1);
        const idx = flags.indexOf("--patch-json");
        const patchStr = idx >= 0 ? flags[idx + 1] : flags.find((x) => x.startsWith("--patch-json="))?.split("=", 2)[1];
        if (!patchStr) throw new Error("--patch-json is required");
        const patch = (await readJsonArgAsync(patchStr)) as any;
        const updated = canon.patchEntity(id, patch);
        if (!updated) throw new Error("Not found");
        print(globals, wrap(updated));
        return;
      }

      if (action === "link") {
        const flags = args;
        const get = (name: string): string | undefined => {
          const idx = flags.indexOf(name);
          if (idx >= 0) return flags[idx + 1];
          const pref = name + "=";
          const hit = flags.find((x) => x.startsWith(pref));
          return hit ? hit.slice(pref.length) : undefined;
        };

        const from = get("--from-id");
        const to = get("--to-id");
        const rel = get("--rel");
        if (!from || !to || !rel) throw new Error("--from-id, --to-id, and --rel are required");

        const strength = get("--strength") ? Number(get("--strength")) : null;
        const notes = get("--notes") ?? null;

        const r = canon.addRelation({ from_id: from, to_id: to, rel_type: rel, strength, notes });
        print(globals, wrap(r));
        return;
      }

      if (action === "export") {
        const outIdx = args.indexOf("--out");
        const out = outIdx >= 0 ? args[outIdx + 1] : args.find((x) => x.startsWith("--out="))?.split("=", 2)[1];
        if (!out) throw new Error("--out required");
        const snap = canon.exportSnapshot();
        await Bun.write(out, JSON.stringify(snap, null, 2));
        print(globals, wrap({ written: out, entities: snap.entities.length, relations: snap.relations.length }));
        return;
      }

      if (action === "import") {
        const inIdx = args.indexOf("--input");
        const input = inIdx >= 0 ? args[inIdx + 1] : args.find((x) => x.startsWith("--input="))?.split("=", 2)[1];
        if (!input) throw new Error("--input required");
        const mode = (args.find((x) => x.startsWith("--mode="))?.split("=", 2)[1] ?? (args[args.indexOf("--mode") + 1] ?? "upsert")) as
          | "upsert"
          | "insert";
        const txt = await Bun.file(input).text();
        const json = JSON.parse(txt);
        const res = canon.importSnapshot(json, mode);
        print(globals, wrap({ imported_from: input, ...res }));
        return;
      }

      if (action === "ingest") {
        const flags = args;
        const get = (name: string): string | undefined => {
          const idx = flags.indexOf(name);
          if (idx >= 0) return flags[idx + 1];
          const pref = name + "=";
          const hit = flags.find((x) => x.startsWith(pref));
          return hit ? hit.slice(pref.length) : undefined;
        };

        const file = get("--file");
        if (!file) throw new Error("--file is required");
        const text = await Bun.file(file).text();
        const name = get("--name");
        const scope = get("--scope") ?? "world";
        const apply = flags.includes("--apply");
        const burgId = get("--burg") ? Number(get("--burg")) : undefined;
        const stateId = get("--state") ? Number(get("--state")) : undefined;
        const eraId = get("--era-id") ?? undefined;

        const anchors: Record<string, any> = {};
        if (typeof burgId === "number" && !Number.isNaN(burgId)) anchors.burgId = burgId;
        if (typeof stateId === "number" && !Number.isNaN(stateId)) anchors.stateId = stateId;
        if (eraId) anchors.eraId = eraId;

        const provider = getEffectiveGenerationProvider(config) || getEffectiveProvider(config);
        const model = getEffectiveGenerationProvider(config)
          ? getEffectiveGenerationModel(config, provider)
          : getEffectiveModel(config, provider);
        const llm = createLLMClient({ provider, model });

        const result = await parseSourceText(
          { canon, world, llm },
          { name, text, scope, anchors, apply }
        );

        print(globals, wrap({
          sourceText: {
            id: result.sourceText.id,
            name: result.sourceText.name,
            parseStatus: result.sourceText.payload?.parseStatus,
          },
          applied: result.applied,
          summary: result.plan.summary,
          creates: result.plan.creates,
          updates: result.plan.updates,
          relations: result.plan.relations,
          relationTypeDefinitions: result.plan.relationTypeDefinitions,
          unresolvedReferences: result.plan.unresolvedReferences,
          cautions: result.plan.cautions,
          usage: result.usage,
          appliedCounts: result.applied ? {
            createdEntities: result.createdEntities?.length ?? 0,
            updatedEntities: result.updatedEntities?.length ?? 0,
            createdRelations: result.createdRelations?.length ?? 0,
            definedRelationTypes: result.definedRelationTypes?.length ?? 0,
          } : undefined,
        }));
        return;
      }

      throw new Error("Unknown canon action");
    }

    if (cmd === "idea") {
      canon.initDb();
      const action = sub;

      const flags = args;
      const getFlag = (name: string): string | undefined => {
        const idx = flags.indexOf(name);
        if (idx >= 0) return flags[idx + 1];
        const pref = name + "=";
        const hit = flags.find((x) => x?.startsWith(pref));
        return hit ? hit.slice(pref.length) : undefined;
      };
      const hasFlag = (name: string) => flags.includes(name);

      const formatIdea = (e: any) => {
        const payload = e.payload || {};
        const text = e.details_md || e.summary || e.name;
        return {
          id: e.id,
          text,
          summary: e.summary,
          status: payload.status ?? "pending",
          labels: Array.isArray(payload.labels) ? payload.labels : [],
          labelsStatus: payload.labelsStatus ?? "pending",
          usedByEntityId: payload.usedByEntityId ?? null,
          usedAt: payload.usedAt ?? null,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
        };
      };

      if (action === "add") {
        const text = (args[0] && !args[0].startsWith("--")) ? args[0] : undefined;
        if (!text) throw new Error("idea text is required (azcli idea add \"<text>\")");

        const rawLabels = getFlag("--labels");
        const explicitLabels = rawLabels
          ? rawLabels.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        const noLabel = hasFlag("--no-label");

        let llm: LLMClient | undefined;
        if (!explicitLabels && !noLabel) {
          llm = buildGenerationLLM(config);
        }

        const ent = await addIdea(canon, {
          text,
          labels: noLabel ? [] : explicitLabels,
          kickOffLabeling: !noLabel && !explicitLabels,
          llm,
        });
        if (noLabel && !explicitLabels) {
          // Mark as skipped instead of pending so auto-drains leave it alone.
          const updated = canon.patchEntity(ent.id, { payload: { labelsStatus: "skipped" } });
          print(globals, wrap(formatIdea(updated ?? ent)));
          return;
        }
        print(globals, wrap(formatIdea(ent)));
        return;
      }

      if (action === "list") {
        const statusFlag = (getFlag("--status") ?? "pending") as any;
        if (!["pending", "used", "all"].includes(statusFlag)) {
          throw new Error("--status must be pending, used, or all");
        }
        const label = getFlag("--label");
        const limit = getFlag("--limit") ? Number(getFlag("--limit")) : (globals.limit ?? 100);
        const ideas = listIdeas(canon, { status: statusFlag, label, limit });
        print(globals, wrap(ideas.map(formatIdea)));
        return;
      }

      if (action === "show") {
        const id = args[0];
        if (!id) throw new Error("Missing idea id");
        const idea = getIdea(canon, id);
        if (!idea) throw new Error("Idea not found");
        const usedById = idea.payload?.usedByEntityId as string | undefined;
        const usedBy = usedById ? canon.getEntity(usedById) : undefined;
        const formatted = formatIdea(idea);
        print(globals, wrap({
          ...formatted,
          usedBy: usedBy ? { id: usedBy.id, type: usedBy.type, name: usedBy.name } : null,
        }));
        return;
      }

      if (action === "mark-used") {
        const id = args[0];
        if (!id) throw new Error("Missing idea id");
        const byEntity = getFlag("--by-entity");
        const updated = markIdeaUsed(canon, id, byEntity);
        if (!updated) throw new Error("Idea not found");
        print(globals, wrap(formatIdea(updated)));
        return;
      }

      if (action === "remove") {
        const id = args[0];
        if (!id) throw new Error("Missing idea id");
        const removed = deleteIdea(canon, id);
        if (!removed) throw new Error("Idea not found");
        print(globals, wrap({ removed: true, id }));
        return;
      }

      if (action === "relabel") {
        const id = args[0];
        if (!id) throw new Error("Missing idea id");
        const idea = getIdea(canon, id);
        if (!idea) throw new Error("Idea not found");
        const llm = buildGenerationLLM(config);
        if (!llm) throw new Error("No LLM configured for labeling. Set LLM_PROVIDER and credentials.");
        const text = idea.details_md || idea.summary || idea.name;
        const labels = await suggestLabelsForIdea(text, llm);
        const updated = setIdeaLabels(canon, id, labels);
        print(globals, wrap({
          idea: formatIdea(updated ?? idea),
          producedLabels: labels.length,
        }));
        return;
      }

      if (action === "label-pending") {
        const concurrencyArg = getFlag("--concurrency");
        const concurrency = concurrencyArg ? Math.max(1, Number(concurrencyArg)) : 2;
        const llm = buildGenerationLLM(config);
        if (!llm) throw new Error("No LLM configured for labeling. Set LLM_PROVIDER and credentials.");
        const result = await runPendingIdeaLabeling(canon, llm, { concurrency });
        print(globals, wrap(result));
        return;
      }

      throw new Error("Unknown idea action");
    }

    if (cmd === "export" && sub === "wiki") {
      const outIdx = args.indexOf("--out");
      const out = outIdx >= 0 ? args[outIdx + 1] : args.find((x) => x.startsWith("--out="))?.split("=", 2)[1];
      if (!out) throw new Error("--out is required");
      canon.initDb();
      const res = await exportWiki(out, world, canon);
      print(globals, wrap(res));
      return;
    }

    print(globals, wrap({ error: "Unknown command", help: usage() }));
  } catch (e: any) {
    const env = globals.json ? err("CLI_ERROR", e?.message ?? String(e)) : { error: e?.message ?? String(e) };
    print(globals, env);
    process.exit(1);
  } finally {
    canon.close();
  }
}

main();
