// time.ts
// All timestam store in Redis, return in API  response

export function now(): string {
  return new Date().toISOString();
}

export function toISOString(value: Date | number): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

export function isValidISOString(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}
