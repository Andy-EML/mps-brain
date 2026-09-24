import { describe, expect, it } from 'vitest';
import { awaitingTabCount, customerMatchBadge, parseRegistrationTab, registrationStatusBadge, retryConfirmText, selectedIds } from './registrations';

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

describe('retryConfirmText', () => {
  it('warns hardest when DRMS never gave a request id (the first attempt may still be processing)', () => {
    expect(retryConfirmText({ requestId: null, serial: 'S1' })).toContain('DRMS may still be processing the first attempt — check the device in DRMS first');
    const known = retryConfirmText({ requestId: 'r1', serial: 'S1' });
    expect(known).toContain('S1');
    expect(known).not.toContain('may still be processing');
  });
});

describe('awaitingTabCount', () => {
  it('counts exactly what the tab lists: awaiting a decision plus approved and sending', () => {
    expect(awaitingTabCount({ awaitingApproval: 3, approved: 2 })).toEqual({ total: 5, text: '3 + 2 sending' });
    expect(awaitingTabCount({ awaitingApproval: 3, approved: 0 })).toEqual({ total: 3, text: '3' });
  });

  it('keeps the thousands separators the other tab counts have', () => {
    expect(awaitingTabCount({ awaitingApproval: 1234, approved: 0 }).text).toBe('1,234');
    expect(awaitingTabCount({ awaitingApproval: 1234, approved: 1500 }).text).toBe('1,234 + 1,500 sending');
  });
});
