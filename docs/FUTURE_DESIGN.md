# Future Design Document (Roadmap)

This document describes **planned next steps** for the Azgaar-backed CLI (`azcli`) and terminal LLM chatbot (`azchat`).
It is intentionally forward-looking: the current implementation is an MVP, and this outlines how to evolve it into a robust
world-simulation and storytelling toolchain.

Last updated: 2026-01-24

---

## 1. Big Picture

### 1.1 Two-layer world model (unchanged)
- **Immutable layer:** Azgaar "Full JSON" export (read-only).
- **Mutable canon layer:** SQLite database (`canon.db`) storing all additions (NPCs, locations, factions, events, sessions).

### 1.2 Principle: Canon first, generation second
The system should always:
1. Resolve grounding context from Azgaar (`world.lookup*` tools)
2. Query existing canon entities/relations (`canon.query`, `canon.getActiveEvents`)
3. **Only generate what is missing** (lazy generation via `generate.*` tools)
4. Persist additions with provenance (`canon.upsert`, `canon.link`)

The Director LLM is prompted to follow this order. It has tools for both querying and generating,
and should prefer querying first. Generation prompts receive existing entities as context to
maintain consistency and avoid duplication.

---

## 2. Planned Improvements (Core)

### 2.1 Pure Tool-Use Architecture (replace keyword heuristics)
**Problem:** keyword triggers are brittle ("union hall", "canteen", "alehouse") and limit creativity.
A structured extraction step adds latency and artificially constrains what the system can understand.

**Plan:** give the Director LLM direct access to tools and let it reason about what to do.
No intermediate extraction layer — the LLM receives raw user text, current context, and tool definitions,
then decides which tools to call and in what order.

#### Why Pure Tool-Use?
- **Maximum flexibility:** handles any user request without predefined intent categories
- **Simpler architecture:** one LLM call with tools instead of extraction → routing → generation
- **Natural reasoning:** the LLM already understands "a massive earthquake struck the town" — no need to parse it into a schema first
- **Emergent capabilities:** the LLM can combine tools in ways we didn't anticipate

#### Open Vocabulary Principle
All entity fields that describe "kind" or "type" are **free-form strings**, not enums.
The LLM invents or reuses types based on narrative context:
- Locations: `"tavern"`, `"guild-bank"`, `"temple-crypts"`, `"underground-fighting-pit"`, `"ancient-ruins"`
- Events: `"earthquake"`, `"coronation"`, `"assassination"`, `"festival"`, `"plague-outbreak"`
- Roles: `"guild-master"`, `"street-urchin"`, `"disgraced-priest"`, `"retired-adventurer"`

The system learns from history: canon stores each entity's kind, enabling fuzzy reuse queries.

---

### 2.2 Director Tool Definitions

The Director LLM has access to these tools:

#### World Layer (read-only)
| Tool | Purpose |
|------|---------|
| `world.lookupBurg(query)` | Fuzzy search for cities by name |
| `world.lookupState(query)` | Fuzzy search for countries/states |
| `world.getBurgDetails(burgId)` | Full burg data: population, culture, religion, trade |
| `world.getStateDetails(stateId)` | State data: ruler type, neighbors, military |
| `world.getRegion(burgId)` | Geographic context: nearby burgs, routes, terrain |

#### Canon Layer (read/write)
| Tool | Purpose |
|------|---------|
| `canon.query(filters)` | Search entities by type, tags, anchor, kind |
| `canon.getActiveEvents(anchor, includeParentScopes)` | Get events affecting a location (see §2.3) |
| `canon.upsert(entity)` | Create or update an entity |
| `canon.link(fromId, toId, relationType, notes)` | Create a relation between entities |
| `canon.unlink(fromId, toId, relationType)` | Remove a relation |

#### Generation (returns entities, does not persist)
| Tool | Purpose |
|------|---------|
| `generate.location(spec, context)` | Generate a place with NPCs |
| `generate.npcs(spec, context)` | Generate characters |
| `generate.faction(spec, context)` | Generate an organization |
| `generate.event(spec, context)` | Generate an event with consequences |
| `generate.lore(subject, aspect, context)` | Generate world-building details (holidays, customs, history) |

#### Session
| Tool | Purpose |
|------|---------|
| `session.setLocation(locationId)` | Set current scene location |
| `session.enterNpcMode(npcId)` | Switch to NPC roleplay mode |
| `session.narrate(text)` | Output narrative text to user |

#### Tool Call Flow
```
User: "The heroes enter a tavern in Thornwall"
                    ↓
Director LLM receives:
  - User text
  - Current context (location, recent entities)
  - Tool definitions
                    ↓
LLM reasons and calls tools:
  1. world.lookupBurg("Thornwall") → { burgId: 42, ... }
  2. canon.getActiveEvents({ burgId: 42 }, true) → [{ name: "The Great Quake", ... }]
  3. canon.query({ type: "location", kind: "tavern", burgId: 42 }) → []
  4. generate.location({ kind: "tavern", ... }, { activeEvents: [...] })
  5. canon.upsert(generatedTavern)
  6. session.setLocation(tavernId)
  7. session.narrate("You push through the creaking door...")
                    ↓
Response to user with narrative
```

