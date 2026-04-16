#!/usr/bin/env bun
// Test getActiveEvents query

import { CanonStore } from "./src/canon/canon";
import { AzgaarWorld } from "./src/world/azgaar";

const canonPath = "data/canon-test.db";
const worldPath = "data/world.json";

console.log("=== Testing getActiveEvents Query ===\n");

// Load world and canon
const world = await AzgaarWorld.load(worldPath);
world.buildIndexes();
const canon = new CanonStore(canonPath);

// Get burg 1 details
const burg = world.getBurg(1);
if (!burg) {
  console.error("Burg 1 not found!");
  process.exit(1);
}

console.log(`Testing events for: ${burg.name} (Burg ${burg.id})`);
console.log(`State: ${burg.state}\n`);

// Query active events
const events = canon.getActiveEvents({
  burgId: burg.id,
  stateId: typeof burg.state === "number" ? burg.state : undefined,
  includeParentScopes: true,
  recencyDays: 90,
});

console.log(`Found ${events.length} active events within 90 days:\n`);

for (const event of events) {
  const payload = event.payload || {};
  console.log(`📍 ${event.name}`);
  console.log(`   Scope: ${payload.scope || "unknown"}`);
  console.log(`   Severity: ${payload.severity || "unknown"}`);
  console.log(`   Days ago: ${payload.daysAgo ?? "?"}`);
  console.log(`   Ongoing: ${payload.ongoing ? "yes" : "no"}`);
  console.log(`   Summary: ${event.summary || "No summary"}`);
  console.log();
}

// Test with 200 day recency (should include the old world event)
const eventsLongTerm = canon.getActiveEvents({
  burgId: burg.id,
  stateId: typeof burg.state === "number" ? burg.state : undefined,
  includeParentScopes: true,
  recencyDays: 200,
});

console.log(`\nWith 200-day recency window: ${eventsLongTerm.length} events`);
if (eventsLongTerm.length > events.length) {
  console.log("✓ Recency filtering works correctly");
}

canon.close();

console.log("\n=== Query Test Complete ===");
