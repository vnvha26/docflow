// IANA zone names only ("Asia/Ho_Chi_Minh", "Europe/Paris", "UTC").
// Offsets such as "+07:00" and legacy abbreviations such as "EST" are rejected:
// reminders must follow daylight-saving rules of a real region.
const IANA_NAME = /^(?:UTC|[A-Z][A-Za-z_-]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !IANA_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
