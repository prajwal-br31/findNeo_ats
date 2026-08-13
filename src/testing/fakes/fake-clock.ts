import type { ClockPort } from '../../shared/ports/clock.js';

/**
 * Controllable clock (11 §2, D-004).
 *
 * Cool-off windows, token expiry and lockout are tested by advancing this,
 * never by sleeping — a test that waits is slow and flaky, and a cool-off
 * window measured in months cannot be waited out at all.
 */
export class FakeClock implements ClockPort {
  #current: Date;

  constructor(start: Date = new Date('2026-08-13T09:00:00.000Z')) {
    this.#current = start;
  }

  now(): Date {
    return new Date(this.#current);
  }

  advanceMs(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }

  set(instant: Date): void {
    this.#current = instant;
  }
}
