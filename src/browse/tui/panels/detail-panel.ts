/**
 * Detail panel renderer for azbrowse TUI
 *
 * Renders the right panel with entity details.
 */

import type { TreeNode, TuiState, EntityKind } from "../types";
import type { LayoutDimensions } from "../layout";
import type { EntityRef } from "../../state";
import type { AzgaarWorld } from "../../../world/azgaar";
import type { CanonStore, CanonEntity } from "../../../canon/canon";
import {
  RESET,
  BOLD,
  DIM,
  BOX,
  FG_GRAY,
  FG_WHITE,
  FG_CYAN,
  FG_GREEN,
  FG_YELLOW,
  getEntityColor,
  padRight,
  padCenter,
  truncate,
  wrapText,
} from "../renderer";
import { nodeIdToRef } from "../tree";

/**
 * Detail section for display
 */
export type DetailSection = {
  key: string;          // Unique key for collapse state
  label?: string;
  content: string[];
  color?: string;
  collapsible?: boolean; // Whether this section can be collapsed
  defaultExpanded?: boolean; // If true, section starts expanded (default is collapsed)
};

/**
 * Detail content for display
 */
export type DetailContent = {
  title: string;
  kind: EntityKind;
  entityId?: string;    // Entity ID for scoping collapse state
  sections: DetailSection[];
};

/**
 * Build detail content from selected node
 */
export function buildDetailContent(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): DetailContent | undefined {
  const selectedNode = state.treeNodes.find((n) => n.id === state.selectedNodeId);
  if (!selectedNode) return undefined;

  const ref = nodeIdToRef(selectedNode.id);

  switch (ref.kind) {
    case "world":
      return buildWorldDetail(world, canon);
    case "state":
      return buildStateDetail(world, ref.stateId);
    case "burg":
      return buildBurgDetail(world, canon, ref.burgId);
    case "location":
      return buildLocationDetail(canon, ref.locationId);
    case "npc":
      return buildNpcDetail(canon, ref.npcId);
    default:
      return undefined;
  }
}

function buildWorldDetail(world: AzgaarWorld, canon: CanonStore): DetailContent {
  const counts = world.counts();
  const canonCounts = {
    entities: canon.listEntities({ limit: 100000 }).length,
    relations: canon.listRelations({ limit: 200000 }).length,
  };

  return {
    title: "World Overview",
    kind: "world",
    entityId: "world",
    sections: [
      {
        key: "world:azgaar",
        label: "Azgaar Map Data",
        content: [
          `States:    ${counts.states}`,
          `Burgs:     ${counts.burgs}`,
          `Cultures:  ${counts.cultures}`,
          `Religions: ${counts.religions}`,
          `Rivers:    ${counts.rivers}`,
        ],
        collapsible: true,
      },
      {
        key: "world:canon",
        label: "Canon Database",
        content: [
          `Entities:  ${canonCounts.entities}`,
          `Relations: ${canonCounts.relations}`,
        ],
        collapsible: true,
      },
    ],
  };
}

function buildStateDetail(world: AzgaarWorld, stateId: number): DetailContent {
  const state = world.getState(stateId);
  if (!state) {
    return {
      title: `State ${stateId}`,
      kind: "state",
      entityId: `state:${stateId}`,
      sections: [{ key: "state:notfound", content: ["State not found"] }],
    };
  }

  const burgs = world.listBurgs().filter((b) => b.state === stateId);
  const totalPop = burgs.reduce((sum, b) => sum + (b.population ?? b.pop ?? 0), 0);

  return {
    title: state.name,
    kind: "state",
    entityId: `state:${stateId}`,
    sections: [
      {
        key: `state:${stateId}:details`,
        label: "Details",
        content: [
          `ID:         ${state.id}`,
          `Government: ${state.formName || state.form || "unknown"}`,
          `Color:      ${state.color || "none"}`,
        ],
        collapsible: true,
      },
      {
        key: `state:${stateId}:demographics`,
        label: "Demographics",
        content: [
          `Burgs:      ${burgs.length}`,
          `Population: ${totalPop.toLocaleString()}`,
        ],
        collapsible: true,
      },
    ],
  };
}