---

### 2.3 Event Scope Model

Events have inherent geographic scope that determines what they affect:

| Scope | Affects | Examples |
|-------|---------|----------|
| `neighborhood` | Single district within a city | Bar fight, small fire, gang turf war |
| `burg` | Entire city | Earthquake, plague outbreak, festival, siege |
| `state` | Whole country | Monarch death, civil war, famine, new law, trade embargo |
| `region` | Multiple neighboring states | Religious schism, major war, dragon awakening |
| `world` | Everything | Cataclysm, deity death, magic failure, planar breach |

#### Event Schema
```typescript
{
  type: "event",
  name: "The Great Quake",
  kind: "natural-disaster",        // open vocabulary
  scope: "burg",                   // determines propagation
  severity: "catastrophic",        // "minor" | "moderate" | "major" | "catastrophic"
  anchor: { burgId: 42 },          // where it's centered
  ongoing: false,                  // still happening?
  daysAgo: 3,                      // when it occurred
  consequences: [                  // generated or user-specified
    { type: "damage", target: "buildings", severity: "heavy" },
    { type: "displacement", count: "hundreds" },
    { type: "mood", effect: "fearful, rebuilding" }
  ]
}
```

#### Scope-Aware Context Queries

When gathering context for generation, the Director queries upward through scopes:

```typescript
canon.getActiveEvents({
  anchor: { burgId: 42, stateId: 7, regionId: 2 },
  includeParentScopes: true,   // queries burg → state → region → world
  recency: "90 days"           // how far back to look
})
```

Returns all events that would affect this location:
```json
[
  { "name": "The Great Quake", "scope": "burg", "daysAgo": 3 },
  { "name": "King Aldric's Death", "scope": "state", "daysAgo": 12 },
  { "name": "The Long Winter", "scope": "region", "ongoing": true }
]
```

#### Context-Aware Generation

Generation tools receive active events as context. The generation prompt incorporates them:

```
Generate a tavern in Thornwall.

ACTIVE EVENTS AFFECTING THIS LOCATION:
- The Great Quake (burg-level, 3 days ago, catastrophic): heavy building damage, hundreds displaced
- King Aldric's Death (state-level, 12 days ago, major): nation in mourning
- The Long Winter (region-level, ongoing): scarce supplies, harsh conditions

The generated location should reflect these conditions naturally.
```

Result: tavern with cracked walls, mourning banners, watered-down ale, refugees sheltering in the common room, talk of succession crisis.

---

### 2.4 Deduplication and Niche Coverage
**Problem:** on-demand faction generation can create many similar orgs.

**Plan:**
- Add a `nicheKey` field to factions (e.g., `criminal:smuggling:docks`, `guild:mining:safety`)
- The `canon.query` tool supports niche-based searches
- Generation prompts include existing entities to avoid duplication
- The Director LLM is instructed to check for existing entities before generating

#### Collision Avoidance
When the user says "tell me about the thieves guild here," the Director should:
1. `canon.query({ type: "faction", tags: ["criminal", "thieves"], burgId: 42 })`
2. If found → describe existing faction
3. If not found → `generate.faction({ kind: "thieves-guild", ... })`

#### Coverage Hints
Generation prompts can include "missing niches" based on burg features:
```
This is a major port city. Existing factions: Merchant's Guild, City Watch.
Consider what organizations might be missing: dock workers union?
smuggling ring? foreign trade delegation? fishermen's collective?
```

The LLM uses these hints but isn't constrained by them.

---

## 3. World Simulation Extensions

### 3.1 Event Ripple System (awareness + consequences)

Building on the event scope model (§2.3), events propagate awareness and trigger reactions.

#### Awareness Levels
| Level | Meaning | Typical Source |
|-------|---------|----------------|
| `unknown` | Actor has no knowledge | Default state |
| `rumor` | Heard something, details unclear | Travelers, merchants, gossip |
| `confirmed` | Verified information | Official messengers, witnesses |
| `intimate` | Deep personal knowledge | Direct involvement, spies |

#### Propagation Rules
Awareness spreads based on:
- **Scope:** world events reach everywhere; neighborhood events stay local
- **Distance:** measured via trade routes, not just coordinates
- **Hubs:** ports and capitals learn faster
- **Severity:** catastrophic events spread faster than minor ones
- **Time:** awareness decays or upgrades over days/weeks

```typescript
// Example: earthquake in Thornwall (burg-scope, catastrophic)
// Day 1: Thornwall has intimate awareness
// Day 3: neighboring burgs have confirmed (via refugees)
// Day 7: state capital has confirmed (via messengers)
// Day 14: distant states have rumor (via merchants)
```

