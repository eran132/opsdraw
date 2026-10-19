import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args';
import type { OptionsSpec } from '../src/args';

const SPEC: OptionsSpec = {
  output: { type: 'string', short: 'o' },
  recursive: { type: 'boolean', short: 'r' },
  direction: { type: 'string', choices: ['right', 'down'] },
  check: { type: 'boolean' },
};

describe('parseArgs', () => {
  it('separates positionals from options', () => {
    expect(parseArgs(['infra', '-o', 'out.mmd', 'more', '--check', '-r'], SPEC)).toEqual({
      positionals: ['infra', 'more'],
      options: { output: 'out.mmd', check: true, recursive: true },
    });
  });

  it('accepts --name=value, -ovalue and the -- terminator', () => {
    const r = parseArgs(['--output=a.mmd', '--direction=down', '--', '--check', '-x'], SPEC);
    expect(r.options).toEqual({ output: 'a.mmd', direction: 'down' });
    expect(r.positionals).toEqual(['--check', '-x']);
    expect(parseArgs(['-ob.mmd'], SPEC).options.output).toBe('b.mmd');
    expect(parseArgs(['--check=false'], SPEC).options.check).toBe(false);
  });

  it('rejects unknown options, missing values and bad choices', () => {
    expect(() => parseArgs(['--nope'], SPEC)).toThrow(UsageError);
    expect(() => parseArgs(['-z'], SPEC)).toThrow(/Unknown option -z/);
    expect(() => parseArgs(['-o'], SPEC)).toThrow(/needs a value/);
    expect(() => parseArgs(['-o', '--check'], SPEC)).toThrow(/needs a value/);
    expect(() => parseArgs(['--direction', 'up'], SPEC)).toThrow(/right, down/);
    expect(() => parseArgs(['--check=yes'], SPEC)).toThrow(/does not take a value/);
  });
});
