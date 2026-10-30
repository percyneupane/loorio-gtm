/** Pure scheduling rules for outreach sequences — no I/O, fully unit tested. */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DraftEmail {
  subject: string;
  body: string;
}

export interface StepSpec extends DraftEmail {
  step_index: number;
  /** Days after the first email was sent; 0 for the first email. */
  delay_days: number;
}

/** Pairs the first email + follow-ups with their send offsets (days after the first email). */
export function buildSteps(drafts: readonly DraftEmail[], followUpDays: readonly number[]): StepSpec[] {
  if (drafts.length === 0) throw new Error('A sequence needs at least one email');
  const usable = drafts.slice(0, followUpDays.length + 1);
  return usable.map((d, i) => ({
    step_index: i,
    delay_days: i === 0 ? 0 : followUpDays[i - 1],
    subject: d.subject.trim(),
    body: d.body.trim(),
  }));
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** True on weekdays between startHour (inclusive) and endHour (exclusive), local time. */
export function isWithinSendWindow(date: Date, startHour: number, endHour: number): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getHours();
  return hour >= startHour && hour < endHour;
}

/** Follow-ups are replies in the same thread, so they reuse the subject with a single "Re:". */
export function followUpSubject(firstSubject: string): string {
  const bare = firstSubject.replace(/^(re:\s*)+/i, '').trim();
  return `Re: ${bare}`;
}

/** Local calendar date key, e.g. 2026-10-29 — used for per-day send counters. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
