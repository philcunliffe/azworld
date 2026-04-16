#!/usr/bin/env bash
# Test Event Scope Model implementation

set -e

WORLD="data/world.json"
CANON="data/canon-test.db"

echo "=== Event Scope Model Validation ==="
echo ""

# Clean up any existing test DB
rm -f "$CANON"

# Initialize canon DB
echo "1. Initializing test canon database..."
bun run azcli -- --world "$WORLD" --canon "$CANON" canon init
echo "✓ Canon initialized"
echo ""

# Add a test event with scope fields
echo "2. Adding test event (burg-scope, major severity, 5 days ago)..."
bun run azcli -- --world "$WORLD" --canon "$CANON" canon add event \
  --name "Great Market Fire" \
  --summary "A devastating fire swept through the central market district" \
  --tags disaster,fire \
  --burg 1 \
  --payload-json '{"scope":"burg","severity":"major","daysAgo":5,"ongoing":false,"kind":"fire"}' \
  --json
echo "✓ Event added"
echo ""

# Add a state-scope event
echo "3. Adding state-scope event (catastrophic earthquake, ongoing)..."
bun run azcli -- --world "$WORLD" --canon "$CANON" canon add event \
  --name "The Great Quake" \
  --summary "A massive earthquake that shook the entire region" \
  --tags disaster,earthquake \
  --burg 1 \
  --payload-json '{"scope":"state","severity":"catastrophic","daysAgo":0,"ongoing":true,"kind":"earthquake"}' \
  --json
echo "✓ State event added"
echo ""

# Add a world-scope event
echo "4. Adding world-scope event (minor, old)..."
bun run azcli -- --world "$WORLD" --canon "$CANON" canon add event \
  --name "Royal Wedding Anniversary" \
  --summary "The kingdom celebrates 50 years since the royal wedding" \
  --tags celebration,politics \
  --payload-json '{"scope":"world","severity":"minor","daysAgo":100,"ongoing":false,"kind":"celebration"}' \
  --json
echo "✓ World event added (should be filtered by recency)"
echo ""

# List all events
echo "5. Listing all events..."
bun run azcli -- --world "$WORLD" --canon "$CANON" canon list event --pretty
echo ""

echo "=== Validation Complete ==="
echo ""
echo "Next steps:"
echo "1. Test generation with: bun run azchat -- --world $WORLD --canon $CANON"
echo "2. Generate a location in burg 1 and verify events are included in context"
echo "3. The burg-scope and state-scope events should appear in generation prompts"
echo "4. The world-scope event should NOT appear (too old - 100 days ago)"
