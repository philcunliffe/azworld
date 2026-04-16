# azworld (Bun + TypeScript)

A small toolkit for treating an **Azgaar Fantasy Map Generator** JSON export as a local "world API" and layering **mutable, LLM-generated canon** on top of it.

It includes:
- `azcli` — query the Azgaar world JSON + manage a canon SQLite DB
- `azbrowse` — terminal browser with REPL and full-screen TUI for navigation, generation, simulation, and canon edits
- `azchat` — terminal chatbot that can *lazily* generate NPCs, taverns, and underworld factions on demand using **Ollama**, **OpenAI**, or **Anthropic**
- `azweb` — local-only web application that exposes the browse/chat/tooling surface in a browser

## Requirements

- [Bun](https://bun.sh/) (runs TypeScript directly)
- An Azgaar map export in JSON ("Full JSON export" is recommended)
- Optional LLM provider:
  - Ollama running locally, **or**
  - OpenAI API key, **or**
  - Anthropic API key

## Setup

```bash
# from this repo folder
bun install

# copy env template
cp .env.example .env
# edit .env to select your provider and model
```

Put your world file at `data/world.json` (or pass `--world`).

## azcli

```bash
# world + canon stats
bun run azcli -- --world data/world.json --canon data/canon.db info --pretty

# list the largest cities
bun run azcli -- list burgs --top 20 --pretty

# show a city
bun run azcli -- show burg "Port Something" --pretty

# search names
bun run azcli -- search "Port" --kinds burgs --limit 10 --pretty

# canon: add an NPC anchored to burg 12
bun run azcli -- canon add npc --name "Kara Rill" --summary "Tired bartender" --tags tavern --burg 12 --pretty

# canon: export snapshot
bun run azcli -- canon export --out canon.snapshot.json

# wiki export
bun run azcli -- export wiki --out ./wiki --pretty
```

## azchat

```bash
bun run azchat -- --world data/world.json --canon data/canon.db
```

Try a prompt like:

> My heroes are in a tavern in **Rivermarch** with ties to the criminal underworld.

Useful commands:
- `/where` — show current city/location
- `/talk <npc name>` — switch to a roleplayed NPC
- `/back` — return to Director mode
- `/wiki <outDir>` — export Markdown wiki

## azbrowse

```bash
bun run azbrowse -- --world data/world.json --canon data/canon.db
bun run azbrowse -- --tui
```

The browse tool covers navigation, search, canon inspection, LLM generation, natural-language modification, time advancement, and onboarding-driven world initialization.

## azweb

```bash
bun run azweb -- --world data/world.json --canon data/canon.db
```

By default the web app binds to `127.0.0.1:4310` only. You can override the port:

```bash
bun run azweb -- --port 4388
```

`azweb` reuses the existing browse/chat/world-generation logic instead of reimplementing it. The browser UI includes:
- explorer views for world, factions, religions, cultures, and canon entity types
- detail panels with raw entity/world data and relation inspection
- a command console that exposes the full browse command surface
- approval flows for generation, modification, simulation, field regeneration, and phased world init
- director and NPC chat
- campaign settings, model switching, source ingest, wiki export, and canon snapshot import/export

## Design Notes (quick)

- The **Azgaar export is treated as read-only** (baseline geography + civ data).
- All new content (NPCs, taverns, factions) is stored in `canon.db`.
- The chat app generates content as JSON, validates it, inserts canonical entities, and links them with relations.

## Provider Notes

- **Ollama**: uses `/api/chat` and (optionally) `format: "json"` for structured output.
- **OpenAI**: uses the **Responses API** (`POST /v1/responses`) with `text.format` set for JSON mode.
- **Anthropic**: uses **Messages API** (`POST /v1/messages`) with the required `anthropic-version` header.

(If any provider changes their API format, adjust the small adapter in `src/llm/providers.ts`.)

## License

MIT (feel free to adapt).


## Roadmap
- See `docs/FUTURE_DESIGN.md` for planned next steps.
- See `docs/LLM_PROVIDERS.md` for provider configuration notes.
