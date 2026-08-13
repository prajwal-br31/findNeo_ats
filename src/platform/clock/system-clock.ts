import type { ClockPort } from '../../shared/ports/clock.js';

/** The real clock. Everything time-dependent goes through the port instead. */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
