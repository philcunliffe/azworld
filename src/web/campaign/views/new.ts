import { htmlPage, escapeHtml } from "./layout";

export function renderNewPage(opts: { error?: string; name?: string; intent?: string }): string {
  const errorBanner = opts.error
    ? `<p style="color:#b91c1c"><strong>${escapeHtml(opts.error)}</strong></p>`
    : "";

  const body = `
    <nav class="crumbs"><a href="/campaign">Campaigns</a> / New</nav>
    <h1>New campaign</h1>
    ${errorBanner}
    <form method="post" action="/campaign/new">
      <p>
        <label>
          Name (required)<br />
          <input type="text" name="name" required maxlength="120" value="${escapeHtml(opts.name ?? "")}" />
        </label>
      </p>
      <p>
        <label>
          Initial intent (optional)<br />
          <textarea name="intent" rows="4" placeholder="e.g. PCs in a coastal city, smuggling intrigue, low fantasy">${escapeHtml(opts.intent ?? "")}</textarea>
        </label>
      </p>
      <p>
        <button type="submit">Create</button>
        <a href="/campaign"><button class="secondary" type="button">Cancel</button></a>
      </p>
    </form>
  `;
  return htmlPage("New campaign", body);
}
