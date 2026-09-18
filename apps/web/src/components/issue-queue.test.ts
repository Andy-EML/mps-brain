import { describe, expect, it } from 'vitest';
import { canLink, canUnlink, issueDetailLines, issueTabs, issueTone, issueTypeTitle } from './issue-queue';

describe('issueTypeTitle', () => {
  it('reads as a sentence for every type the linker raises', () => {
    expect(issueTypeTitle('no_match_drms')).toBe('No Vantage match');
    expect(issueTypeTitle('no_match_vantage')).toBe('No DRMS match');
    expect(issueTypeTitle('serial_ambiguous')).toBe('Ambiguous serial');
    expect(issueTypeTitle('erp_serial_disagree')).toBe('ERP/serial disagreement');
    expect(issueTypeTitle('customer_mismatch')).toBe('Customer mismatch');
    expect(issueTypeTitle('link_broken')).toBe('Broken link');
    expect(issueTypeTitle('duplicate_target')).toBe('Duplicate target');
  });

  it('falls back to the raw type, humanised, so a new linker issue still reads', () => {
    expect(issueTypeTitle('something_new')).toBe('Something new');
  });
});

describe('issueTone', () => {
  it('reserves critical for the two that cost money, and mutes the expected noise', () => {
    expect(issueTone('link_broken')).toBe('critical');
    expect(issueTone('duplicate_target')).toBe('critical');
    expect(issueTone('no_match_vantage')).toBe('muted');
    expect(issueTone('no_match_drms')).toBe('warn');
    expect(issueTone('anything_else')).toBe('warn');
  });
});

describe('issueDetailLines', () => {
  it('labels the keys each issue type actually carries', () => {
    expect(issueDetailLines({ erpId: 'E1', serialNorm: 'a93e02' })).toEqual([
      { label: 'DRMS ERP id', value: 'E1' },
      { label: 'Normalised serial', value: 'a93e02' },
    ]);
    expect(issueDetailLines({ vantageIds: [7, 9] })).toEqual([{ label: 'Candidate Vantage ids', value: '7, 9' }]);
    // The holder is an opaque DRMS GUID, so it gets a link to that device's page.
    expect(issueDetailLines({ linkedDrmsId: 'd9', method: 'serial' })).toEqual([
      { label: 'Vantage record already held by', value: 'd9', href: '/devices/d9' },
      { label: 'Match method', value: 'serial' },
    ]);
  });

  it('turns link_broken reasons into English', () => {
    expect(issueDetailLines({ reason: 'drms_missing' })).toEqual([
      { label: 'Reason', value: 'DRMS no longer lists this device' },
    ]);
    expect(issueDetailLines({ reason: 'vantage_deleted' })).toEqual([
      { label: 'Reason', value: 'The Vantage record was deleted' },
    ]);
    expect(issueDetailLines({ reason: 'drms_status', status: 'Deleted' })).toEqual([
      { label: 'Reason', value: 'DRMS status is not linkable' },
      { label: 'DRMS status', value: 'Deleted' },
    ]);
  });

  it('humanises an unknown key rather than hiding it', () => {
    expect(issueDetailLines({ someNewKey: 42 })).toEqual([{ label: 'Some new key', value: '42' }]);
  });

  it('skips empty values and survives a non-object', () => {
    expect(issueDetailLines({ erpId: null, serialNorm: '' })).toEqual([]);
    expect(issueDetailLines(null)).toEqual([]);
    expect(issueDetailLines('nonsense')).toEqual([]);
    expect(issueDetailLines({})).toEqual([]);
  });
});

describe('canLink / canUnlink', () => {
  const row = (over: Partial<Parameters<typeof canLink>[0]> = {}) => ({
    type: 'no_match_drms',
    drmsId: 'd1',
    linkedVantageId: null,
    ...over,
  });

  it('offers Link only when we know which DRMS device to link', () => {
    expect(canLink(row())).toBe(true);
    // no_match_vantage is a Vantage record with no device, so there is nothing to point anywhere.
    expect(canLink(row({ type: 'no_match_vantage', drmsId: null }))).toBe(false);
  });

  it('offers Unlink only for the two types about a link that exists', () => {
    expect(canUnlink(row({ type: 'link_broken', linkedVantageId: 10 }))).toBe(true);
    expect(canUnlink(row({ type: 'customer_mismatch', linkedVantageId: 10 }))).toBe(true);
    // Already unlinked — the link-run closed it — so there is nothing to undo.
    expect(canUnlink(row({ type: 'link_broken', linkedVantageId: null }))).toBe(false);
    expect(canUnlink(row({ type: 'no_match_drms', linkedVantageId: 10 }))).toBe(false);
  });
});

describe('issueTabs', () => {
  const counts = { no_match_vantage: 996, no_match_drms: 4, duplicate_target: 1 };

  it('leads with Needs attention, which is everything but the expected noise', () => {
    const tabs = issueTabs(counts);
    expect(tabs[0]).toEqual({ value: 'attention', label: 'Needs attention', count: 5 });
    expect(tabs.at(-1)).toEqual({ value: 'all', label: 'All', count: 1001 });
  });

  it('lists one tab per type present, in the linker’s own order', () => {
    expect(issueTabs(counts).map((t) => t.value)).toEqual([
      'attention',
      'no_match_drms',
      'duplicate_target',
      'no_match_vantage',
      'all',
    ]);
  });

  it('drops types with no rows and keeps unknown ones at the end', () => {
    const tabs = issueTabs({ no_match_drms: 0, mystery: 2 });
    expect(tabs.map((t) => t.value)).toEqual(['attention', 'mystery', 'all']);
    expect(tabs[1]?.label).toBe('Mystery');
  });

  it('still returns the two fixed tabs when there are no issues at all', () => {
    expect(issueTabs({})).toEqual([
      { value: 'attention', label: 'Needs attention', count: 0 },
      { value: 'all', label: 'All', count: 0 },
    ]);
  });
});
