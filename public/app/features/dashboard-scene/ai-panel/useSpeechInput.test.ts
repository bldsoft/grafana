import { joinDictation } from './useSpeechInput';

describe('joinDictation', () => {
  it('fills an empty composer with the transcript', () => {
    expect(joinDictation('', ' top channels yesterday ')).toBe('top channels yesterday');
  });

  it('appends to typed text with a single space', () => {
    expect(joinDictation('Show', 'top channels')).toBe('Show top channels');
    expect(joinDictation('Show ', 'top channels')).toBe('Show top channels');
  });

  it('keeps the typed text while nothing was recognized yet', () => {
    expect(joinDictation('Show', '  ')).toBe('Show');
  });
});
