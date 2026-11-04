export interface TimeZoneOption { value: string; label: string; offsetMinutes: number }

function offsetOf(zone: string, at: Date): { label: string; minutes: number } {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at).find((item) => item.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return { label: match ? `GMT${match[1]}${match[2]}:${match[3]}` : 'GMT+00:00', minutes };
}

let cache: string[] | null = null;
function browserZones(): string[] {
  if (!cache) {
    try { cache = Intl.supportedValuesOf('timeZone'); } catch { cache = []; }
    if (!cache.includes('UTC')) cache = [...cache, 'UTC'];
  }
  return cache;
}

export function canonicalZone(zone: string): string {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; } catch { return zone; }
}

/**
 * Browser zone list, sorted by current UTC offset. The saved value keeps its own
 * spelling: browsers list "Asia/Saigon" while the account default is the alias
 * "Asia/Ho_Chi_Minh", so the alias replaces its canonical entry instead of duplicating it.
 */
export function timeZoneOptions(selected: string, at = new Date()): TimeZoneOption[] {
  const canonical = canonicalZone(selected);
  const zones = browserZones().map((zone) => zone === canonical ? selected : zone);
  if (!zones.includes(selected)) zones.unshift(selected);
  return zones.map((zone) => {
    const offset = offsetOf(zone, at);
    return { value: zone, label: `(${offset.label}) ${zone.replaceAll('_', ' ')}`, offsetMinutes: offset.minutes };
  }).sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value));
}

export function deviceZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
