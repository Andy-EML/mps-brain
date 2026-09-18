export function isSundayIn(timeZone: string, at: Date): boolean {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at) === 'Sun';
}

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
