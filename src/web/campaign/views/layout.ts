export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — azworld campaigns</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 56rem; padding: 0 1.25rem; color: #1f2937; background: #fafafa; }
  h1, h2, h3 { line-height: 1.2; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.5rem; }
  h3 { font-size: 0.95rem; margin: 1rem 0 0.25rem; color: #374151; }
  a { color: #1d4ed8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  nav.crumbs { font-size: 0.85rem; margin-bottom: 1rem; color: #6b7280; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  form.inline { display: inline; }
  textarea, input[type=text] { width: 100%; box-sizing: border-box; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font: inherit; }
  textarea { min-height: 5rem; resize: vertical; }
  button { padding: 0.45rem 0.9rem; border: 1px solid #1d4ed8; background: #1d4ed8; color: #fff; border-radius: 4px; cursor: pointer; font: inherit; }
  button.secondary { background: #fff; color: #1d4ed8; }
  button.danger { background: #fff; color: #b91c1c; border-color: #b91c1c; }
  .slot { border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.75rem 1rem; margin: 0.75rem 0; background: #fff; }
  .slot[data-status="proposed"] { border-color: #f59e0b; }
  .slot[data-status="accepted"] { border-color: #16a34a; }
  .slot[data-status="open"] { border-color: #d1d5db; opacity: 0.8; }
  .status-tag { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 3px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; margin-left: 0.5rem; }
  .status-tag.open { background: #f3f4f6; color: #6b7280; }
  .status-tag.proposed { background: #fef3c7; color: #92400e; }
  .status-tag.accepted { background: #dcfce7; color: #166534; }
  .candidate { border-left: 3px solid #f59e0b; padding: 0.4rem 0.8rem; margin: 0.4rem 0; background: #fffbeb; }
  .candidate .cid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #92400e; font-size: 0.8rem; margin-right: 0.4rem; }
  .accepted-entry { border-left: 3px solid #16a34a; padding: 0.4rem 0.8rem; margin: 0.4rem 0; background: #f0fdf4; }
  .notes { font-style: italic; color: #6b7280; margin-top: 0.4rem; }
  details.history-entry { margin: 0.25rem 0; padding: 0.3rem 0.5rem; background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; font-size: 0.85rem; }
  details.history-entry summary { cursor: pointer; }
  pre { background: #f3f4f6; padding: 0.5rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; }
  .empty { color: #6b7280; font-style: italic; }
  .controls { margin-top: 1rem; display: flex; gap: 0.5rem; }
  .turn-form { margin-top: 1.5rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
