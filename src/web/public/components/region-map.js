/**
 * region-map.js - SVG region map renderer for burg detail pages.
 *
 * Fetches map data from /api/map/burg and renders an interactive SVG showing:
 *   - Terrain cells colored by biome with elevation shading
 *   - State border lines
 *   - Rivers
 *   - Burg markers (selective labeling)
 *   - Highlighted center burg
 */

import { escapeHtml } from '../lib/util.js';

/**
 * Render a map container that will be populated asynchronously.
 */
export function renderMapPlaceholder(burgId) {
  return `
    <div class="region-map-container" id="region-map" data-burg-id="${burgId}">
      <div class="region-map-loading">Loading map...</div>
    </div>
  `;
}

/**
 * Fetch map data and render SVG into the placeholder.
 */
export async function loadRegionMap(burgId) {
  const container = document.getElementById('region-map');
  if (!container) return;

  try {
    const resp = await fetch(`/api/map/burg?id=${burgId}&radius=120`);
    if (!resp.ok) throw new Error('Failed to load map');
    const data = await resp.json();
    container.innerHTML = renderSvgMap(data, burgId);
  } catch (e) {
    container.innerHTML = `<div class="region-map-error muted">Map unavailable</div>`;
  }
}

/**
 * Build the SVG map from region data.
 */