function buildBurgDetail(
  world: AzgaarWorld,
  canon: CanonStore,
  burgId: number
): DetailContent {
  const burg = world.getBurg(burgId);
  if (!burg) {
    return {
      title: `Burg ${burgId}`,
      kind: "burg",
      entityId: `burg:${burgId}`,
      sections: [{ key: "burg:notfound", content: ["Burg not found"] }],
    };
  }

  const state = typeof burg.state === "number" ? world.getState(burg.state) : undefined;
  const locations = canon.listEntities({
    type: "location",
    anchors: { burgId },
    limit: 100,
  });
  const npcs = canon.listEntities({
    type: "npc",
    anchors: { burgId },
    limit: 100,
  });
  const factions = canon.listEntities({
    type: "faction",
    anchors: { burgId },
    limit: 50,
  });

  const traits: string[] = [];
  if (burg.capital) traits.push("Capital");
  if (burg.port) traits.push("Port");

  return {
    title: burg.name,
    kind: "burg",
    entityId: `burg:${burgId}`,
    sections: [
      {
        key: `burg:${burgId}:details`,
        label: "Details",
        content: [
          `ID:         ${burg.id}`,
          `State:      ${state?.name || "(none)"}`,
          `Population: ${(burg.population ?? burg.pop ?? 0).toLocaleString()}`,
          traits.length > 0 ? `Traits:     ${traits.join(", ")}` : "",
        ].filter(Boolean),
        collapsible: true,
      },
      {
        key: `burg:${burgId}:canon`,
        label: "Canon Content",
        content: [
          `Locations:  ${locations.length}`,
          `NPCs:       ${npcs.length}`,
          `Factions:   ${factions.length}`,
        ],
        collapsible: true,
      },
    ],
  };
}

