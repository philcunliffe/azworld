# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

azworld is a TypeScript/Bun CLI toolkit for world-building that layers mutable, LLM-generated canonical content on top of Azgaar Fantasy Map Generator exports. It consists of three main applications:
- **azcli** — Query-focused CLI for world lookup, canon CRUD, and wiki export
- **azchat** — Interactive terminal chatbot with "Director" (scene orchestration) and "NPC" (character roleplay) modes
- **azbrowse** — File-system-like navigation through world and canon entities with REPL or full-screen TUI mode

## Commands

```bash
# Install dependencies
bun install

# TypeScript type checking (no emit)
npm run typecheck

# Run CLI tool
bun run azcli -- --world data/world.json --canon data/canon.db <command>

# Run chat tool
bun run azchat -- --world data/world.json --canon data/canon.db

# Run browse tool (REPL or TUI mode)
bun run azbrowse -- --world data/world.json --canon data/canon.db
bun run azbrowse -- --tui  # Full-screen TUI mode

# Common azcli commands
bun run azcli -- info --pretty
bun run azcli -- list burgs --top 20 --pretty
bun run azcli -- show burg "Port Something" --pretty
bun run azcli -- search "Port" --kinds burgs --limit 10
bun run azcli -- canon add npc --name "Kara Rill" --summary "Tired bartender" --tags tavern --burg 12
bun run azcli -- export wiki --out ./wiki --pretty

# Debug logging (writes to ./logs/)
bun run azbrowse -- --debug
bun run azchat -- --debug
```

## Architecture

### Two-Layer World Model
1. **Immutable Layer:** Azgaar JSON export (`data/world.json`) — read-only fantasy map data
2. **Mutable Canon Layer:** SQLite database (`data/canon.db`) — all LLM-generated and user-created entities

### Source Structure
- `src/browse/` — File-system-like navigation CLI with REPL and full-screen TUI modes
- `src/canon/` — SQLite-based entity store (Entity/Relation CRUD, snapshots)
- `src/chat/` — Interactive chatbot (REPL, director scene generation, NPC roleplay)
- `src/cli/` — Command-line interface for queries and management
- `src/llm/` — Unified LLM provider abstraction (Ollama, OpenAI, Anthropic)
- `src/util/` — Utilities (args parsing, fuzzy matching, JSON merge-patch, envelope responses)
- `src/wiki/` — Markdown wiki export with YAML frontmatter (templates in `src/wiki/templates/`)
- `src/world/` — Azgaar world parsing, indexing, and lookup

### LLM Provider Support
Unified interface supporting three backends configured via `.env`:
- **Ollama** (local, default) — `/api/chat` with JSON mode
- **OpenAI** — Responses API with JSON schema support
- **Anthropic** — Messages API with tool-use or JSON-only prompts

Configuration supports separate models for different tasks:
- `LLM_PROVIDER`/`*_MODEL` — Primary chat/director model
- `LLM_GENERATION_PROVIDER`/`*_GENERATION_MODEL` — Entity generation (optional, falls back to primary)
- `LLM_TALK_PROVIDER`/`*_TALK_MODEL` — NPC roleplay (optional, falls back to generation)

## Key Patterns

- **Read-only world layer:** Azgaar exports are never modified; mutable state lives in canon DB
- **Provenance tracking:** Generated entities record source, timestamp, and user intent
- **Zod validation:** Runtime schema validation for all structured data and LLM outputs
- **Envelope responses:** CLI uses `{ok: true, data}` / `{error, code}` when `--json` flag is set
- **Bun-native APIs:** Uses `Bun.file()`, `Bun.write()`, `Database` from `bun:sqlite`
- **Manual CLI parsing:** No framework; custom arg extraction in `src/util/args.ts`

## Canon Entity Types

`npc`, `faction`, `location`, `event`, `rumor`, `hook`, `meta`, `culture`, `religion`, `deity`

Each entity has: id, type, name, summary, details_md, tags[], anchors (link to world entities like burgId), payload, meta, provenance, timestamps.

### Pantheon System

Deities are structured divine entities belonging to religions. A religion's pantheon is the set of `deity` entities anchored to it via `azgaarReligionId`.

**Deity Payload Fields:**
- `rank`: "supreme" | "greater" | "lesser" | "demigod" | "spirit"
- `domains`: string[] (e.g., ["war", "justice", "storms"])
- `alignment`: string (e.g., "benevolent", "wrathful")
- `symbols`, `titles`: string[]
- Optional: `sacredAnimal`, `sacredElement`, `festivals[]`, `appearance`, `mythology`, `worshipStyle`

**Form-to-Count:** Religion form determines deity count during generation:
- Monotheism=1, Dualism=2, Polytheism=5-12, Shamanism=3-8, Folk=2-6

**Inter-deity Relations:** `parent_of`, `sibling_of`, `consort_of`, `rival_of`, `aspect_of`
**Cross-entity Relations:** `patron_of` (deity→faction/npc), `dedicated_to` (location→deity), `belongs_to` (deity→religion)

### Event Scope Model

Events support geographic scopes that enable context-aware generation:

**Scope Hierarchy:** `neighborhood < burg < state < region < world`

**Event Payload Fields:**
- `scope`: Geographic impact level ("neighborhood" | "burg" | "state" | "region" | "world")
- `severity`: Impact intensity ("minor" | "moderate" | "major" | "catastrophic")
- `daysAgo`: When the event occurred (0 = ongoing/just happened)
- `ongoing`: Boolean indicating if event is still happening

**Scope-Aware Queries:**
- Generation tools automatically query events affecting a location using `getActiveEvents()`
- Query checks upward through scope hierarchy (e.g., burg-scope event affects that burg; state-scope affects all burgs in state; world-scope affects everything)
- Default recency window: 90 days
- Events are included in generation prompts via `formatEventContext()` to ensure generated content reflects current world state

**Example:** A catastrophic earthquake (scope: state, severity: catastrophic, daysAgo: 3, ongoing: true) will automatically influence all location/NPC generation in that state for the next 90 days, creating consistent, context-aware worldbuilding.

**Future Enhancements:** This model enables event propagation (events triggering other events) and awareness tracking (which actors know about which events).

## Campaign Settings

Interactive sessions (azchat, azbrowse) support campaign settings stored in canon DB as a `meta` entity. Settings include vibe, quest types, tone, and generation flags. On first run without settings, the app offers onboarding to configure these. Use `/init` to reconfigure.

## Current Limitations (MVP)

- No test suite (roadmap in `docs/FUTURE_DESIGN.md`)
- Keyword-based intent detection in chat (planned replacement with pure tool-use architecture)
- No linting/formatting tools configured

## Setup

```bash
cp .env.example .env
# Edit .env to set LLM_PROVIDER and model settings
# Place Azgaar export at data/world.json (or use --world flag)
```
