/** ISO timestamp for persisted records. */
export function now(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

export function isoFromNow(msAhead: number): string {
  return new Date(Date.now() + msAhead).toISOString();
}
