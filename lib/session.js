// Login session: an encrypted cookie proving the password was entered. Nothing is stored server side.
import crypto from 'node:crypto';

const SESSION_COOKIE = 'echo_sess';
const SESSION_DAYS = 400;

const key = () => crypto.createHash('sha256').update(process.env.SESSION_SECRET || '').digest();

export function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
export function unseal(token) {
  try {
    const b = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

export function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
}
export function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
export function setCookie(res, req, name, value, maxAge) {
  const secure = origin(req).startsWith('https') ? '; Secure' : '';
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`]);
}
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export function checkEnv(res) {
  const missing = ['APP_PASSWORD', 'SESSION_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) { json(res, 500, { error: 'not_configured', missing }); return false; }
  return true;
}

// sessions carry a fingerprint of the password, so changing APP_PASSWORD signs every device out
const passwordTag = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(process.env.APP_PASSWORD || '').digest('base64url').slice(0, 16);
export function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(process.env.APP_PASSWORD || '').digest();
  return !!process.env.APP_PASSWORD && crypto.timingSafeEqual(a, b);
}
export function startSession(res, req) {
  setCookie(res, req, SESSION_COOKIE, seal(JSON.stringify({ pw: passwordTag(), at: Date.now() })), 60 * 60 * 24 * SESSION_DAYS);
}
export function endSession(res, req) { setCookie(res, req, SESSION_COOKIE, '', 0); }
export function signedIn(req) {
  try { return JSON.parse(unseal(cookies(req)[SESSION_COOKIE] || '') || 'null')?.pw === passwordTag(); }
  catch { return false; }
}
// for API routes: true when signed in, otherwise a 401 is already sent
export function requireUser(req, res) {
  if (signedIn(req)) return true;
  json(res, 401, { error: 'signed_out' });
  return false;
}
export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error('too_large'); }
  return raw ? JSON.parse(raw) : {};
}
