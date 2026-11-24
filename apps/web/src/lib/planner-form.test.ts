import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { groupSummary, parseMoveForm, parseRemoveForm, plannerRedirectHref, plannerReturnHref, reasonBadgeText } from './planner-form';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe('invalid_pm_action');
    return;
  }
  throw new Error('expected a SettingsError');
};

describe('parseMoveForm', () => {
  it('accepts to_plan, asked and done', () => {
    expect(parseMoveForm(form({ vantageEquipmentId: ' 42 ', to: 'to_plan' }))).toEqual({ vantageEquipmentId: 42, to: 'to_plan', note: null });
    expect(parseMoveForm(form({ vantageEquipmentId: '42', to: 'asked', note: '  Rang Dave  ' }))).toEqual({
      vantageEquipmentId: 42,
      to: 'asked',
      note: 'Rang Dave',
    });
    expect(parseMoveForm(form({ vantageEquipmentId: '42', to: 'to_plan', note: '   ' }))).toEqual({ vantageEquipmentId: 42, to: 'to_plan', note: null });
  });

  it('refuses booked (it goes through the Mark-booked form), done (not a board move), unknown columns and a missing column', () => {
    refused(() => parseMoveForm(form({ vantageEquipmentId: '42', to: 'booked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '42', to: 'done' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '42', to: 'later' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '42', to: '' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '42' })));
  });

  it('refuses a blank, zero, negative or non-numeric machine id', () => {
    refused(() => parseMoveForm(form({ to: 'asked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '', to: 'asked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '0', to: 'asked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '-4', to: 'asked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '4x', to: 'asked' })));
    refused(() => parseMoveForm(form({ vantageEquipmentId: '12345678901', to: 'asked' })));
  });

  it('refuses a note over 500 characters', () => {
    expect(parseMoveForm(form({ vantageEquipmentId: '1', to: 'asked', note: 'x'.repeat(500) })).note).toHaveLength(500);
    refused(() => parseMoveForm(form({ vantageEquipmentId: '1', to: 'asked', note: 'x'.repeat(501) })));
  });
});

describe('parseRemoveForm', () => {
  it('reads the machine id', () => {
    expect(parseRemoveForm(form({ vantageEquipmentId: '7' }))).toEqual({ vantageEquipmentId: 7 });
  });
  it('refuses a missing or bad id', () => {
    refused(() => parseRemoveForm(form({})));
    refused(() => parseRemoveForm(form({ vantageEquipmentId: 'abc' })));
  });
});

describe('plannerReturnHref', () => {
  it('keeps the planner URL and its query', () => {
    expect(plannerReturnHref('/pm/planner?x=1')).toBe('/pm/planner?x=1');
    expect(plannerReturnHref('/pm/planner')).toBe('/pm/planner');
  });

  it('turns anything else into the bare planner', () => {
    for (const raw of ['https://evil', '//evil', '/pm', '/pm/planner/../x', '/pm/plannerx', '/pm/planner/1', '\\\\evil', 'pm/planner', '']) {
      expect(plannerReturnHref(raw)).toBe('/pm/planner');
    }
    expect(plannerReturnHref(null)).toBe('/pm/planner');
    expect(plannerReturnHref(new File([], 'x'))).toBe('/pm/planner');
  });

  it('drops a hash', () => {
    expect(plannerReturnHref('/pm/planner?x=1#card-4')).toBe('/pm/planner?x=1');
  });
});

describe('plannerRedirectHref', () => {
  it('planner redirect keeps board view', () => {
    expect(plannerRedirectHref('/pm/planner?view=board', 12)).toBe('/pm/planner?view=board#card-12');
    expect(plannerRedirectHref('/pm/planner', 12)).toBe('/pm/planner?view=board#card-12');
    expect(plannerRedirectHref('/pm/planner?view=map', 12)).toBe('/pm/planner?view=board#card-12');
  });

  it('goes back to the card, with the error key when refused', () => {
    expect(plannerRedirectHref('/pm/planner?x=1', 42)).toBe('/pm/planner?x=1&view=board#card-42');
    expect(plannerRedirectHref('/pm/planner?x=1', 42, 'past_booked')).toBe('/pm/planner?x=1&view=board&card=42&plannerError=past_booked#card-42');
  });

  it('replaces an earlier error and card', () => {
    expect(plannerRedirectHref('/pm/planner?card=1&plannerError=save_failed', 2)).toBe('/pm/planner?view=board#card-2');
  });

  it('without a machine goes to the planner', () => {
    expect(plannerRedirectHref('https://evil', null)).toBe('/pm/planner?view=board');
    expect(plannerRedirectHref('/pm/planner', null, 'invalid_pm_action')).toBe('/pm/planner?view=board&plannerError=invalid_pm_action');
  });
});

describe('reasonBadgeText', () => {
  const plain = { leftDue: null, reason: null, askedDays: null, askedStale: false } as const;

  it('says why a card left the due set', () => {
    expect(reasonBadgeText({ ...plain, leftDue: 'other_dealer' })).toBe('Other dealer — no longer ours');
    expect(reasonBadgeText({ ...plain, leftDue: 'dismissed' })).toBe('Dismissed');
    expect(reasonBadgeText({ ...plain, leftDue: 'left_contract' })).toBe('No longer on an active contract');
    expect(reasonBadgeText({ ...plain, leftDue: 'not_due' })).toBe('No longer due');
  });

  it('leaving the due set wins over the other reasons', () => {
    expect(reasonBadgeText({ leftDue: 'dismissed', reason: 'Booked visit not seen', askedDays: 9, askedStale: true })).toBe('Dismissed');
  });

  it('says how long ago a stale Asked card was asked', () => {
    expect(reasonBadgeText({ ...plain, askedDays: 9, askedStale: true })).toBe('Asked 9 days ago');
    expect(reasonBadgeText({ ...plain, askedDays: 3, askedStale: false })).toBeNull();
  });

  it('otherwise shows the card’s reason, or nothing', () => {
    expect(reasonBadgeText({ ...plain, reason: 'Booked visit not seen' })).toBe('Booked visit not seen');
    expect(reasonBadgeText(plain)).toBeNull();
  });
});

describe('groupSummary', () => {
  const card = (c: Partial<{ column: 'to_plan' | 'asked' | 'booked' | 'done'; overdueMonths: number | null; priority: boolean }>) => ({
    column: 'to_plan' as const,
    overdueMonths: null,
    priority: false,
    ...c,
  });

  it('counts due (not Done), overdue and priority', () => {
    expect(
      groupSummary('GU14', [
        card({ overdueMonths: 18, priority: true }),
        card({ overdueMonths: 0 }),
        card({ column: 'asked' }),
        card({ column: 'booked' }),
        card({}),
      ]),
    ).toBe('GU14 · 5 due · 2 overdue · 1 priority');
  });

  it('leaves Done cards out of the due count and says how many are done', () => {
    expect(groupSummary('GU14', [card({ column: 'done', overdueMonths: 3, priority: true }), card({ column: 'done' })])).toBe('GU14 · 2 done');
    expect(groupSummary('Hampshire', [card({}), card({ column: 'done' })])).toBe('Hampshire · 1 due · 1 done');
  });
});
