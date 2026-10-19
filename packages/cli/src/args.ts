/** A tiny argv parser: long/short options, `--name=value`, `--` terminator, choices. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface OptionSpec {
  type: 'boolean' | 'string';
  /** Single-letter alias, e.g. `o` for `-o`. */
  short?: string;
  /** Allowed values for string options. */
  choices?: readonly string[];
}

export type OptionsSpec = Record<string, OptionSpec>;

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean | undefined>;
}

export function parseArgs(argv: readonly string[], spec: OptionsSpec): ParsedArgs {
  const positionals: string[] = [];
  const options: ParsedArgs['options'] = {};
  const byShort = new Map(
    Object.entries(spec)
      .filter(([, s]) => s.short)
      .map(([name, s]) => [s.short!, name]),
  );

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) inline = arg.slice(eq + 1);
      if (!spec[name]) throw new UsageError(`Unknown option --${name}`);
    } else if (arg.startsWith('-') && arg.length > 1) {
      const letter = arg.slice(1, 2);
      name = byShort.get(letter);
      if (!name) throw new UsageError(`Unknown option -${letter}`);
      if (arg.length > 2) inline = arg.slice(2).replace(/^=/, '');
    } else {
      positionals.push(arg);
      continue;
    }

    const s = spec[name]!;
    if (s.type === 'boolean') {
      if (inline !== undefined) {
        if (!/^(true|false)$/.test(inline))
          throw new UsageError(`Option --${name} does not take a value`);
        options[name] = inline === 'true';
      } else {
        options[name] = true;
      }
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const nextArg = argv[i + 1];
      if (nextArg === undefined || (nextArg.startsWith('-') && nextArg !== '-'))
        throw new UsageError(`Option --${name} needs a value`);
      value = nextArg;
      i++;
    }
    if (s.choices && !s.choices.includes(value))
      throw new UsageError(`Option --${name} must be one of: ${s.choices.join(', ')}`);
    options[name] = value;
  }
  return { positionals, options };
}
