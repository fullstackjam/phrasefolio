import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function deploymentConfigError(config) {
  const databaseId = config.d1_databases?.[0]?.database_id ?? '';
  if (databaseId !== '57449379-e549-4d5f-ae36-07f0707c0a27') {
    return '拒绝部署：D1 必须保持 database_id 57449379-e549-4d5f-ae36-07f0707c0a27。';
  }
  const aud = String(config.vars?.ACCESS_AUD ?? '').trim();
  const serviceClientId = String(config.vars?.ACCESS_SERVICE_CLIENT_ID ?? '').trim();
  if (!/^[a-f0-9]{64}$/i.test(aud) || !/^[a-f0-9]{32}\.access$/i.test(serviceClientId)) {
    return '拒绝部署：ACCESS_AUD 与 ACCESS_SERVICE_CLIENT_ID 都要先写好。缺任何一项都会让线上笔记和收录失败。';
  }
  return '';
}

function wrangler(args) {
  const result = spawnSync('wrangler', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const configError = deploymentConfigError(config);
  if (configError) {
    console.error(configError);
    process.exit(1);
  }
  const migration = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (migration !== 0) process.exit(migration);
  process.exit(wrangler(['deploy']));
}
