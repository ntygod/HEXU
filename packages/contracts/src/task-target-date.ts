import { DomainError } from './index.js';

/** A calendar date, not a timestamp. Never normalize invalid input through Date. */
export function isValidTaskTargetDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export function parseTaskTargetDate(value: unknown): string | null {
  if (value === null) return null;
  if (!isValidTaskTargetDate(value))
    throw new DomainError(
      'INVALID_INPUT',
      '目标日期需要真实的 YYYY-MM-DD 日历日期（0001–9999 年），或 null 清除',
    );
  return value;
}
