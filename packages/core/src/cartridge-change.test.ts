import { describe, expect, it } from 'vitest';
import { detectChanges, type EmptyEvent, type LevelReading } from './cartridge-change';

const t = (day: number, hour = 0) => new Date(Date.UTC(2026, 10, day, hour));
let snap = 0;
const r = (day: number, value: number, hour = 0): LevelReading => ({ at: t(day, hour), value, snapshotId: ++snap });
const e = (day: number, alarmId = `A${day}`, hour = 0): EmptyEvent => ({ at: t(day, hour), alarmId });
const run = (readings: LevelReading[], empties: EmptyEvent[] = [], afterEmpty = false, since = t(1)) =>
  detectChanges({ since, afterEmpty, readings, empties });

describe('detectChanges', () => {
  it('low 5 then 92 gives one level change at the 92 reading', () => {
    const low = r(2, 5);
    const high = r(3, 92);
    const out = run([low, high]);
    expect(out).toEqual([
      {
        at: high.at,
        source: 'level',
        alarmId: null,
        lowSnapshotId: low.snapshotId,
        highSnapshotId: high.snapshotId,
        lowLevel: 5,
        highLevel: 92,
      },
    ]);
  });

  it('low 10 then 70 is a change (late first read)', () => {
    const out = run([r(2, 10), r(3, 70)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('level');
    expect(out[0]!.highLevel).toBe(70);
  });

  it('30 then 95 is nothing', () => {
    expect(run([r(2, 30), r(3, 95)])).toEqual([]);
  });

  it('Empty then 3 then 90 gives one empty_alarm change only', () => {
    const out = run([r(3, 3), r(4, 90)], [e(2, 'X')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: 'empty_alarm',
      alarmId: 'X',
      lowSnapshotId: null,
      highSnapshotId: null,
      lowLevel: null,
      highLevel: null,
    });
  });

  it('afterEmpty true, then 90 gives nothing', () => {
    expect(run([r(2, 90)], [], true)).toEqual([]);
  });

  it('afterEmpty true with 3 then 90 gives nothing (swap absorbed)', () => {
    expect(run([r(2, 3), r(3, 90)], [], true)).toEqual([]);
  });

  it('two Empties with no rise give one change', () => {
    const out = run([], [e(2, 'A'), e(3, 'B')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.alarmId).toBe('A');
  });

  it('Empty, 95, 8, 88 gives two changes (empty_alarm, level)', () => {
    const out = run([r(3, 95), r(4, 8), r(5, 88)], [e(2)]);
    expect(out.map((c) => c.source)).toEqual(['empty_alarm', 'level']);
    expect(out[1]!.at).toEqual(t(5));
    expect(out[1]!.lowLevel).toBe(8);
    expect(out[1]!.highLevel).toBe(88);
  });

  it('readings and empties at or before since are ignored', () => {
    const since = t(5);
    expect(run([r(4, 5), r(5, 5), r(6, 92)], [e(5), e(3)], false, since)).toEqual([]);
  });

  it('12 then 40 gives nothing', () => {
    expect(run([r(2, 12), r(3, 40)])).toEqual([]);
  });

  it('a reading before an Empty at the same instant is processed first', () => {
    // low then 90 (change), then Empty at the same instant as the 90 reading.
    const out = run([r(2, 5), r(3, 90)], [e(3, 'Z')]);
    expect(out.map((c) => c.source)).toEqual(['level', 'empty_alarm']);
  });

  it('sorts unsorted input', () => {
    const out = run([r(3, 92), r(2, 5)], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.lowLevel).toBe(5);
  });

  it('uses the first low reading since the last change', () => {
    const first = r(2, 10);
    const out = run([r(3, 4), first, r(4, 90)]);
    expect(out[0]!.lowSnapshotId).toBe(first.snapshotId);
    expect(out[0]!.lowLevel).toBe(10);
  });

  it('Empty, 30, 5, 80 gives the Empty change then one level change (partly used spare absorbs the Empty)', () => {
    const out = run([r(3, 30), r(4, 5), r(5, 80)], [e(2)]);
    expect(out.map((c) => c.source)).toEqual(['empty_alarm', 'level']);
    expect(out[1]!.lowLevel).toBe(5);
    expect(out[1]!.highLevel).toBe(80);
  });

  it('Empty, 8, 90 gives one change only', () => {
    const out = run([r(3, 8), r(4, 90)], [e(2)]);
    expect(out.map((c) => c.source)).toEqual(['empty_alarm']);
  });

  it('afterEmpty true then 30, 5, 80 gives one level change', () => {
    const out = run([r(2, 30), r(3, 5), r(4, 80)], [], true);
    expect(out.map((c) => c.source)).toEqual(['level']);
  });
});
