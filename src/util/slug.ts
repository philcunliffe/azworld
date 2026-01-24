export function slugify(input: string): string {
  const s = (input || "").trim().toLowerCase();
  // Keep alnum and spaces, collapse whitespace to dashes
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
