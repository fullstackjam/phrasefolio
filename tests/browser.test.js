/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"url":"https://phrasefolio.fullstackjam.com/"}
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('public/index.html', 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '');
const TOKEN_KEY = 'jam-notebook-access';
const logoutUrl = 'https://phrasefolio.fullstackjam.com/cdn-cgi/access/logout';
const entries = {
  entries: [{
    id: 1,
    expression: 'follow through',
    seen_count: 2,
    known: false,
    scene_zh: '跟进工作中的迁移计划。',
    meaning_zh: '把事情做到底',
    usage_note: '',
    example: 'I will follow through.',
    original_sentence: 'We need to follow through on the plan.',
    source: '',
  }],
  total: 1,
  count: 1,
  sources: [],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function boot(handler, { token = '' } = {}) {
  vi.resetModules();
  window.happyDOM?.setURL('https://phrasefolio.fullstackjam.com/');
  document.open();
  document.write(html);
  document.close();
  sessionStorage.clear();
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  const assigned = [];
  vi.spyOn(location, 'assign').mockImplementation((url) => {
    assigned.push(String(url));
  });
  const fetchMock = vi.fn(async (input, init) => handler(String(input), init ?? {}));
  vi.stubGlobal('fetch', fetchMock);
  const app = await import('../public/app.js');
  await app.ready;
  return { assigned, fetchMock };
}

function requestUrl(input) {
  return String(input);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('human app in Access mode', () => {
  it('loads and reloads without a token prompt or bearer', async () => {
    const first = await boot(async (input, init) => {
      if (requestUrl(input).includes('/api/session')) {
        return jsonResponse({ access: true, principal: 'human', logout: logoutUrl });
      }
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.credentials).toBe('same-origin');
      return jsonResponse(entries);
    }, { token: 'leftover-bearer' });
    expect(document.getElementById('login').hidden).toBe(true);
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(document.getElementById('notebook').hidden).toBe(false);
    expect(document.getElementById('entries').textContent).toContain('follow through');
    expect(document.getElementById('sort').value).toBe('seen');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(first.assigned).toEqual([]);
    expect(first.fetchMock.mock.calls.some(([, init]) => init.headers?.Authorization)).toBe(false);

    const second = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) {
        return jsonResponse({ access: true, principal: 'human', logout: logoutUrl });
      }
      return jsonResponse(entries);
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.getElementById('login').hidden).toBe(true);
    expect(document.getElementById('notebook').hidden).toBe(false);
    expect(second.assigned).toEqual([]);
  });

  it('logs out through the Access logout URL and ignores an off-site logout URL', async () => {
    const allowed = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) return jsonResponse({ access: true, logout: logoutUrl });
      return jsonResponse(entries);
    });
    document.getElementById('lock').click();
    expect(allowed.assigned).toEqual([logoutUrl]);

    const hostile = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) {
        return jsonResponse({ access: true, logout: 'https://evil.example/cdn-cgi/access/logout' });
      }
      return jsonResponse(entries);
    });
    document.getElementById('lock').click();
    expect(hostile.assigned).toEqual([logoutUrl]);
  });

  it('keeps the page in place when entries fail with 503 or the network', async () => {
    const unavailable = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) return jsonResponse({ access: true, logout: logoutUrl });
      return jsonResponse({ error: '访问校验暂时不可用，请稍后重试' }, 503);
    }, { token: 'leftover-bearer' });
    expect(unavailable.assigned).toEqual([]);
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(document.getElementById('token').value).toBe('');
    expect(document.getElementById('login-error').hidden).toBe(false);
    expect(location.pathname).not.toBe('/cdn-cgi/access/logout');

    const offline = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) return jsonResponse({ access: true, logout: logoutUrl });
      throw new TypeError('Failed to fetch');
    }, { token: 'leftover-bearer' });
    expect(offline.assigned).toEqual([]);
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(location.pathname).not.toBe('/cdn-cgi/access/logout');
  });
});

describe('auth is not cleared by an outage', () => {
  it('keeps a stored token when the session request fails before Access mode is known', async () => {
    const offline = await boot(async () => {
      throw new TypeError('Failed to fetch');
    }, { token: 'stored-token' });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('stored-token');
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(offline.assigned).toEqual([]);

    const unavailable = await boot(async () => jsonResponse({ error: '访问校验暂时不可用，请稍后重试' }, 503), {
      token: 'stored-token',
    });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('stored-token');
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(unavailable.assigned).toEqual([]);
  });

  it('keeps the legacy token when the notebook cannot be read', async () => {
    const loaded = await boot(async (input) => {
      if (requestUrl(input).includes('/api/session')) return jsonResponse({ access: false });
      return jsonResponse({ error: '笔记暂时不可用，请稍后重试' }, 503);
    }, { token: 'stored-token' });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('stored-token');
    expect(document.getElementById('login-form').hidden).toBe(true);
    expect(loaded.assigned).toEqual([]);
    const entriesCall = loaded.fetchMock.mock.calls.find(([input]) => requestUrl(input).includes('/api/entries'));
    expect(entriesCall[1].headers.Authorization).toBe('Bearer stored-token');
  });

  it('still shows the token form when Access is off and no token is stored', async () => {
    const loaded = await boot(async () => jsonResponse({ access: false }));
    expect(document.getElementById('login').hidden).toBe(false);
    expect(document.getElementById('login-form').hidden).toBe(false);
    expect(document.getElementById('notebook').hidden).toBe(true);
    expect(loaded.assigned).toEqual([]);
  });

  it('follows an Access login redirect without offering the token form', async () => {
    const login = `${'https://fullstackjam.cloudflareaccess.com'}/cdn-cgi/access/login/phrasefolio.fullstackjam.com?kid=abc&redirect_url=%2F`;
    const loaded = await boot(async () => jsonResponse({ error: '需要通过 Cloudflare Access 登录', login }, 401));
    expect(loaded.assigned).toEqual([login]);
    expect(document.getElementById('login-form').hidden).toBe(true);
  });
});
