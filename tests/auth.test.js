import { readFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_ISSUER, ACCESS_JWKS_URL, CANONICAL_HOST } from '../src/access.js';
import { deploymentConfigError } from '../scripts/deploy.mjs';

const AUD = 'ab'.repeat(32);
const OTHER_AUD = 'cd'.repeat(32);
const SERVICE_ID = `${'b'.repeat(32)}.access`;
const OTHER_SERVICE_ID = `${'c'.repeat(32)}.access`;
const BEARER = 'test-bearer-not-a-production-secret';
const WORKERS_DEV = 'phrasefolio.mazhenting44.workers.dev';
const PREVIEW_HOST = 'abc123-phrasefolio.mazhenting44.workers.dev';

const row = {
  id: 1,
  expression: 'follow through',
  expression_key: 'follow through',
  original_sentence: 'We need to follow through on the plan.',
  meaning_zh: '把事情做到底',
  usage_note: '',
  example: 'I will follow through.',
  source: '',
  added_date: '2026-11-10',
  interval_days: 1,
  next_review: '',
  ease: 2.5,
  review_count: 0,
  seen_count: 2,
  scene_zh: '跟进工作中的迁移计划。',
  known: 0,
  known_at: null,
};

const fetched = [];
const originalFetch = globalThis.fetch;
let publicJwk;
let privateKey;
let attackerPrivate;
let worker;

function jwksResponse(keys) {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installJwksFetch() {
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push(url);
    if (url !== ACCESS_JWKS_URL) return jwksResponse([{ ...publicJwk, kid: 'attacker-served' }]);
    return jwksResponse([publicJwk]);
  };
}

function createEnv(overrides = {}) {
  const calls = [];
  return {
    calls,
    ACCESS_AUD: AUD,
    ACCESS_SERVICE_CLIENT_ID: SERVICE_ID,
    DB: {
      prepare(sql) {
        const statement = {
          bind(...args) {
            statement.args = args;
            return statement;
          },
          async all() {
            calls.push({ sql });
            return { results: [] };
          },
          async first() {
            calls.push({ sql, args: statement.args });
            return row;
          },
        };
        return statement;
      },
    },
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        calls.push({ asset: path });
        return new Response(`asset ${path}`, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0' },
        });
      },
    },
    ...overrides,
  };
}

async function sign(claims = {}, { key = privateKey, kid = 'test-key', alg = 'RS256', typ = 'JWT' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    type: 'app',
    iss: ACCESS_ISSUER,
    aud: [AUD],
    iat: now,
    nbf: now,
    exp: now + 600,
    email: 'reader@example.com',
    sub: 'user-123',
    ...claims,
  };
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) delete payload[name];
  }
  const signingKey = alg === 'HS256' ? new TextEncoder().encode('not-the-access-key') : key;
  const header = { alg, kid };
  if (typ !== null) header.typ = typ;
  return new SignJWT(payload).setProtectedHeader(header).sign(signingKey);
}

function unsigned(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

async function send(path, { host = CANONICAL_HOST, headers = {}, method = 'GET', body, env } = {}) {
  return worker.fetch(new Request(`https://${host}${path}`, { method, headers, body }), env);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const attacker = await generateKeyPair('RS256', { extractable: true });
  attackerPrivate = attacker.privateKey;
  installJwksFetch();
  worker = (await import('../src/worker.js')).default;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('repository config matches the live binding', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

  it('keeps the existing D1 database and leaves Access off', () => {
    expect(config.d1_databases[0]).toMatchObject({
      binding: 'DB',
      database_name: 'phrasefolio',
      database_id: '57449379-e549-4d5f-ae36-07f0707c0a27',
    });
    expect(config.assets.run_worker_first).toBe(true);
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.vars).toEqual({
      ACCESS_AUD: '',
      ACCESS_SERVICE_CLIENT_ID: '',
    });
    expect(config.secrets).toBeUndefined();
    expect(deploymentConfigError(config)).toMatch(/拒绝部署/);
    expect(deploymentConfigError({
      ...config,
      vars: { ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_ID: SERVICE_ID },
    })).toBe('');
  });
});

