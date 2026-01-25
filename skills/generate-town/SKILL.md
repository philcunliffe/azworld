---
name: generate-town
description: Generate all major locations for a town including taverns, shops, temples, and government buildings. Creates NPCs for each location.
metadata:
  author: azworld
  version: "1.0"
---

# Generate Town

You are executing the generate-town skill. Your goal is to systematically populate the current town with essential locations and NPCs.

## Process

1. **Identify the town**:
   - If the user provided a town name, call `world_lookupBurg` to find its burgId
   - Otherwise, use the current burgId from `session_getContext`
   - Then call `world_getBurgDetails` with the burgId to get population, culture, religion, and existing features

2. **Check existing content**: Call `canon_query` with `type: "location"` and `anchors: { burgId: <id> }` to see what already exists. Don't duplicate.

3. **Check active events**: Call `canon_getActiveEvents` to get context that should influence generation.

4. **Generate locations based on town size**:
   - **Hamlet** (pop < 500): Tavern/inn, small temple or shrine
   - **Village** (500-1000): Add general store, blacksmith
   - **Town** (1000-5000): Add market square, town hall, herbalist, additional temple
   - **City** (5000+): Add guild halls, multiple temples, specialty shops (jeweler, clothier), garrison

5. **For each location**, call `generate_location` with:
   - `kind`: appropriate type (tavern, temple, shop, etc.)
   - `burgId`: the town's ID
   - `hints`: specific flavor based on culture/religion
   - `activeEvents`: pass the events JSON

6. **Summarize**: Call `session_narrate` with a narrative summary of what was created, describing the town's character and notable establishments.

## Guidelines
- Match the town's culture (e.g., Norse towns get mead halls, not wine bars)
- Reflect the religion in temple names and practices
- If events are active, let them influence the atmosphere
- Each location should feel distinct and memorable
- Don't over-generate - a small village doesn't need 10 locations