#### Awareness Table
```sql
CREATE TABLE event_awareness (
  actor_type TEXT,      -- 'burg' | 'state' | 'faction' | 'npc'
  actor_id INTEGER,
  event_id INTEGER,
  level TEXT,           -- 'unknown' | 'rumor' | 'confirmed' | 'intimate'
  updated_at TEXT,
  UNIQUE(actor_type, actor_id, event_id)
);
```

### 3.2 LLM-Assisted Reactions (with guardrails)

When an actor crosses an awareness threshold, the system can generate reactions:

#### Reaction Flow
1. Gather actor profile + constraints + awareness context
2. Call `generate.reaction(actor, event, awarenessLevel)`
3. LLM proposes 3–5 candidate reactions
4. Filter candidates through policy rules:
   - Reject impossible actions (landlocked state can't send navy)
   - Reject contradictions with locked canon
   - Apply cooldowns (no rapid whiplash)
5. Select best remaining candidate (or let user choose)
6. Persist as structured records, surface as rumors/hooks

#### Reaction Types
- **Political:** alliances shift, embargoes declared, troops mobilized
- **Economic:** trade routes change, prices spike, hoarding
- **Social:** festivals, mourning periods, migrations
- **Factional:** power grabs, purges, recruitment drives

#### Example
```
Event: King Aldric's Death (state-scope, major)
Actor: Merchant's Guild in Thornwall
Awareness: confirmed (day 5)

Generated reactions:
1. Halt major transactions pending succession clarity
2. Send delegation to capital to curry favor with likely heir
3. Stockpile goods anticipating instability
4. [Selected] Begin quiet outreach to rival claimant's faction

→ Creates: relation(merchants_guild, rival_faction, "covert-support")
→ Creates: rumor("The guild masters have been seen meeting with northern emissaries")
```

---

## 4. Data Model Evolution

### 4.1 Promote "Neighborhood" as first-class entity
Since `location.kind` is open vocabulary, neighborhoods are just another kind:
- `"kind": "neighborhood"` with themes like `["docks", "working-class", "rough"]`
- `"kind": "district"` for larger areas
- `"kind": "quarter"` for cultural zones

Use cases:
- Anchor child locations ("The Rusty Anchor tavern in Dockward")
- Define faction turf boundaries
- Provide recurring local color and atmosphere

### 4.2 Sessions + timeline
Add entities:
- `session` (play log)
- `scene` (structured summary, participants, created entities)
- `timeline_entry` (public record of big changes)

This helps with wiki export and "what changed since last time?"

### 4.3 Canon locks and retcons
- `meta.canonLock = true` prevents LLM-driven edits.
- Retcons require explicit `/retcon` or CLI flag and are stored as:
  - overlays (preferred) or
  - patch history entries with provenance.

---

## 5. Provider + Runtime Enhancements

### 5.1 Streaming output
- OpenAI + Anthropic support streaming; Ollama supports streaming responses too.
- Add a unified streaming interface for the terminal UI.

### 5.2 Caching and cost control
- Cache expensive generations keyed by:
  - anchor ids + prompt version + tone hash
- Provide `/regen` and `/invalidate` commands.

### 5.3 Safety + content controls
Add optional campaign constraints:
- rating / disallowed topics
- violence explicitness
- bias controls
Enforce at prompt level and with post-generation checks.

---

## 6. Wiki Export Roadmap

### 6.1 Deterministic link structure
- stable filenames based on `{type}-{slug}-{shortId}.md`
- backlinks section auto-generated via relations

### 6.2 Templates
Use simple templates for:
- City pages (Azgaar burg + canon overlays)
- Faction pages (purpose, turf, rivals)
- NPC pages (role, voice, secrets with spoiler blocks)
- Event pages (timeline, affected actors)

---

## 7. Testing Roadmap

### 7.1 Golden tests
- snapshot tests for:
  - `azcli --json` outputs
  - wiki export determinism
- property tests for:
  - merge patches
  - relation integrity

### 7.2 Replayable runs
Persist Director plans and tool I/O for a "replay mode" useful for debugging.

---

## 8. Suggested Next Milestones

1) **Pure tool-use Director:** implement tool definitions (§2.2) and replace keyword-based routing
2) **Event scope model:** add event schema with scope field, implement `canon.getActiveEvents` with parent-scope queries (§2.3)
3) **Context-aware generation:** pass active events to all generation tools, update prompts to incorporate them
4) **Event awareness propagation:** implement awareness table and propagation rules (§3.1)
5) **LLM-assisted reactions:** generate faction/state responses to events (§3.2)
6) **Neighborhood anchoring:** locations can parent to neighborhoods, not just burgs (§4.1)
7) **Wiki templates + backlinks:** deterministic export with relation-based linking (§6)
8) **Streaming + caching:** unified streaming interface, generation caching (§5)

---
