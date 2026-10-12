import { csvCell, decisionsToCsv } from './format';
import type { Decision } from './types';

describe('csvCell', () => {
  it('leaves plain values alone and quotes separators', () => {
    expect(csvCell('Sport 1')).toBe('Sport 1');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('turns anything a spreadsheet would run as a formula into text', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-103')).toBe("'-103");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
    // Only the first character matters.
    expect(csvCell('a=1')).toBe('a=1');
  });

  it('is used for every cell of the decision log', () => {
    const decision: Decision = {
      kind: 'apology',
      at: 0,
      userId: '=cmd',
      pid: '222',
      provider: '-provider',
      cid: '1',
      title: 'News, 24',
      reason: 'r',
      platform: 'iOS',
    };
    const [, line] = decisionsToCsv([decision]).split('\n');
    expect(line).toBe(`1970-01-01T00:00:00.000Z,apology,'=cmd,222,'-provider,1,"News, 24",iOS,,r`);
  });
});
