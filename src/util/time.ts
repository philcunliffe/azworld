export function nowIso(): string {
  return new Date().toISOString();
}

const DURATION_UNITS: Record<string, number> = {
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  week: 7,
  weeks: 7,
  m: 30,
  month: 30,
  months: 30,
  y: 365,
  year: 365,
  years: 365,
};

export function parseDurationToDays(input: string): number | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const matches = [...trimmed.matchAll(/(\d+)\s*([a-z]+)/g)];
  if (matches.length === 0) return undefined;

  let consumed = 0;
  let totalDays = 0;

  for (const match of matches) {
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = DURATION_UNITS[unit];
    if (!Number.isFinite(amount) || !multiplier) return undefined;
    consumed += match[0].length;
    totalDays += amount * multiplier;
  }

  const remainder = trimmed.replace(/(\d+)\s*([a-z]+)/g, "").trim();
  if (remainder.length > 0 || consumed === 0) return undefined;

  return totalDays > 0 ? totalDays : undefined;
}

export function formatDayCount(days: number): string {
  if (days === 1) return "1 day";
  return `${days} days`;
}
