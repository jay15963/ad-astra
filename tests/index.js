// Lets `node --test tests/` work on Windows/Node 24 (the directory is resolved as a module):
// imports every *.test.mjs in this folder so the runner sees all tests.
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(`${dir}/${f}`).href);
}
