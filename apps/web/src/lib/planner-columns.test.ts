import { describe, expect, it } from 'vitest';
import { askedTag, isManualBooked, visibleColumnOf } from './planner-columns';

describe('visibleColumnOf', () => {
  it('to_plan is Planned', () => expect(visibleColumnOf('to_plan')).toBe('planned'));
  it('asked is Planned', () => expect(visibleColumnOf('asked')).toBe('planned'));
  it('booked is Booked', () => expect(visibleColumnOf('booked')).toBe('booked'));
  it('done is not shown', () => expect(visibleColumnOf('done')).toBeNull());
});

describe('askedTag', () => {
  it('reads the four-letter en-GB September', () => {
    expect(askedTag({ column: 'asked', note: 'Asked Keith for 3 Sept' })).toBe('Asked Keith · 3 Sept');
  });

  it('askedTag uses latest Asked line', () => {
    expect(askedTag({ column: 'asked', note: 'key in reception\nAsked Andy for 24 Nov\nAsked Keith for 25 Nov' })).toBe('Asked Keith · 25 Nov');
  });
  it('keeps a full engineer name', () => {
    expect(askedTag({ column: 'asked', note: 'Asked Keith Smith for 3 Dec' })).toBe('Asked Keith Smith · 3 Dec');
  });
  it('askedTag falls back', () => {
    expect(askedTag({ column: 'asked', note: 'gate code 1234' })).toBe('Asked engineer');
    expect(askedTag({ column: 'asked', note: null })).toBe('Asked engineer');
  });
  it('is null when not asked', () => {
    expect(askedTag({ column: 'to_plan', note: 'Asked Andy for 24 Nov' })).toBeNull();
    expect(askedTag({ column: 'booked', note: null })).toBeNull();
  });
});

describe('isManualBooked', () => {
  it('is true for a booking recorded here', () => {
    expect(isManualBooked({ column: 'booked', reason: 'Booked for 25 Nov (ref W-1)' })).toBe(true);
    expect(isManualBooked({ column: 'booked', reason: 'Booked' })).toBe(true);
  });
  it('is false for a Vantage PM job or a card not in Booked', () => {
    expect(isManualBooked({ column: 'booked', reason: 'Booked: PM job in Vantage for 25 Nov' })).toBe(false);
    expect(isManualBooked({ column: 'to_plan', reason: 'Booked visit not seen' })).toBe(false);
  });
});
