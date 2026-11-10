import { listEntries, readJSON, RequestError, saveEntry, setKnown } from './entries.js';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { ...headers, ...extraHeaders } });
}

async function authenticate(request, secret) {
  if (!secret) throw new RequestError(503, '访问令牌尚未配置');
  const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return false;
  const encoder = new TextEncoder();
  const hash = (value) => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [expected, actual] = await Promise.all([hash(secret), hash(token)]);
  return crypto.subtle.timingSafeEqual(expected, actual);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!await authenticate(request, env.PHRASEFOLIO_API_TOKEN)) {
        return json({ error: '请输入有效的访问令牌' }, 401, {
          'WWW-Authenticate': 'Bearer realm="Jam notebook"',
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
