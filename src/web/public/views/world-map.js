/**
 * world-map.js - Full interactive world map view.
 *
 * Renders Voronoi cells, state borders, routes, rivers, burgs, and markers as SVG.
 * Supports pan (drag), zoom (scroll), click-to-navigate, and right-click context menu.
 * Labels adapt to zoom level: state names at full zoom, capitals at medium, all burgs when close.
 */

import { escapeHtml } from '../lib/util.js';

const BIOME_COLORS = {
  0: '#88b4ce', 1: '#e0d8b0', 2: '#d0c890', 3: '#c8d490',
  4: '#a8c878', 5: '#78b858', 6: '#68a050', 7: '#488838',
  8: '#589860', 9: '#789850', 10: '#c8d8a8', 11: '#b8b8c0', 12: '#90a878',
};

const DANGER_COLORS = { safe: '#2f6d4f', cautious: '#b8860b', dangerous: '#c0392b', deadly: '#6b1a1a' };

let mapData = null;
let viewBox = null;
let isPanning = false;
let panStart = null;

export function renderWorldMap() {
  return `
    <div class="world-map-container" id="world-map">
      <div class="world-map-loading">Loading world map...</div>
    </div>
    <div class="map-context-menu" id="map-context-menu" style="display:none"></div>
  `;
}

export async function loadWorldMap() {
  const container = document.getElementById('world-map');
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = '1';

  try {
    const resp = await fetch('/api/map/full');
    if (!resp.ok) throw new Error('Failed');
    mapData = await resp.json();
    viewBox = { ...mapData.bounds };
    container.innerHTML = buildSvg(mapData);
    attachInteractions(container);
  } catch {
    container.innerHTML = '<div class="world-map-error muted">Map unavailable</div>';
  }
}

