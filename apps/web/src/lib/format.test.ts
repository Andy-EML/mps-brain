import { describe, expect, it } from 'vitest';
import { formatGap, formatIsoDateTime, machineActionLabel, shortModel } from './format';

const NOW = new Date('2026-09-18T12:00:00Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('formatGap', () => {
  it('reads in hours while the gap is short enough to matter in hours', () => {
    expect(formatGap(hoursBefore(1), NOW)).toBe('1 hour');
    expect(formatGap(hoursBefore(26), NOW)).toBe('26 hours');
    expect(formatGap(hoursBefore(47), NOW)).toBe('47 hours');
  });

  it('switches to days at two days', () => {
    expect(formatGap(hoursBefore(48), NOW)).toBe('2 days');
    expect(formatGap(hoursBefore(24 * 30), NOW)).toBe('30 days');
  });

  it('does not pretend a gap under an hour is a number of hours', () => {
    expect(formatGap(hoursBefore(0.5), NOW)).toBe('under an hour');
    // A clock skew, or a row written a moment in the future, must not render as "-1 hours".
    expect(formatGap(new Date(NOW.getTime() + 60_000), NOW)).toBe('under an hour');
  });

  it('takes an ISO string, and says nothing useful for nothing', () => {
    expect(formatGap('2026-09-16T12:00:00Z', NOW)).toBe('2 days');
    expect(formatGap(null, NOW)).toBe('—');
    expect(formatGap('not a date', NOW)).toBe('—');
  });
});

describe('formatIsoDateTime', () => {
  it('writes yyyy-mm-dd HH:mm in UK time, for spreadsheets', () => {
    // British Summer Time: UTC+1.
    expect(formatIsoDateTime(new Date('2026-09-18T23:30:00Z'))).toBe('2026-09-19 00:30');
    // Winter: UTC.
    expect(formatIsoDateTime(new Date('2026-01-05T08:05:00Z'))).toBe('2026-01-05 08:05');
  });

  it('is empty for nothing', () => {
    expect(formatIsoDateTime(null)).toBe('');
    expect(formatIsoDateTime(new Date('nope'))).toBe('');
  });
});

describe('machineActionLabel', () => {
  it('starts with the visible text and names the customer and serial', () => {
    expect(machineActionLabel('Remove', 'Acme Ltd', 'A1B2C3')).toBe('Remove: Acme Ltd, serial A1B2C3');
  });
  it('falls back when the customer or serial is missing', () => {
    expect(machineActionLabel('Priority', null, 'A1')).toBe('Priority: Unknown customer, serial A1');
    expect(machineActionLabel('Plan actions', 'Acme', null)).toBe('Plan actions: Acme');
    expect(machineActionLabel('Priority', '  ', '')).toBe('Priority: Unknown customer');
  });
});

describe('shortModel', () => {
  it('strips the make and trailing descriptors', () => {
    expect(shortModel('Konica Minolta C300i Digital Colour Photocopier')).toBe('C300i');
    expect(shortModel('Olivetti MF254 Digital Colour Photocopier')).toBe('MF254');
    expect(shortModel('KONICA MINOLTA bizhub 4050i Digital Mono Printer')).toBe('bizhub 4050i');
    expect(shortModel('Develop ineo+ 450i A3 MFP')).toBe('ineo+ 450i');
    expect(shortModel('Kyocera TASKalfa 2554ci Photocopier')).toBe('TASKalfa 2554ci');
    expect(shortModel('Konica Bizhub 300i')).toBe('Bizhub 300i');
  });
  it('leaves short names alone', () => {
    expect(shortModel('bizhub C300i')).toBe('bizhub C300i');
    expect(shortModel('ineo+458')).toBe('ineo+458');
    expect(shortModel('  C258  ')).toBe('C258');
  });
  it('never strips to nothing', () => {
    expect(shortModel('Konica Minolta')).toBe('Konica Minolta');
    expect(shortModel('Photocopier')).toBe('Photocopier');
  });
  it('blank is a dash', () => {
    expect(shortModel(null)).toBe('—');
    expect(shortModel('   ')).toBe('—');
  });
});
