/**
 * Deterministic combat clock. Gameplay, mixer, and hit windows all step at
 * COMBAT_DT. Display frames only interpolate leftover time — they never
 * advance the mixer by raw raf dt (that stretched bones under hit-stop).
 */
export const COMBAT_HZ = 120;
export const COMBAT_DT = 1 / COMBAT_HZ;

export type CombatEventKind = "swing" | "skill" | "cast" | "oneshot";

export interface CombatEvent {
  kind: CombatEventKind;
  heavy?: boolean;
  slot?: number;
  index?: number;
  clip?: string;
}

const QUEUE_CAP = 8;

export class CombatTicker {
  accum = 0;
  readonly queue: CombatEvent[] = [];

  enqueue(ev: CombatEvent): boolean {
    if (this.queue.length >= QUEUE_CAP) return false;
    this.queue.push(ev);
    return true;
  }

  drain(): CombatEvent[] {
    if (!this.queue.length) return [];
    return this.queue.splice(0, this.queue.length);
  }

  /** How many fixed steps to run this display frame. */
  steps(dt: number): number {
    this.accum = Math.min(this.accum + dt, COMBAT_DT * 10);
    let n = 0;
    while (this.accum >= COMBAT_DT) {
      this.accum -= COMBAT_DT;
      n++;
    }
    return n;
  }
}
