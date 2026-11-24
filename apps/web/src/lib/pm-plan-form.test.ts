import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { parsePlanForm } from './pm-plan-form';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('parsePlanForm', () => {
  it('reads the machine id, the on switch and the customer id', () => {
    expect(parsePlanForm(form({ vantageEquipmentId: ' 42 ', on: 'true' }))).toEqual({ vantageEquipmentId: 42, on: true, vantageCustomerId: null });
    expect(parsePlanForm(form({ vantageEquipmentId: '42', on: 'false' }))).toEqual({ vantageEquipmentId: 42, on: false, vantageCustomerId: null });
    expect(parsePlanForm(form({ vantageEquipmentId: '1234567890', vantageCustomerId: '7' }))).toEqual({
      vantageEquipmentId: 1234567890,
      on: null,
      vantageCustomerId: 7,
    });
  });

  it.each([[''], ['  '], ['-1'], ['0'], ['abc'], ['1.5'], ['12345678901']])('rejects machine id %j with a SettingsError', (raw) => {
    expect(() => parsePlanForm(form({ vantageEquipmentId: raw }))).toThrow(SettingsError);
  });

  it('rejects a missing machine id, a junk on switch and a junk customer id', () => {
    expect(() => parsePlanForm(new FormData())).toThrow(SettingsError);
    expect(() => parsePlanForm(form({ vantageEquipmentId: '1', on: 'yes' }))).toThrow(SettingsError);
    expect(() => parsePlanForm(form({ vantageEquipmentId: '1', vantageCustomerId: '-3' }))).toThrow(SettingsError);
  });

  it('uses the invalid_pm_action code', () => {
    try {
      parsePlanForm(form({ vantageEquipmentId: 'x' }));
      expect.unreachable();
    } catch (e) {
      expect((e as SettingsError).code).toBe('invalid_pm_action');
    }
  });
});