function buildSvg(data) {
  const { bounds, cells, burgs, rivers, routes, states, markers } = data;
  const { x, y, w, h } = bounds;
  const pad = 2;

  // State color lookup
  const stateColors = {};
  for (const s of states) stateColors[s.id] = s.color || '#ccc';

  // Cell polygons
  const cellPolys = cells.map(cell => {
    const pts = cell.polygon.map(p => `${p[0]},${p[1]}`).join(' ');
    const isWater = cell.elevation < 20 && cell.state === 0;
    let fill;
    if (isWater) {
      const depth = Math.max(0.7, 1 - (20 - cell.elevation) / 60);
      fill = lerpColor('#6a9ab8', '#3d6d8a', 1 - depth);
    } else {
      const base = BIOME_COLORS[cell.biome] || '#a0b878';
      const elev = Math.min(1, Math.max(0, (cell.elevation - 20) / 60));
      fill = lerpColor(base, darken(base, 0.2), elev * 0.4);
    }
    return `<polygon points="${pts}" fill="${fill}" data-cell="${cell.id}" data-state="${cell.state}"/>`;
  }).join('\n');

  // State borders
  const borders = findStateBorders(cells);
  const borderLines = borders.map(seg =>
    `<line x1="${seg[0][0]}" y1="${seg[0][1]}" x2="${seg[1][0]}" y2="${seg[1][1]}" stroke="rgba(40,30,20,0.35)" stroke-width="1" stroke-linecap="round"/>`
  ).join('\n');

  // Routes (roads, trails, sea routes)
  const routeElems = (routes || []).map(r => {
    if (r.points.length < 2) return '';
    const d = smoothPath(r.points);
    switch (r.group) {
      case 'roads':
        return `<path d="${d}" fill="none" stroke="rgba(80,60,30,0.5)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      case 'trails':
        return `<path d="${d}" fill="none" stroke="rgba(80,60,30,0.25)" stroke-width="0.6" stroke-dasharray="3,2" stroke-linecap="round"/>`;
      case 'searoutes':
        return `<path d="${d}" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="0.8" stroke-dasharray="4,3" stroke-linecap="round"/>`;
      default:
        return `<path d="${d}" fill="none" stroke="rgba(80,60,30,0.2)" stroke-width="0.5" stroke-dasharray="2,2"/>`;
    }
  }).join('\n');

  // Rivers
  const riverPaths = rivers.map(r => {
    if (r.points.length < 2) return '';
    return `<path d="${smoothPath(r.points)}" fill="none" stroke="#5088a0" stroke-width="1" stroke-linecap="round" opacity="0.5"/>`;
  }).join('\n');

  // State labels at centroids
  const stateCentroids = {};
  for (const b of burgs) {
    if (!stateCentroids[b.state]) stateCentroids[b.state] = { sx: 0, sy: 0, n: 0, name: '' };
    stateCentroids[b.state].sx += b.x;
    stateCentroids[b.state].sy += b.y;
    stateCentroids[b.state].n++;
  }
  for (const s of states) {
    if (stateCentroids[s.id]) stateCentroids[s.id].name = s.name;
  }
  const stateLabels = Object.values(stateCentroids).filter(c => c.n > 0 && c.name).map(c => {
    const cx = c.sx / c.n;
    const cy = c.sy / c.n;
    return `<text x="${cx}" y="${cy}" text-anchor="middle" class="map-state-label">${escapeHtml(c.name)}</text>`;
  }).join('\n');

  // River labels (for named rivers)
  const riverLabels = rivers.filter(r => r.name && r.points.length > 3).map(r => {
    const mid = r.points[Math.floor(r.points.length / 2)];
    return `<text x="${mid[0]}" y="${mid[1] - 3}" text-anchor="middle" class="map-river-label">${escapeHtml(r.name)}</text>`;
  }).join('\n');

  // Canon markers
  const markerElems = (markers || []).map(m => {
    const color = DANGER_COLORS[m.dangerLevel] || '#665544';
    const s = 4;
    const diamond = `M${m.x},${m.y - s} L${m.x + s},${m.y} L${m.x},${m.y + s} L${m.x - s},${m.y} Z`;
    return `
      <g class="map-marker-group" data-action="navigate" data-ref="marker:${escapeHtml(m.id)}" style="cursor:pointer">
        <path d="${diamond}" fill="${color}" stroke="#fff" stroke-width="0.5" opacity="0.9"/>
        <text x="${m.x}" y="${m.y - s - 2}" text-anchor="middle" class="map-marker-label">${escapeHtml(m.name)}</text>
      </g>`;
  }).join('\n');

  // Burg markers — ALL burgs get dots, labels assigned by tier
  const sorted = [...burgs].sort((a, b) => b.population - a.population);

  const burgElems = sorted.map(b => {
    const r = b.capital ? 2.5 : 1.5;
    const fill = b.capital ? '#1a1a1a' : '#333';

    // Tier determines which zoom level shows the label
    // tier-0: capitals (always visible)
    // tier-1: top 30 by population (visible at medium zoom)
    // tier-2: all others (visible only when zoomed in close)
    const tier = b.capital ? 0 : (sorted.indexOf(b) < 30 ? 1 : 2);
    const fs = b.capital ? 5.5 : (tier === 1 ? 4.5 : 3.5);
    const fw = b.capital ? 700 : 400;

    return `
      <circle cx="${b.x}" cy="${b.y}" r="${r}" fill="${fill}" stroke="rgba(255,255,255,0.7)" stroke-width="0.5" data-action="navigate" data-ref="burg:${b.id}" style="cursor:pointer" class="map-burg-dot"/>
      <text x="${b.x}" y="${b.y - r - 2}" text-anchor="middle" font-size="${fs}" font-weight="${fw}" fill="#1a1a1a" class="map-burg-label map-label-tier-${tier}" data-action="navigate" data-ref="burg:${b.id}" style="cursor:pointer">${escapeHtml(b.name)}</text>
    `;
  }).join('\n');

  return `
    <svg id="world-map-svg" viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}"
         class="world-map-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="World map">
      <defs>
        <style>
          .map-state-label { font: 700 10px var(--serif, Georgia, serif); fill: rgba(30,20,10,0.35); pointer-events: none; }
          .map-burg-label { font-family: var(--serif, Georgia, serif); pointer-events: auto; }
          .map-marker-label { font: 500 4px var(--serif, Georgia, serif); pointer-events: none; }
          .map-river-label { font: italic 3.5px var(--serif, Georgia, serif); fill: #3a6a80; pointer-events: none; }
          .map-burg-dot:hover { r: 4; fill: var(--accent, #a3401f); }
          /* Label tiers hidden by default, shown via JS class on <svg> */
          .map-label-tier-1, .map-label-tier-2, .map-river-label, .map-marker-label { display: none; }
          .zoom-medium .map-label-tier-1 { display: initial; }
          .zoom-close .map-label-tier-1, .zoom-close .map-label-tier-2,
          .zoom-close .map-river-label, .zoom-close .map-marker-label { display: initial; }
        </style>
      </defs>
      <rect x="${x - pad}" y="${y - pad}" width="${w + pad * 2}" height="${h + pad * 2}" fill="#6a9ab8"/>
      <g class="map-cells">${cellPolys}</g>
      <g class="map-borders">${borderLines}</g>
      <g class="map-routes">${routeElems}</g>
      <g class="map-rivers">${riverPaths}</g>
      <g class="map-river-labels">${riverLabels}</g>
      <g class="map-state-labels">${stateLabels}</g>
      <g class="map-markers">${markerElems}</g>
      <g class="map-burgs">${burgElems}</g>
    </svg>
  `;
}

function attachInteractions(container) {
  const svg = container.querySelector('#world-map-svg');
  if (!svg) return;

  // Initial label visibility
  updateZoomClass(svg);

  // Zoom with scroll wheel
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const svgX = viewBox.x + fx * viewBox.w;
    const svgY = viewBox.y + fy * viewBox.h;

    const factor = e.deltaY > 0 ? 1.08 : 0.93;
    const nw = viewBox.w * factor;
    const nh = viewBox.h * factor;

    if (nw < 40 || nw > mapData.bounds.w * 2) return;

    viewBox.x = svgX - fx * nw;
    viewBox.y = svgY - fy * nh;
    viewBox.w = nw;
    viewBox.h = nh;
    svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
    updateZoomClass(svg);
  }, { passive: false });

  // Pan with mouse drag
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-action]')) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y };
    container.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning || !panStart) return;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - panStart.x) / rect.width * viewBox.w;
    const dy = (e.clientY - panStart.y) / rect.height * viewBox.h;
    viewBox.x = panStart.vx - dx;
    viewBox.y = panStart.vy - dy;
    svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      panStart = null;
      container.style.cursor = '';
    }
  });

  // Right-click context menu
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const svgX = viewBox.x + fx * viewBox.w;
    const svgY = viewBox.y + fy * viewBox.h;
    const cell = findCellAt(svgX, svgY);
    showContextMenu(e.clientX, e.clientY, svgX, svgY, cell);
  });

  document.addEventListener('click', () => {
    const menu = document.getElementById('map-context-menu');
    if (menu) menu.style.display = 'none';
  });
}

/**
 * Update CSS class on SVG based on zoom level to show/hide label tiers.
 */
function updateZoomClass(svg) {
  const fullW = mapData.bounds.w;
  const ratio = viewBox.w / fullW;

  svg.classList.remove('zoom-medium', 'zoom-close');
  if (ratio < 0.15) {
    svg.classList.add('zoom-close');    // Very zoomed in — show everything
  } else if (ratio < 0.45) {
    svg.classList.add('zoom-medium');   // Medium zoom — show capitals + top burgs
  }
  // Default (no class) — show only capitals and state labels
}

function findCellAt(x, y) {
  if (!mapData?.cells) return null;
  let best = null;
  let bestDist = Infinity;
  for (const cell of mapData.cells) {
    if (!cell.polygon.length) continue;
    let cx = 0, cy = 0;
    for (const p of cell.polygon) { cx += p[0]; cy += p[1]; }
    cx /= cell.polygon.length;
    cy /= cell.polygon.length;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  return best;
}

function showContextMenu(clientX, clientY, svgX, svgY, cell) {
  const menu = document.getElementById('map-context-menu');
  if (!menu) return;

  const isWater = cell && cell.elevation < 20 && cell.state === 0;
  const stateInfo = cell ? mapData.states.find(s => s.id === cell.state) : null;

  // Find nearest burg for context
  let nearestBurg = null;
  let nearestDist = Infinity;
  for (const b of mapData.burgs) {
    const d = (b.x - svgX) ** 2 + (b.y - svgY) ** 2;
    if (d < nearestDist) { nearestDist = d; nearestBurg = b; }
  }

  menu.innerHTML = `
    <div class="map-ctx-header">${isWater ? 'Ocean' : (stateInfo?.name || 'Wilderness')}${nearestBurg ? ` (near ${escapeHtml(nearestBurg.name)})` : ''}</div>
    ${!isWater ? `
      <button class="map-ctx-item" data-action="map-gen-marker" data-cell-id="${cell?.id ?? ''}" data-x="${svgX.toFixed(1)}" data-y="${svgY.toFixed(1)}" data-state-id="${cell?.state ?? ''}" data-near-burg-id="${nearestBurg?.id ?? ''}">
        Generate Marker Here
      </button>
    ` : ''}
    ${nearestBurg ? `
      <button class="map-ctx-item" data-action="navigate" data-ref="burg:${nearestBurg.id}">
        Go to ${escapeHtml(nearestBurg.name)}
      </button>
    ` : ''}
  `;
  menu.style.display = 'block';
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
}

// --- Color utilities ---
function lerpColor(c1, c2, t) {
  const a = parseColor(c1), b = parseColor(c2);
  return `#${hex2(Math.round(a[0]+(b[0]-a[0])*t))}${hex2(Math.round(a[1]+(b[1]-a[1])*t))}${hex2(Math.round(a[2]+(b[2]-a[2])*t))}`;
}
function darken(hex, amt) {
  const c = parseColor(hex);
  return `#${hex2(Math.round(c[0]*(1-amt)))}${hex2(Math.round(c[1]*(1-amt)))}${hex2(Math.round(c[2]*(1-amt)))}`;
}
function hex2(n) { return Math.max(0,Math.min(255,n)).toString(16).padStart(2,'0'); }
function parseColor(s) {
  s = s.trim();
  const m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (m) return [+m[1],+m[2],+m[3]];
  let h = s.replace('#','');
  if (h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
}

function findStateBorders(cells) {
  const edgeMap = new Map();
  for (const cell of cells) {
    const poly = cell.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i+1)%poly.length];
      const key = edgeKey(a,b);
      if (!edgeMap.has(key)) edgeMap.set(key, { points: [a,b], states: [cell.state] });
      else edgeMap.get(key).states.push(cell.state);
    }
  }
  const segs = [];
  for (const e of edgeMap.values()) {
    if (e.states.length===2 && e.states[0]!==e.states[1] && (e.states[0]!==0||e.states[1]!==0))
      segs.push(e.points);
  }
  return segs;
}
function edgeKey(a,b) {
  const ax=Math.round(a[0]*10),ay=Math.round(a[1]*10),bx=Math.round(b[0]*10),by=Math.round(b[1]*10);
  return ax<bx||(ax===bx&&ay<by)?`${ax},${ay}-${bx},${by}`:`${bx},${by}-${ax},${ay}`;
}

function smoothPath(points) {
  if (points.length<2) return '';
  if (points.length===2) return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]}`;
  let d=`M${points[0][0]},${points[0][1]}`;
  for (let i=0;i<points.length-1;i++){
    const p0=points[Math.max(0,i-1)],p1=points[i],p2=points[i+1],p3=points[Math.min(points.length-1,i+2)];
    d+=` C${p1[0]+(p2[0]-p0[0])/6},${p1[1]+(p2[1]-p0[1])/6} ${p2[0]-(p3[0]-p1[0])/6},${p2[1]-(p3[1]-p1[1])/6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