function buildLocationDetail(canon: CanonStore, locationId: string): DetailContent {
  const location = canon.getEntity(locationId);
  if (!location) {
    return {
      title: `Location`,
      kind: "location",
      entityId: locationId,
      sections: [{ key: "loc:notfound", content: ["Location not found"] }],
    };
  }

  // Get NPCs at this location
  const rels = canon.listRelations({ entity_id: locationId, limit: 200 });
  const npcIds = rels
    .filter((r) => r.rel_type === "located_at" && r.to_id === locationId)
    .map((r) => r.from_id);
  const npcs = npcIds
    .map((id) => canon.getEntity(id))
    .filter((e): e is CanonEntity => e !== undefined && e.type === "npc");

  const sections: DetailContent["sections"] = [
    {
      key: `loc:${locationId}:details`,
      label: "Details",
      content: [
        `ID:   ${location.id}`,
        `Kind: ${(location.payload?.kind as string) || "unknown"}`,
        location.tags?.length ? `Tags: ${location.tags.join(", ")}` : "",
      ].filter(Boolean),
      collapsible: true,
    },
  ];

  if (location.summary) {
    sections.push({
      key: `loc:${locationId}:summary`,
      label: "Summary",
      content: [location.summary],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Brief description from payload (quick reference, default expanded)
  const briefDesc = location.payload?.briefDescription as string | undefined;
  if (briefDesc) {
    sections.push({
      key: `loc:${locationId}:brief`,
      label: "Brief Description",
      content: [briefDesc],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // Detailed physical description from payload (rich sensory details, collapsed by default)
  const physicalDesc = location.payload?.physicalDescription as string | undefined;
  if (physicalDesc) {
    sections.push({
      key: `loc:${locationId}:physical`,
      label: "Physical Description",
      content: [physicalDesc],
      collapsible: true,
    });
  }

  if (location.details_md) {
    sections.push({
      key: `loc:${locationId}:desc`,
      label: "Description",
      content: location.details_md.split("\n"),
      collapsible: true,
    });
  }

  if (npcs.length > 0) {
    sections.push({
      key: `loc:${locationId}:npcs`,
      label: `NPCs (${npcs.length})`,
      content: npcs.map((n) => `• ${n.name}${n.summary ? ` - ${n.summary.slice(0, 40)}...` : ""}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  return {
    title: location.name,
    kind: "location",
    entityId: locationId,
    sections,
  };
}

// Magenta color for GM-facing hooks
const FG_MAGENTA = "\x1b[35m";

function buildNpcDetail(canon: CanonStore, npcId: string): DetailContent {
  const npc = canon.getEntity(npcId);
  if (!npc) {
    return {
      title: `NPC`,
      kind: "npc",
      entityId: npcId,
      sections: [{ key: "npc:notfound", content: ["NPC not found"] }],
    };
  }

  const payload = npc.payload || {};
  const sections: DetailContent["sections"] = [];

  // 1. Details (ID, tags, role) - always visible
  const detailsContent: string[] = [
    `ID:   ${npc.id}`,
  ];
  if (payload.role) {
    detailsContent.push(`Role: ${payload.role}`);
  }
  if (npc.tags?.length) {
    detailsContent.push(`Tags: ${npc.tags.join(", ")}`);
  }
  sections.push({
    key: `npc:${npcId}:details`,
    label: "Details",
    content: detailsContent,
    collapsible: true,
  });

  // 2. Summary - one-liner
  if (npc.summary) {
    sections.push({
      key: `npc:${npcId}:summary`,
      label: "Summary",
      content: [npc.summary],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 3. Appearance - from payload.appearance (at top for quick visual reference)
  if (payload.appearance) {
    sections.push({
      key: `npc:${npcId}:appearance`,
      label: "Appearance",
      content: [String(payload.appearance)],
      collapsible: true,
      defaultExpanded: true,
    });
  }

  // 4. Background - from payload.background
  if (payload.background) {
    sections.push({
      key: `npc:${npcId}:background`,
      label: "Background",
      content: [String(payload.background)],
      collapsible: true,
    });
  }

  // 5. Personality - from payload.personality
  if (payload.personality) {
    sections.push({
      key: `npc:${npcId}:personality`,
      label: "Personality",
      content: [String(payload.personality)],
      collapsible: true,
    });
  }

  // 6. Story Hooks - from payload.hooks (magenta, GM-facing)
  const hooks = payload.hooks as string[] | undefined;
  if (hooks?.length) {
    sections.push({
      key: `npc:${npcId}:hooks`,
      label: "Story Hooks",
      content: hooks.map((h: string) => `• ${h}`),
      color: FG_MAGENTA,
      collapsible: true,
    });
  }

  // 7. Known Facts (Public) - green
  const knows = payload.knows as { public?: string[]; secret?: string[]; intimate?: string[] } | undefined;
  if (knows?.public?.length) {
    sections.push({
      key: `npc:${npcId}:knows-public`,
      label: "Known Facts (Public)",
      content: knows.public.map((f: string) => `• ${f}`),
      color: FG_GREEN,
      collapsible: true,
    });
  }

  // 8. Secret Knowledge - yellow
  if (knows?.secret?.length) {
    sections.push({
      key: `npc:${npcId}:knows-secret`,
      label: "Secret Knowledge",
      content: knows.secret.map((f: string) => `• ${f}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // 9. Personal Secrets - from payload.secrets
  const secrets = payload.secrets as string[] | undefined;
  if (secrets?.length) {
    sections.push({
      key: `npc:${npcId}:secrets`,
      label: "Personal Secrets",
      content: secrets.map((s: string) => `• ${s}`),
      color: FG_YELLOW,
      collapsible: true,
    });
  }

  // 10. Motivations - from payload.motivations
  const motivations = payload.motivations as string[] | undefined;
  if (motivations?.length) {
    sections.push({
      key: `npc:${npcId}:motivations`,
      label: "Motivations",
      content: motivations.map((m: string) => `• ${m}`),
      collapsible: true,
    });
  }

  // 11. Additional Notes - from details_md (gray, only if non-empty)
  if (npc.details_md?.trim()) {
    sections.push({
      key: `npc:${npcId}:notes`,
      label: "Additional Notes",
      content: npc.details_md.split("\n"),
      color: FG_GRAY,
      collapsible: true,
    });
  }

  return {
    title: npc.name,
    kind: "npc",
    entityId: npcId,
    sections,
  };
}

// Inverse video for highlighting active section
const BG_HIGHLIGHT = "\x1b[7m";

/**
 * Render the detail panel
 *
 * The detail panel provides the divider between tree and detail panels.
 * Uses T-junction characters at top/bottom left to connect with tree borders.
 *
 * Returns both the lines and the section count (for updating state).
 */
export function renderDetailPanel(
  state: TuiState,
  layout: LayoutDimensions,
  world: AzgaarWorld,
  canon: CanonStore,
  isFocused?: boolean
): { lines: string[]; sectionCount: number } {
  const lines: string[] = [];
  const { detailWidth, detailContentHeight } = layout;
  const innerWidth = detailWidth - 2; // Account for left and right borders

  const content = buildDetailContent(state, world, canon);

  // Title bar - T-junction on left connects with tree panel top border
  const title = content ? ` ${content.title} ` : " Details ";
  const titleColor = content ? getEntityColor(content.kind) : FG_WHITE;
  const titlePadding = Math.floor((innerWidth - title.length) / 2);
  lines.push(
    `${BOX.horizontalDown}${BOX.horizontal.repeat(titlePadding)}${BOLD}${titleColor}${title}${RESET}${BOX.horizontal.repeat(
      Math.max(0, innerWidth - titlePadding - title.length)
    )}${BOX.topRight}`
  );

  // Content lines with section tracking
  const contentLines: string[] = [];
  let sectionCount = 0;

  if (content) {
    const expandedSections = state.detailExpandedSections;

    for (let sectionIdx = 0; sectionIdx < content.sections.length; sectionIdx++) {
      const section = content.sections[sectionIdx];
      // Sections with defaultExpanded start expanded; others start collapsed
      // User can toggle either way, and expandedSections tracks explicit toggles
      const hasBeenToggled = expandedSections.has(section.key);
      const isCollapsed = section.collapsible && (
        section.defaultExpanded ? hasBeenToggled : !hasBeenToggled
      );
      const isActiveSection = isFocused && sectionIdx === state.detailSectionIndex;

      // Section label with collapse indicator
      if (section.label) {
        contentLines.push("");

        // Build the label line with toggle indicator
        const toggleIcon = section.collapsible
          ? (isCollapsed ? "▸ " : "▾ ")
          : "  ";
        const labelText = `${toggleIcon}${section.label}`;
        const highlight = isActiveSection ? BG_HIGHLIGHT : "";
        const resetHighlight = isActiveSection ? RESET : "";

        contentLines.push(
          `${highlight}${BOLD}${section.color || FG_CYAN}${labelText}${RESET}${resetHighlight}`
        );

        // Underline (only if not collapsed)
        if (!isCollapsed) {
          contentLines.push(`${DIM}${"─".repeat(labelText.length)}${RESET}`);
        }
      }

      // Section content (only if not collapsed)
      if (!isCollapsed) {
        for (const line of section.content) {
          const wrapped = wrapText(line, innerWidth - 4); // Extra indent for content
          for (const wrapLine of wrapped) {
            contentLines.push(`  ${section.color || ""}${wrapLine}${section.color ? RESET : ""}`);
          }
        }
      }

      sectionCount++;
    }
  } else {
    contentLines.push("");
    contentLines.push(`${DIM}No entity selected${RESET}`);
    contentLines.push("");
    contentLines.push("Navigate the tree on the left");
    contentLines.push("to view entity details here.");
  }

  // Apply scroll offset and render
  const visibleLines = contentLines.slice(
    state.detailScrollOffset,
    state.detailScrollOffset + detailContentHeight
  );

  for (let i = 0; i < detailContentHeight; i++) {
    const line = visibleLines[i] || "";
    // Left border serves as divider from tree panel
    const paddedLine = padRight(truncate(line, innerWidth), innerWidth);
    lines.push(`${BOX.vertical}${paddedLine}${BOX.vertical}`);
  }

  // Bottom border with scroll indicator - T-junction on left connects with tree bottom
  const totalLines = contentLines.length;
  const scrollInfo =
    totalLines > detailContentHeight
      ? ` ${state.detailScrollOffset + 1}-${Math.min(
          state.detailScrollOffset + detailContentHeight,
          totalLines
        )}/${totalLines} `
      : "";
  const bottomPadding = innerWidth - scrollInfo.length;
  lines.push(
    `${BOX.horizontalUp}${BOX.horizontal.repeat(
      Math.floor(bottomPadding / 2)
    )}${DIM}${scrollInfo}${RESET}${BOX.horizontal.repeat(
      Math.ceil(bottomPadding / 2)
    )}${BOX.bottomRight}`
  );

  return { lines, sectionCount };
}

/**
 * Get the section key at the current section index
 */
export function getCurrentSectionKey(
  state: TuiState,
  world: AzgaarWorld,
  canon: CanonStore
): string | undefined {
  const content = buildDetailContent(state, world, canon);
  if (!content) return undefined;
  const section = content.sections[state.detailSectionIndex];
  return section?.key;
}

/**
 * Render detail panel with focus indicator
 * Returns lines and section count for state updates
 */
export function renderDetailPanelWithBorder(
  state: TuiState,
  layout: LayoutDimensions,
  world: AzgaarWorld,
  canon: CanonStore,
  isFocused: boolean
): { lines: string[]; sectionCount: number } {
  const { lines, sectionCount } = renderDetailPanel(state, layout, world, canon, isFocused);

  if (isFocused) {
    const styledLines = lines.map((line, i) => {
      if (i === 0 || i === lines.length - 1) {
        return `${BOLD}${line}${RESET}`;
      }
      return line;
    });
    return { lines: styledLines, sectionCount };
  }

  return { lines, sectionCount };
}
