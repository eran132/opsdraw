import { createRequire } from 'node:module';
import { run } from './cli';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

process.exitCode = await run(
  process.argv.slice(2),
  {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    cwd: process.cwd(),
  },
  version,
);
