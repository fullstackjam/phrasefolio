import { authorize, CANONICAL_HOST, legacyBearer } from './access.js';
import { listEntries, readJSON, RequestError, saveEntry, setKnown } from './entries.js';

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { ...headers, ...extraHeaders } });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { ...headers, Location: location } });
}

function denied(decision) {
  const body = { error: decision.error };
  if (decision.login) body.login = decision.login;
  const extra = decision.challenge ? { 'WWW-Authenticate': 'Bearer realm="Jam notebook"' } : {};
  return json(body, decision.status, extra);
}

async function serveAsset(request, env, accessMode) {
  const response = await env.ASSETS.fetch(request);
  if (!accessMode) return response;
  const copy = new Headers(response.headers);
  const path = new URL(request.url).pathname;
  if (path === '/' || path.endsWith('.html')) {
    copy.set('Cache-Control', 'private, no-store');
    copy.set('CDN-Cache-Control', 'no-store');
  }
  copy.set('Referrer-Policy', 'no-referrer');
  copy.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: copy });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const decision = await authorize(request, env);
      if (decision.mode === 'redirect') return redirect(decision.location);
      if (decision.mode === 'deny') return denied(decision);

      if (!url.pathname.startsWith('/api/')) return serveAsset(request, env, decision.mode === 'access');

      if (decision.mode === 'legacy') {
        if (url.pathname === '/api/session' && request.method === 'GET') return json({ access: false });
        const rejected = await legacyBearer(request, env);
        if (rejected) return denied(rejected);
      } else if (url.pathname === '/api/entries' && request.method === 'POST' && decision.identity.kind !== 'service') {
        return json({ error: '收集接口仅接受已登记的机器身份' }, 403);
      } else if (url.pathname === '/api/session') {
        if (request.method !== 'GET') return json({ error: '请求方法无效' }, 405, { Allow: 'GET' });
        return json({
          access: true,
          principal: decision.identity.kind,
          logout: `https://${CANONICAL_HOST}/cdn-cgi/access/logout`,
        });
      }

      if (url.pathname === '/api/entries') {
        if (request.method === 'GET') return json(await listEntries(env.DB, url.searchParams));
        if (request.method === 'POST') return json(await saveEntry(env.DB, await readJSON(request)));
        return json({ error: '请求方法无效' }, 405, { Allow: 'GET, POST' });
      }
      const match = url.pathname.match(/^\/api\/entries\/(\d+)\/known$/);
      if (match) {
        if (request.method !== 'POST') return json({ error: '请求方法无效' }, 405, { Allow: 'POST' });
        const { known = true } = await readJSON(request);
        return json(await setKnown(env.DB, Number(match[1]), known));
      }
      return json({ error: '接口不存在' }, 404);
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      console.error({ event: 'notebook_request_failed', error: error.name });
      return json({ error: '笔记暂时不可用，请稍后重试' }, 500);
    }
  },
};
