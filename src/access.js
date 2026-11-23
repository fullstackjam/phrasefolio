import { createRemoteJWKSet, jwtVerify } from 'jose';

// Pinned to this Zero Trust team. Request headers and Worker vars cannot
// replace the issuer or the JWKS URL. ctx.access is not used: the static
// assets router does not pass it through to this Worker.
export const ACCESS_ISSUER = 'https://fullstackjam.cloudflareaccess.com';
export const ACCESS_JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
export const CANONICAL_HOST = 'phrasefolio.fullstackjam.com';

const AUD_PATTERN = /^[a-f0-9]{64}$/i;
const SERVICE_CLIENT_PATTERN = /^[a-f0-9]{32}\.access$/;
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWK_INVALID',
]);

let pinnedKeys;

function pinnedKeySet() {
  pinnedKeys ??= createRemoteJWKSet(new URL(ACCESS_JWKS_URL));
  return pinnedKeys;
}

export function readAccessConfig(env) {
  const aud = String(env.ACCESS_AUD ?? '').trim().toLowerCase();
  const serviceClientId = String(env.ACCESS_SERVICE_CLIENT_ID ?? '').trim().toLowerCase();
  if (!AUD_PATTERN.test(aud) || !SERVICE_CLIENT_PATTERN.test(serviceClientId)) {
    return { misconfigured: true };
  }
  return { aud, serviceClientId };
}

function fixedTimeEqual(expected, actual) {
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  if (left.length !== right.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function sameValue(expected, actual) {
  if (!expected || !actual) return false;
  const encoder = new TextEncoder();
  const hash = (value) => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [left, right] = await Promise.all([hash(expected), hash(actual)]);
  return fixedTimeEqual(left, right);
}

function accessToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim().slice(0, 16384);
  const cookie = request.headers.get('Cookie');
  if (!cookie) return '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== 'CF_Authorization') continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()).slice(0, 16384);
    } catch {
      return '';
    }
  }
  return '';
}

export function accessLoginUrl(aud) {
  const login = new URL(`/cdn-cgi/access/login/${CANONICAL_HOST}`, ACCESS_ISSUER);
  login.search = new URLSearchParams({ kid: aud, redirect_url: '/' }).toString();
  return login.toString();
}

export function accessLogoutUrl() {
  const logout = new URL('/cdn-cgi/access/logout', ACCESS_ISSUER);
  logout.searchParams.set('returnTo', `https://${CANONICAL_HOST}/`);
  return logout.toString();
}

function documentNavigation(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (url.pathname.startsWith('/api/')) return false;
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

function deny(status, error, extra = {}) {
  return { mode: 'deny', status, error, ...extra };
}

function unauthenticated(request, url, aud) {
  if (aud && documentNavigation(request, url)) {
    return { mode: 'redirect', location: accessLoginUrl(aud) };
  }
  return deny(401, '需要通过 Cloudflare Access 登录', aud ? { login: accessLoginUrl(aud) } : {});
}

function classify(payload) {
  if (payload.type !== 'app') return null;
  const email = typeof payload.email === 'string' ? payload.email : '';
  const human = /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320;
  const clientId = typeof payload.common_name === 'string' ? payload.common_name.toLowerCase() : '';
  const service = SERVICE_CLIENT_PATTERN.test(clientId);
  const sub = payload.sub;
  const emptySubject = sub === '' || sub === undefined;
  if (service && !human && emptySubject) return { kind: 'service', clientId };
  if (human && typeof sub === 'string' && sub.length > 0 && !service) return { kind: 'human' };
  return null;
}

export async function authorize(request, env) {
  const config = readAccessConfig(env);
  const url = new URL(request.url);
  if (config.misconfigured) return deny(503, '访问控制尚未正确配置');
  if (url.pathname === '/cdn-cgi/access/logout') {
    return { mode: 'redirect', location: accessLogoutUrl() };
  }
  if (url.hostname !== CANONICAL_HOST) return deny(401, '需要通过 Cloudflare Access 登录');

  const token = accessToken(request);
  if (!token) return unauthenticated(request, url, config.aud);
  try {
    const { payload, protectedHeader } = await jwtVerify(token, pinnedKeySet(), {
      issuer: ACCESS_ISSUER,
      audience: config.aud,
      algorithms: ['RS256'],
      typ: 'JWT',
      clockTolerance: 5,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'type'],
    });
    if (protectedHeader.alg !== 'RS256') return unauthenticated(request, url, config.aud);
    const identity = classify(payload);
    if (!identity) return unauthenticated(request, url, config.aud);
    if (identity.kind === 'service' && !await sameValue(config.serviceClientId, identity.clientId)) {
      return deny(401, '机器身份凭证不完整');
    }
    return { mode: 'access', identity };
  } catch (error) {
    if (INVALID_TOKEN_CODES.has(error?.code)) return unauthenticated(request, url, config.aud);
    console.error({ event: 'access_jwks_unavailable', code: error?.code ?? error?.name });
    return deny(503, '访问校验暂时不可用，请稍后重试');
  }
}
