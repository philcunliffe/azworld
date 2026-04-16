/**
 * util.js - Shared utility functions for the azworld web app.
 *
 * HTML escaping, JSON helpers, lightweight markdown rendering,
 * number formatting, and string truncation.
 */

/**
 * Escape a value for safe insertion into HTML.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Pretty-print a value as indented JSON.
 * @param {*} value
 * @returns {string}
 */
export function pretty(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

/**
 * Safely parse a JSON string, returning a fallback on failure.
 * @param {*} value
 * @param {*} fallback
 * @returns {*}
 */
export function parseJsonField(value, fallback = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

/**
 * Convert simple markdown to HTML.
 * Handles headings (h2-h4), unordered lists, bold, italic, inline code, and paragraphs.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  if (!md) return "";
  if (Array.isArray(md)) return md.map(item => `<p>${escapeHtml(String(item))}</p>`).join("");
  if (typeof md !== "string") return `<p>${escapeHtml(String(md))}</p>`;

  // Process line-by-line for better handling of LLM output
  const lines = md.split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) { i++; continue; }

    // Headings
    if (trimmed.startsWith("#### ")) {
      html.push(`<h4>${inlineFormat(trimmed.slice(5))}</h4>`);
      i++; continue;
    }
    if (trimmed.startsWith("### ")) {
      html.push(`<h4>${inlineFormat(trimmed.slice(4))}</h4>`);
      i++; continue;
    }
    if (trimmed.startsWith("## ")) {
      html.push(`<h3>${inlineFormat(trimmed.slice(3))}</h3>`);
      i++; continue;
    }
    if (trimmed.startsWith("# ")) {
      html.push(`<h2>${inlineFormat(trimmed.slice(2))}</h2>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      html.push("<hr>");
      i++; continue;
    }

    // Collect consecutive list items
    if (trimmed.match(/^\s*[-*]\s/)) {
      const items = [];
      while (i < lines.length && lines[i].trim().match(/^\s*[-*]\s/)) {
        items.push(inlineFormat(lines[i].trim().replace(/^\s*[-*]\s/, "")));
        i++;
      }
      html.push("<ul>" + items.map(li => `<li>${li}</li>`).join("") + "</ul>");
      continue;
    }

    // Collect consecutive numbered list items
    if (trimmed.match(/^\d+[.)]\s/)) {
      const items = [];
      while (i < lines.length && lines[i].trim().match(/^\d+[.)]\s/)) {
        items.push(inlineFormat(lines[i].trim().replace(/^\d+[.)]\s/, "")));
        i++;
      }
      html.push("<ol>" + items.map(li => `<li>${li}</li>`).join("") + "</ol>");
      continue;
    }

    // Paragraph: collect consecutive non-special lines
    const paraLines = [];
    while (i < lines.length) {
      const pl = lines[i].trim();
      if (!pl || pl.startsWith("#") || pl.match(/^\s*[-*]\s/) || pl.match(/^\d+[.)]\s/) || /^[-*_]{3,}\s*$/.test(pl)) break;
      paraLines.push(pl);
      i++;
    }
    if (paraLines.length) {
      html.push(`<p>${inlineFormat(paraLines.join(" "))}</p>`);
    }
  }

  return html.join("");
}

/**
 * Apply inline formatting (bold, italic, code) to already-escaped text.
 * @param {string} text - Raw text (will be escaped internally)
 * @returns {string}
 */
function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

/**
 * Format a number with locale-appropriate thousand separators.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

/**
 * Truncate a string to a maximum length, appending "..." if trimmed.
 * @param {string} str
 * @param {number} len
 * @returns {string}
 */
export function truncate(str, len = 80) {
  if (!str || str.length <= len) return str || "";
  return str.slice(0, len) + "...";
}
