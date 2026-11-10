import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { d1_databases: [database] } = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (database.database_id === '00000000-0000-0000-0000-000000000000') {
  console.error('请先创建 D1，并在 wrangler.jsonc 填写 database_id。');
  process.exit(1);
}

function wrangler(args) {
  const result = spawnSync('wrangler', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const migration = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
if (migration !== 0) process.exit(migration);

const token = process.env.PHRASEFOLIO_API_TOKEN;
if (!token) process.exit(wrangler(['deploy']));

const directory = mkdtempSync(join(tmpdir(), 'phrasefolio-secrets-'));
try {
  const file = join(directory, 'secrets.json');
  writeFileSync(file, JSON.stringify({ PHRASEFOLIO_API_TOKEN: token }), { mode: 0o600 });
  process.exitCode = wrangler(['deploy', '--secrets-file', file]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
