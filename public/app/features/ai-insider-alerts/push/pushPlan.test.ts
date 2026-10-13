import type { Decision } from '../types';

import { parseTokens, planPush, renderText, templateFor } from './pushPlan';

const TOKEN_A = 'fA1b2c3d4e5f:APA91b' + 'a'.repeat(120);
const TOKEN_B = 'gB1b2c3d4e5f:APA91b' + 'b'.repeat(120);

function decision(patch: Partial<Decision>): Decision {
  return {
    kind: 'down',
    at: 1000,
    userId: 'ACC1',
    pid: '111',
    provider: 'TVALB',
    cid: '42',
    title: 'Sport 1',
    incidentId: 'inc-1',
    reason: '',
    platform: 'tvos',
    ...patch,
  };
}

describe('parseTokens', () => {
  it('reads account and tokens per line, in any separator, merging repeats', () => {
    const parsed = parseTokens(
      [
        '# comment',
        'account,token',
        `acc1 ${TOKEN_A}`,
        `"ACC1";"${TOKEN_B}"`,
        `ACC2\t${TOKEN_A}`,
        '',
        'ACC3 short',
      ].join('\n')
    );
    expect(parsed.byAccount.get('ACC1')).toEqual([TOKEN_A, TOKEN_B]);
    expect(parsed.byAccount.get('ACC2')).toEqual([TOKEN_A]);
    expect(parsed.tokens).toBe(3);
    // The header and the line with a short token.
    expect(parsed.skipped).toBe(2);
  });
});

describe('templateFor', () => {
  it('maps message types, channel vs provider-wide', () => {
    expect(templateFor(decision({}))).toBe('channel_down');
    expect(templateFor(decision({ kind: 'in_app' }))).toBe('channel_down');
    expect(templateFor(decision({ kind: 'suppressed', cid: '', incidentId: 'prov-1' }))).toBe('service_down');
    expect(templateFor(decision({ kind: 'back' }))).toBe('channel_back');
    expect(templateFor(decision({ kind: 'back', cid: '', incidentId: 'prov-1' }))).toBe('service_back');
    expect(templateFor(decision({ kind: 'unstable' }))).toBe('unstable');
    expect(templateFor(decision({ kind: 'apology' }))).toBe('apology');
    expect(templateFor(decision({ kind: 'diagnosis', cid: '', incidentId: undefined }))).toBe('diagnosis');
  });
});

describe('planPush', () => {
  it('sends one push per account (latest decision) to all its tokens; counts accounts without tokens', () => {
    const tokens = new Map([
      ['ACC1', [TOKEN_A, TOKEN_B]],
      ['ACC2', [TOKEN_A]],
    ]);
    const plan = planPush(
      [
        decision({ at: 1000 }),
        decision({ at: 2000, kind: 'back' }),
        decision({ userId: 'acc2', at: 1500 }),
        decision({ userId: 'ACC9' }),
      ],
      tokens
    );
    expect(plan.accounts).toBe(3);
    expect(plan.withoutToken).toBe(1);
    expect(plan.groups.map((g) => g.template)).toEqual(['channel_down', 'channel_back']);
    expect(plan.groups[1].recipients[0].tokens).toEqual([TOKEN_A, TOKEN_B]);
  });
});

describe('renderText', () => {
  it('fills channel and provider', () => {
    expect(renderText('{channel} on {provider}', decision({}))).toBe('Sport 1 on TVALB');
    expect(renderText('{channel}', decision({ cid: '', title: '' }))).toBe('All channels');
  });
});
