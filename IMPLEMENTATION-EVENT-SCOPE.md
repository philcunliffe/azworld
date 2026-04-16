# Event Scope Model Implementation - Complete

## Summary

Successfully implemented the Event Scope Model for azworld, enabling context-aware generation that automatically incorporates relevant events based on geographic scope.

## Changes Made

### 1. Schema Updates (src/canon/canon.ts)

**Event Payload Fields** - Already implemented:
- `scope`: "neighborhood" | "burg" | "state" | "region" | "world"
- `severity`: "minor" | "moderate" | "major" | "catastrophic"  
- `daysAgo`: number (when event occurred, for recency filtering)
- `ongoing`: boolean (is the event still happening?)

**getActiveEvents Method** - Already implemented:
- Queries events affecting a location
- Checks upward through scope hierarchy
- Filters by recency (default 90 days)
- Returns sorted by daysAgo (most recent first)

**Scope Logic:**
- `world` scope → affects everything
- `region` scope → affects all locations when includeParentScopes=true
- `state` scope → affects all burgs in that state
- `burg` scope → affects only that burg
- `neighborhood` scope → affects only that neighborhood

### 2. Tool Updates (src/chat/tools/canon-tools.ts)

**canon_getActiveEvents Tool** - Already registered:
- Parameters: burgId, stateId, neighborhoodId, includeParentScopes, recencyDays
- Returns compact event summaries with scope/severity/daysAgo
- Limits to 10 most relevant events to reduce token usage

### 3. Generation Tool Updates (src/chat/tools/generate-tools.ts)

**Modified Tools:**
- `generate_location` - Now queries active events automatically
- `generate_npcs` - Now queries active events automatically
- `generate_faction` - Now queries active events automatically

**Changes:**
- Removed `activeEvents` parameter (no longer needed)
- Added automatic `getActiveEvents()` calls before generation
- Query uses burgId + stateId from burg lookup
- Events formatted and passed to LLM via `formatEventContext()`
- Generation prompts now automatically include: "ACTIVE EVENTS AFFECTING THIS LOCATION: [list]"

**Event Context Format:**
```
ACTIVE EVENTS AFFECTING THIS LOCATION:
- Event Name (scope-level, X days ago, severity): Summary
- ...

Generated content should reflect these conditions naturally.
```

### 4. Documentation Updates (CLAUDE.md)

Added comprehensive "Event Scope Model" section explaining:
- Scope hierarchy
- Payload fields
- Scope-aware queries
- Automatic integration with generation
- Example use case
- Future enhancement notes

## Validation

### Test Event Creation
Created test events via CLI:
```bash
# Burg-scope event
bun run azcli -- canon add event \
  --name "Great Market Fire" \
  --summary "A devastating fire swept through the central market district" \
  --tags disaster,fire \
  --burg 1 \
  --payload-json '{"scope":"burg","severity":"major","daysAgo":5,"ongoing":false}'

# State-scope event (affects all burgs in state)
bun run azcli -- canon add event \
  --name "The Great Quake" \
  --summary "A massive earthquake that shook the entire region" \
  --tags disaster,earthquake \
  --burg 1 \
  --payload-json '{"scope":"state","severity":"catastrophic","daysAgo":0,"ongoing":true}'
```

### Query Validation
Tested `getActiveEvents()` query:
- ✅ Returns events within recency window (default 90 days)
- ✅ Filters out old events (100+ days)
- ✅ Includes parent scope events (state-scope affects burgs)
- ✅ Sorts by recency (most recent first)
- ✅ Handles world-scope events (affect everything)

### Integration Validation
- ✅ Generation tools have access to `ctx.canon.getActiveEvents()`
- ✅ Events are automatically queried before generation
- ✅ Events formatted and included in LLM prompts
- ✅ No manual event passing required

## Usage Examples

### Creating Events with Scope

**Burg-level disaster:**
```bash
bun run azcli -- canon add event \
  --name "Guild Hall Collapse" \
  --summary "The miners' guild hall collapsed, trapping dozens" \
  --burg 42 \
  --payload-json '{"scope":"burg","severity":"major","daysAgo":2,"ongoing":true,"kind":"disaster"}'
```

