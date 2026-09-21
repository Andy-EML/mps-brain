import { describe, expect, it } from 'vitest';
import { customerMatchBadge, parseRegistrationTab, registrationStatusBadge, selectedIds } from './registrations';

describe('parseRegistrationTab', () => {
  it('accepts the five tabs and falls back to awaiting approval', () => {
    for (const tab of ['awaiting', 'waiting', 'registered', 'failed', 'rejected']) expect(parseRegistrationTab(tab)).toBe(tab);
    expect(parseRegistrationTab('ready')).toBe('awaiting');
    expect(parseRegistrationTab(undefined)).toBe('awaiting');
  });
});

describe('customerMatchBadge', () => {
  it('flags mismatches for the approver and says nothing when there is no verdict', () => {
    expect(customerMatchBadge('match')).toEqual({ tone: 'ok', label: 'Customer matches' });
    expect(customerMatchBadge('no_shared_words')).toMatchObject({ tone: 'warn' });
    expect(customerMatchBadge('mismatch')).toMatchObject({ tone: 'critical' });
    expect(customerMatchBadge(null)).toBeNull();
  });
});

describe('registrationStatusBadge', () => {
  it('labels every status', () => {
    expect(registrationStatusBadge('approved')).toEqual({ tone: 'warn', label: 'Approved · sending to DRMS' });
    expect(registrationStatusBadge('registered').tone).toBe('ok');
    expect(registrationStatusBadge('failed').tone).toBe('critical');
    for (const s of ['awaiting_approval', 'waiting', 'rejected'] as const) expect(registrationStatusBadge(s).label).toBeTruthy();
  });
});

describe('selectedIds', () => {
  it('takes the ticked ids, de-duplicated, ignoring anything that is not a positive integer', () => {
    const f = new FormData();
    for (const v of ['3', '5', '3', 'x', '-1', '0', '2.5']) f.append('id', v);
    expect(selectedIds(f)).toEqual([3, 5]);
  });

  it('uses only the row whose own button was pressed, ignoring the ticks', () => {
    const f = new FormData();
    f.append('id', '3');
    f.append('id', '5');
    f.append('only', '9');
    expect(selectedIds(f)).toEqual([9]);
  });
});