describe('Access JWT validation', () => {
  let env;

  beforeEach(() => {
    env = createEnv();
  });

  it('accepts a human JWT and does not require or echo the bearer', async () => {
    const token = await sign();
    const response = await send('/api/entries', {
      env,
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Cf-Access-Authenticated-User-Email': 'someone-else@example.com',
        Authorization: 'Bearer wrong-bearer',
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ entries: [], total: 0, count: 0, sources: [] });
    expect(env.calls.map(({ sql }) => sql).join('\n')).toContain('seen_count DESC, added_date DESC, id DESC');
    const text = JSON.stringify(body);
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain(token);
    expect(text).not.toContain('reader@example.com');
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(fetched).toContain(ACCESS_JWKS_URL);
  });

  it.each(['JWT', null])('accepts the Access cookie with JOSE typ %s when the assertion header is absent', async (typ) => {
    const token = await sign({}, { typ });
    const response = await send('/api/entries', {
      env,
      headers: { Cookie: `theme=light; CF_Authorization=${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('does not fall back to a valid cookie when the assertion header is forged', async () => {
    const good = await sign();
    const forged = await sign({}, { key: attackerPrivate, kid: 'attacker' });
    const response = await send('/api/entries', {
      env,
      headers: {
        'Cf-Access-Jwt-Assertion': forged,
        Cookie: `CF_Authorization=${good}`,
      },
    });
    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
  });

  it.each([
    ['missing', async () => undefined],
    ['malformed', async () => 'not-a-jwt'],
    ['truncated', async () => 'a.b.c'],
    ['none algorithm', async () => unsigned({
      type: 'app', iss: ACCESS_ISSUER, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 60,
    })],
    ['HS256', () => sign({}, { alg: 'HS256', kid: 'test-key' })],
    ['forged key', () => sign({}, { key: attackerPrivate, kid: 'attacker' })],
    ['tampered', async () => `${await sign()}x`],
    ['wrong issuer', () => sign({ iss: 'https://evil.example' })],
    ['wrong audience', () => sign({ aud: [OTHER_AUD] })],
    ['wrong JOSE type', () => sign({}, { typ: 'application/other' })],
    ['missing expiry', () => sign({ exp: undefined })],
    ['expired', () => sign({ iat: Math.floor(Date.now() / 1000) - 120, nbf: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 30 })],
    ['not yet valid', () => sign({ nbf: Math.floor(Date.now() / 1000) + 3600, exp: Math.floor(Date.now() / 1000) + 7200 })],
    ['global session token', () => sign({ type: 'org' })],
    ['ambiguous identity', () => sign({ common_name: SERVICE_ID })],
  ])('rejects a %s token', async (_label, issue) => {
    const token = await issue();
    const headers = token ? { 'Cf-Access-Jwt-Assertion': token } : {};
    const response = await send('/api/entries', { env, headers });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('需要通过 Cloudflare Access 登录');
    expect(body.login).toContain(`${ACCESS_ISSUER}/cdn-cgi/access/login/${CANONICAL_HOST}`);
    expect(env.calls).toEqual([]);
    expect(fetched.every((url) => url === ACCESS_JWKS_URL)).toBe(true);
  });

  it('rejects an email header and bearer when no JWT is present', async () => {
    const response = await send('/api/entries', {
      env,
      headers: {
        Authorization: `Bearer ${BEARER}`,
        'Cf-Access-Authenticated-User-Email': 'reader@example.com',
        'X-Jwks-Url': 'https://evil.example/certs',
        'TEAM_DOMAIN': 'https://evil.example',
      },
    });
    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
    expect(fetched.every((url) => url === ACCESS_JWKS_URL)).toBe(true);
  });

  it('ignores issuer and JWKS settings supplied by the environment', async () => {
    const evil = 'https://evil.example';
    const token = await sign({ iss: evil }, { key: attackerPrivate, kid: 'attacker' });
    const response = await send('/api/entries', {
      env: createEnv({
        TEAM_DOMAIN: evil,
        ACCESS_JWKS_URL: `${evil}/jwks`,
        ACCESS_ISSUER: evil,
      }),
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(response.status).toBe(401);
    expect(fetched.every((url) => url === ACCESS_JWKS_URL)).toBe(true);
  });

  it('returns 503 instead of logging the user out when the JWKS cannot be fetched', async () => {
    vi.resetModules();
    const failingFetch = vi.fn(() => Promise.reject(new TypeError('network down')));
    globalThis.fetch = failingFetch;
    const isolated = (await import('../src/worker.js')).default;
    const token = await sign();
    const response = await isolated.fetch(new Request(`https://${CANONICAL_HOST}/api/entries`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }), createEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: '访问校验暂时不可用，请稍后重试' });
    expect(failingFetch).toHaveBeenCalled();
    installJwksFetch();
  });

  it('fails closed when Access is enabled without a valid audience', async () => {
    const token = await sign();
    for (const aud of ['', 'not-an-aud', 'https://evil.example/certs']) {
      const response = await send('/api/entries', {
        env: createEnv({ ACCESS_AUD: aud }),
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: '访问控制尚未正确配置' });
    }
  });
});

describe('human and machine scope', () => {
  let env;

  beforeEach(() => {
    env = createEnv();
  });

  async function serviceToken(claims = {}) {
    return sign({
      email: undefined,
      sub: '',
      nbf: undefined,
      common_name: SERVICE_ID,
      ...claims,
    });
  }

  it('lets a human read and mark notes without a bearer', async () => {
    const headers = { 'Cf-Access-Jwt-Assertion': await sign() };
    const listed = await send('/api/entries?sort=seen', { env, headers });
    expect(listed.status).toBe(200);
    const marked = await send('/api/entries/1/known', {
      env,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ known: true }),
    });
    expect(marked.status).toBe(200);
    expect((await marked.json()).expression).toBe('follow through');
  });

  it('keeps collection on the service JWT alone', async () => {
    const human = await send('/api/entries', {
      env,
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': await sign(),
        Authorization: `Bearer ${BEARER}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expression: 'follow through', scene_zh: '跟进工作中的迁移计划。' }),
    });
    expect(human.status).toBe(403);
    expect(env.calls).toEqual([]);

    env.calls.length = 0;
    const machine = await send('/api/entries', {
      env,
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': await serviceToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expression: 'follow through', scene_zh: '跟进工作中的迁移计划。' }),
    });
    expect(machine.status).toBe(200);
    expect(env.calls[0].sql).toContain('seen_count = entries.seen_count + 1');
    expect(env.calls[0].args).toContain('跟进工作中的迁移计划。');
    const text = JSON.stringify(await machine.json());
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain(SERVICE_ID);
  });

  it.each([
    ['no credentials', {}],
    ['bearer only', { Authorization: `Bearer ${BEARER}` }],
    ['service headers without a JWT', {
      'CF-Access-Client-Id': SERVICE_ID,
      'CF-Access-Client-Secret': 'not-a-real-secret',
    }],
    ['different service client', { jwt: true, client: OTHER_SERVICE_ID }],
  ])('rejects a machine request with %s', async (_label, options) => {
    const headers = { ...options };
    delete headers.jwt;
    delete headers.client;
    if (options.jwt) {
      headers['Cf-Access-Jwt-Assertion'] = await serviceToken({
        common_name: options.client ?? SERVICE_ID,
      });
    }
    const response = await send('/api/entries', {
      env,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: 'follow through' }),
    });
    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
  });

  it('fails closed when the service client id is not configured', async () => {
    const envWithoutService = createEnv({ ACCESS_SERVICE_CLIENT_ID: '' });
    const machine = await send('/api/entries', {
      env: envWithoutService,
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': await serviceToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expression: 'follow through' }),
    });
    expect(machine.status).toBe(503);
    const human = await send('/api/entries', {
      env: envWithoutService,
      headers: { 'Cf-Access-Jwt-Assertion': await sign() },
    });
    expect(human.status).toBe(503);
    expect(envWithoutService.calls).toEqual([]);
  });

  it('keeps invalid collection input on the existing API', async () => {
    const response = await send('/api/entries', {
      env,
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': await serviceToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expression: '   ' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expression 不能为空' });
  });
});

describe('alternate origins and rollout', () => {
  it('does not restore bearer authentication when ACCESS_ENABLED is false', async () => {
    const env = createEnv({ ACCESS_ENABLED: 'false' });
    const asset = await send('/', { env, host: WORKERS_DEV, headers: { Authorization: `Bearer ${BEARER}` } });
    expect(asset.status).toBe(401);
    expect(await asset.text()).not.toContain('asset');
    expect(env.calls).toEqual([]);
    const denied = await send('/api/entries', {
      env,
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toBeNull();
    expect(await denied.json()).toEqual({
      error: '需要通过 Cloudflare Access 登录',
      login: expect.stringContaining(`${ACCESS_ISSUER}/cdn-cgi/access/login/${CANONICAL_HOST}`),
    });
    const opened = await send('/api/entries?sort=seen', {
      env,
      headers: { 'Cf-Access-Jwt-Assertion': await sign() },
    });
    expect(opened.status).toBe(200);
  });

  it('blocks workers.dev, previews, and bearer-only requests after Access is enabled', async () => {
    const token = await sign();
    for (const host of [WORKERS_DEV, PREVIEW_HOST]) {
      const env = createEnv();
      const page = await send('/', {
        env,
        host,
        headers: { Accept: 'text/html', 'Cf-Access-Jwt-Assertion': token, Authorization: `Bearer ${BEARER}` },
      });
      expect(page.status).toBe(401);
      expect(await page.text()).not.toContain('asset');
      expect(env.calls).toEqual([]);
      const api = await send('/api/entries', {
        env,
        host,
        headers: { Authorization: `Bearer ${BEARER}` },
      });
      expect(api.status).toBe(401);
      expect(env.calls).toEqual([]);
    }
  });

  it('redirects an unauthenticated document and withholds assets', async () => {
    const env = createEnv();
    const response = await send('/?access_token=sekret', {
      env,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location'));
    expect(location.origin).toBe(ACCESS_ISSUER);
    expect(location.pathname).toBe(`/cdn-cgi/access/login/${CANONICAL_HOST}`);
    expect(location.searchParams.get('kid')).toBe(AUD);
    expect(location.searchParams.get('redirect_url')).toBe('/');
    expect(location.toString()).not.toContain('sekret');
    expect(await response.text()).toBe('');
    expect(env.calls).toEqual([]);
  });

  it('serves the app shell only after the human JWT is valid', async () => {
    const env = createEnv();
    const response = await send('/', {
      env,
      headers: { Accept: 'text/html', 'Cf-Access-Jwt-Assertion': await sign() },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset /');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('sends logout through Cloudflare Access without a JWT', async () => {
    const env = createEnv();
    const response = await send('/cdn-cgi/access/logout', {
      env,
      host: WORKERS_DEV,
      headers: { Accept: 'text/html' },
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location'));
    expect(location.origin + location.pathname).toBe(`${ACCESS_ISSUER}/cdn-cgi/access/logout`);
    expect(location.searchParams.get('returnTo')).toBe(`https://${CANONICAL_HOST}/`);
    expect(env.calls).toEqual([]);
  });

  it('reports Access mode without notes or the bearer', async () => {
    const env = createEnv();
    const response = await send('/api/session', {
      env,
      headers: { 'Cf-Access-Jwt-Assertion': await sign(), Authorization: `Bearer ${BEARER}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access: true,
      principal: 'human',
      logout: `https://${CANONICAL_HOST}/cdn-cgi/access/logout`,
    });
  });
});