**State-level political event:**
```bash
bun run azcli -- canon add event \
  --name "New Tax Law" \
  --summary "The duke imposed a controversial new merchant tax" \
  --payload-json '{"scope":"state","severity":"moderate","daysAgo":10,"ongoing":true,"kind":"politics"}'
```

**World-level celebration:**
```bash
bun run azcli -- canon add event \
  --name "Festival of Lights" \
  --summary "The annual kingdom-wide festival begins tomorrow" \
  --payload-json '{"scope":"world","severity":"minor","daysAgo":0,"ongoing":true,"kind":"celebration"}'
```

### Generating Content with Event Context

**Before (manual):**
```typescript
// Had to manually pass events as JSON parameter
generate_location({
  kind: "tavern",
  burgId: 1,
  activeEvents: JSON.stringify([...]) // Manual event list
})
```

**After (automatic):**
```typescript
// Events automatically queried and included
generate_location({
  kind: "tavern",
  burgId: 1
  // Events are automatically fetched for this burg!
})
```

The generated tavern will automatically reflect:
- The recent market fire (burg-scope)
- The ongoing earthquake (state-scope)
- Any world-level events within 90 days

## Technical Details

### Scope Query Logic

```typescript
// Pseudo-code for scope matching
if (event.scope === "world") {
  // Always matches
  return true;
} else if (event.scope === "region" && includeParentScopes) {
  // Region events match when parent scopes included
  return true;
} else if (event.scope === "state") {
  // Match if state IDs align OR no specific state anchor
  return event.stateId === queryStateId || (!event.stateId && includeParentScopes);
} else if (event.scope === "burg") {
  // Match if burg IDs align
  return event.burgId === queryBurgId;
} else if (event.scope === "neighborhood") {
  // Match exact neighborhood
  return event.neighborhoodId === queryNeighborhoodId;
}
```

### Performance Considerations

- Events limited to 10 most relevant (sorted by recency)
- Summaries truncated to 100 chars in tool responses
- Only events within recency window queried
- Efficient SQLite queries with indexes on type

## Future Enhancements

As noted in CLAUDE.md, this model enables:

1. **Event Propagation**: Events triggering other events
   - State event → multiple burg events
   - Burg event → neighborhood events

2. **Awareness Tracking**: Already partially implemented
   - `event_awareness` table exists
   - `setAwareness()` and `getAwareness()` methods ready
   - Can track which actors know about which events at what level

3. **Dynamic Event Updates**: 
   - `ongoing` flag enables event progression
   - Events can transition from ongoing → resolved
   - `daysAgo` can be updated as time passes

4. **Event Consequences**:
   - `generate_event` tool already supports consequences
   - Can create cascading effects
   - Link events via relations

## Testing Checklist

- [x] Event schema supports scope/severity/daysAgo/ongoing
- [x] getActiveEvents query works correctly
- [x] Scope hierarchy filters correctly
- [x] Recency filtering works
- [x] canon_getActiveEvents tool registered
- [x] generate_location queries events automatically
- [x] generate_npcs queries events automatically  
- [x] generate_faction queries events automatically
- [x] Documentation updated
- [x] CLI supports event creation with payload
- [x] Test script validates core functionality

## Files Modified

1. `src/chat/tools/generate-tools.ts` - Updated generation tools to auto-query events
2. `CLAUDE.md` - Added Event Scope Model documentation
3. `test-event-scope.sh` - Validation script (new)
4. `test-query-events.ts` - Query test script (new)

## Files NOT Modified (Already Correct)

1. `src/canon/canon.ts` - Schema and getActiveEvents already implemented
2. `src/chat/tools/canon-tools.ts` - canon_getActiveEvents tool already registered
3. `src/chat/tools/index.ts` - ToolContext already includes canon store

## Deployment Notes

No breaking changes - existing events without scope/severity/daysAgo will:
- Default to `scope: "burg"`
- Default to `daysAgo: 0`
- Be included in queries if recency allows

Backward compatible with existing canon databases.
