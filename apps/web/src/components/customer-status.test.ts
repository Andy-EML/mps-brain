import { describe, expect, it } from 'vitest';
import { NO_READING_DAYS, type DeviceRow, type MachineStatusRow } from '@mps/db/queries';
import {
  NO_READING_DAYS_TEXT,
  machineLineWarnings,
  machinesEmptyText,
  parseCustomerIdArg,
  pmChipText,
  pmChipTone,
  pmWarningHref,
  warningTooltip,
} from './customer-status';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-23T12:00:00Z');

function machine(over: Partial<MachineStatusRow> = {}): MachineStatusRow {
  return {
    device: { drmsId: 'D1', lastCounterAt: null } as DeviceRow,
    location: null,
    pm: null,
    pending: 0,
    lastReadingAt: new Date(NOW.getTime() - DAY),
    warnings: { noReading: false, pmOverdue: false, pending: false },
    ...over,
  };
}

describe('warningTooltip', () => {
  it('lists all three counts, plural', () => {
    expect(warningTooltip({ noReading: 2, pmOverdue: 3, pending: 3 })).toBe(
      '2 machines no reading 7+ days · 3 PM overdue · 3 pending orders',
    );
  });

  it('uses the singular for one', () => {
    expect(warningTooltip({ noReading: 1, pmOverdue: 1, pending: 1 })).toBe(
      '1 machine no reading 7+ days · 1 PM overdue · 1 pending order',
    );
  });

  it('shows only the non-zero warning', () => {
    expect(warningTooltip({ noReading: 0, pmOverdue: 0, pending: 4 })).toBe('4 pending orders');
    expect(warningTooltip({ noReading: 0, pmOverdue: 2, pending: 0 })).toBe('2 PM overdue');
  });

  it('is empty when there is no warning', () => {
    expect(warningTooltip({ noReading: 0, pmOverdue: 0, pending: 0 })).toBe('');
  });

  it('says the same day count as the database rule', () => {
    expect(NO_READING_DAYS_TEXT).toBe(NO_READING_DAYS);
  });
});

describe('pmWarningHref', () => {
  it('links to /pm filtered to the customer name, encoded', () => {
    expect(pmWarningHref('Acme & Sons Ltd', false)).toBe('/pm?customer=Acme%20%26%20Sons%20Ltd');
  });

  it('is null for a head office (its sites are not under its name) or a nameless customer', () => {
    expect(pmWarningHref('Acme Group', true)).toBeNull();
    expect(pmWarningHref(null, false)).toBeNull();
    expect(pmWarningHref('   ', false)).toBeNull();
  });
});

describe('parseCustomerIdArg', () => {
  it('accepts a string of 1-9 digits', () => {
    expect(parseCustomerIdArg('42')).toBe(42);
    expect(parseCustomerIdArg('123456789')).toBe(123456789);
  });

  it('refuses anything else', () => {
    for (const v of [
      '4x',
      '',
      '-1',
      '1234567890',
      ' 42',
      '4.2',
      '1e3',
      42,
      undefined,
      null,
      ['42'],
      { id: 42 },
    ]) {
      expect(parseCustomerIdArg(v)).toBeNull();
    }
  });
});

describe('machineLineWarnings', () => {
  it('lists no reading (with days), PM overdue and pending', () => {
    const m = machine({
      lastReadingAt: new Date(NOW.getTime() - 9 * DAY),
      pm: { status: 'overdue', overdueReason: 'pages', bookedOverdue: false, view: 'due', otherDealer: null },
      pending: 2,
      warnings: { noReading: true, pmOverdue: true, pending: true },
    });
    expect(machineLineWarnings(m, NOW)).toEqual(['No reading 9 days', 'PM overdue', '2 pending']);
  });

  it('says when a machine has never had a reading', () => {
    const m = machine({
      lastReadingAt: null,
      warnings: { noReading: true, pmOverdue: false, pending: false },
    });
    expect(machineLineWarnings(m, NOW)).toEqual(['No reading on record']);
  });

  it('is empty for a clean machine', () => {
    expect(machineLineWarnings(machine(), NOW)).toEqual([]);
  });
});

describe('machinesEmptyText', () => {
  it('is the empty panel line', () => {
    expect(machinesEmptyText()).toBe('No machines');
  });
});

describe('pmChipTone', () => {
  const pm = (status: 'overdue' | 'due_soon' | 'ok', view: 'due' | 'booked' | 'dismissed', otherDealer: string | null = null) => ({
    status,
    overdueReason: null,
    bookedOverdue: false,
    view,
    otherDealer,
  });

  it('uses the status tone on the Due view', () => {
    expect(pmChipTone(pm('overdue', 'due'))).toBe('critical');
    expect(pmChipTone(pm('due_soon', 'due'))).toBe('warn');
    expect(pmChipTone(pm('ok', 'due'))).toBe('ok');
  });

  it('is muted when booked or dismissed, so red only shows with a PM warning', () => {
    expect(pmChipTone(pm('overdue', 'booked'))).toBe('muted');
    expect(pmChipTone(pm('overdue', 'dismissed'))).toBe('muted');
  });

  it('is muted at an other-dealer site, whatever the status', () => {
    expect(pmChipTone(pm('overdue', 'due', 'MJ Flood'))).toBe('muted');
    expect(pmChipTone(pm('due_soon', 'due', 'CMYK'))).toBe('muted');
  });
});

describe('pmChipText', () => {
  const pm = (o: Partial<NonNullable<MachineStatusRow['pm']>> = {}): NonNullable<MachineStatusRow['pm']> => ({
    status: 'overdue',
    overdueReason: null,
    bookedOverdue: false,
    view: 'due',
    otherDealer: null,
    ...o,
  });

  it('names the other dealer instead of a status', () => {
    expect(pmChipText(pm({ otherDealer: 'MJ Flood' }))).toBe('Other dealer: MJ Flood');
    expect(pmChipText(pm({ otherDealer: 'MJ Flood', overdueReason: 'pages' }))).toBe('Other dealer: MJ Flood');
  });

  it('says why a machine is overdue, else the status label', () => {
    expect(pmChipText(pm({ overdueReason: 'pages' }))).toBe('Overdue by pages');
    expect(pmChipText(pm({ status: 'due_soon' }))).toBe('Due soon');
  });
});