function renderSvgMap(data, centerBurgId) {
  const { bounds, cells, burgs, rivers, states } = data;
  const { x, y, w, h } = bounds;

  // Biome color palette (natural tones)
  const biomeColorMap = {
    0: '#88b4ce',  // Marine
    1: '#e0d8b0',  // Hot desert
    2: '#d0c890',  // Cold desert
    3: '#c8d490',  // Savanna
    4: '#a8c878',  // Grassland
    5: '#78b858',  // Tropical seasonal forest
    6: '#68a050',  // Temperate deciduous forest
    7: '#488838',  // Tropical rainforest
    8: '#589860',  // Temperate rainforest
    9: '#789850',  // Taiga
    10: '#c8d8a8', // Tundra
    11: '#b8b8c0', // Glacier
    12: '#90a878', // Wetland
  };

  // State color lookup
  const stateColors = {};
  for (const s of states) {
    stateColors[s.id] = s.color || '#888';
  }

  // Build neighbor lookup for state border detection
  const cellStateMap = {};
  const cellNeighborMap = {};
  for (const cell of cells) {
    cellStateMap[cell.id] = cell.state;
  }

  // --- Render layers ---

  // 1. Cell polygons (biome coloring, no stroke)
  const cellPolygons = cells.map(cell => {
    const points = cell.polygon.map(p => `${p[0]},${p[1]}`).join(' ');
    const isWater = cell.elevation < 20 && cell.state === 0;

    let fill;
    if (isWater) {
      // Depth shading for water
      const depth = Math.max(0.7, 1 - (20 - cell.elevation) / 60);
      fill = lerpColor('#6a9ab8', '#3d6d8a', 1 - depth);
    } else {
      const base = biomeColorMap[cell.biome] || '#a0b878';
      // Subtle elevation shading
      const elev = Math.min(1, Math.max(0, (cell.elevation - 20) / 60));
      fill = lerpColor(base, darken(base, 0.2), elev * 0.4);
    }

    return `<polygon points="${points}" fill="${fill}"/>`;
  }).join('\n');

  // 2. State borders - find edges between cells of different states
  const borderSegments = findStateBorders(cells);
  const borderPaths = borderSegments.map(seg =>
    `<line x1="${seg[0][0]}" y1="${seg[0][1]}" x2="${seg[1][0]}" y2="${seg[1][1]}" stroke="rgba(40,30,20,0.3)" stroke-width="1.2" stroke-linecap="round"/>`
  ).join('\n');

  // 3. Rivers
  const riverPaths = rivers.map(river => {
    if (river.points.length < 2) return '';
    const d = smoothPath(river.points);
    return `<path d="${d}" fill="none" stroke="#5088a0" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>`;
  }).join('\n');

  // 4. Burg markers - only label important ones
  const centerBurg = burgs.find(b => b.id === centerBurgId);
  const sortedBurgs = [...burgs].sort((a, b) => b.population - a.population);

  // Label: center burg always, capitals always, then top N by population
  const labelSet = new Set();
  if (centerBurg) labelSet.add(centerBurg.id);
  for (const b of sortedBurgs) {
    if (b.capital) labelSet.add(b.id);
  }
  // Add top burgs by population, but limit to avoid clutter
  for (const b of sortedBurgs) {
    if (labelSet.size >= 8) break;
    labelSet.add(b.id);
  }

  const burgMarkers = sortedBurgs.map(b => {
    const isCenter = b.id === centerBurgId;
    const showLabel = labelSet.has(b.id);

    // Marker size
    const r = isCenter ? 3.5 : (b.capital ? 2.5 : 1.5);
    const fill = isCenter ? '#c0392b' : '#2c2c2c';
    const stroke = isCenter ? '#fff' : 'rgba(255,255,255,0.7)';
    const sw = isCenter ? 1.2 : 0.5;

    let html = `<circle cx="${b.x}" cy="${b.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

    if (showLabel) {
      const fontSize = isCenter ? 6 : (b.capital ? 5 : 4.5);
      const weight = (isCenter || b.capital) ? 600 : 400;
      const labelFill = isCenter ? '#8b1a1a' : '#222';
      // Offset label to avoid overlapping marker
      html += `<text x="${b.x}" y="${b.y - r - 2.5}" text-anchor="middle" font-size="${fontSize}" font-weight="${weight}" fill="${labelFill}" font-family="var(--serif, Georgia, serif)">${escapeHtml(b.name)}</text>`;
    }

    return html;
  }).join('\n');

  const pad = 8;
  return `
    <svg viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}"
         class="region-map-svg"
         xmlns="http://www.w3.org/2000/svg"
         role="img"
         aria-label="Region map">
      <rect x="${x - pad}" y="${y - pad}" width="${w + pad * 2}" height="${h + pad * 2}" fill="#6a9ab8"/>
      <g>${cellPolygons}</g>
      <g>${borderPaths}</g>
      <g>${riverPaths}</g>
      <g>${renderMarkers(data.markers || [])}</g>
      <g>${burgMarkers}</g>
    </svg>
  `;
}

/**
 * Find shared edges between cells of different states (state borders).
 * Uses an edge-index approach: each edge is keyed by its vertex positions,
 * and we record the state on each side. Borders are edges with different states.
 */
function findStateBorders(cells) {
  // Map: edgeKey -> { state, points }[]
  const edgeMap = new Map();

  for (const cell of cells) {
    const poly = cell.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const key = edgeKey(a, b);

      if (!edgeMap.has(key)) {
        edgeMap.set(key, { points: [a, b], states: [cell.state] });
      } else {
        edgeMap.get(key).states.push(cell.state);
      }
    }
  }

  // Collect edges where two different non-zero states meet
  const segments = [];
  for (const edge of edgeMap.values()) {
    if (edge.states.length === 2 && edge.states[0] !== edge.states[1]) {
      // At least one side should be land (non-zero state)
      if (edge.states[0] !== 0 || edge.states[1] !== 0) {
        segments.push(edge.points);
      }
    }
  }
  return segments;
}

function edgeKey(a, b) {
  const ax = Math.round(a[0] * 10), ay = Math.round(a[1] * 10);
  const bx = Math.round(b[0] * 10), by = Math.round(b[1] * 10);
  return ax < bx || (ax === bx && ay < by) ? `${ax},${ay}-${bx},${by}` : `${bx},${by}-${ax},${ay}`;
}

/**
 * Create a smooth SVG path from points using Catmull-Rom to cubic bezier conversion.
 */
function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]}`;

  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/**
 * Linearly interpolate between two hex colors.
 */
function lerpColor(color1, color2, t) {
  const c1 = parseColor(color1);
  const c2 = parseColor(color2);
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function darken(hex, amount) {
  const c = parseColor(hex);
  const r = Math.round(c[0] * (1 - amount));
  const g = Math.round(c[1] * (1 - amount));
  const b = Math.round(c[2] * (1 - amount));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function hex2(n) {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}

function parseColor(str) {
  str = str.trim();
  // Handle rgb(r,g,b)
  const rgbMatch = str.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
  // Handle hex
  let hex = str.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return [parseInt(hex.slice(0,2), 16), parseInt(hex.slice(2,4), 16), parseInt(hex.slice(4,6), 16)];
}

/**
 * Render canon markers (wilderness points of interest) on the map.
 */
function renderMarkers(markers) {
  if (!markers || !markers.length) return '';

  const dangerColors = {
    safe: '#2f6d4f',
    cautious: '#b8860b',
    dangerous: '#c0392b',
    deadly: '#6b1a1a',
  };

  return markers.map(m => {
    const color = dangerColors[m.dangerLevel] || '#665544';
    // Diamond shape for markers
    const s = 3;
    const diamond = `M${m.x},${m.y - s} L${m.x + s},${m.y} L${m.x},${m.y + s} L${m.x - s},${m.y} Z`;

    return `
      <path d="${diamond}" fill="${color}" stroke="#fff" stroke-width="0.6" opacity="0.9"/>
      <text x="${m.x}" y="${m.y - s - 2}" text-anchor="middle" font-size="4" font-family="var(--serif, Georgia, serif)" fill="${color}" font-weight="500">${escapeHtml(m.name)}</text>
    `;
  }).join('\n');
}
