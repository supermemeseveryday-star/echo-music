// Cloudflare R2 through its S3 compatible API. The browser never sees the keys:
// it gets short-lived signed links for exactly the objects it may read or write.
import { AwsClient } from 'aws4fetch';

const env = process.env;
export const r2Configured = () => !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);

export const MUSIC_PREFIX = 'music/';
export const STATE_KEY = 'echo/data.json';
export const AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i;

let client;
const aws = () => (client ||= new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }));
// R2_ENDPOINT only for local testing against an S3 compatible server
const base = () => `${env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`}/${encodeURIComponent(env.R2_BUCKET)}`;
const objectUrl = (key) => `${base()}/${key.split('/').map(encodeURIComponent).join('/')}`;

// keys the app is allowed to touch: songs under music/ and the one state file
export function validKey(key, { write = false } = {}) {
  if (typeof key !== 'string' || !key || key.length > 900 || key.includes('\0') || key.includes('..') || key.includes('//')) return false;
  if (key === STATE_KEY) return true;
  return key.startsWith(MUSIC_PREFIX) && key.length > MUSIC_PREFIX.length && (!write || AUDIO.test(key));
}

export async function presign(method, key, seconds) {
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(seconds));
  const signed = await aws().sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// every object under a prefix: [{ key, size, lastModified, etag }]
export async function listObjects(prefix) {
  const out = [];
  let token = '';
  do {
    const url = new URL(base());
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const r = await aws().fetch(url);
    const xml = await r.text();
    if (!r.ok) throw new Error(`R2 list ${r.status}: ${tag(xml, 'Code')[0] || ''}`);
    for (const c of tag(xml, 'Contents')) {
      out.push({
        key: unxml(tag(c, 'Key')[0] || ''),
        size: Number(tag(c, 'Size')[0]) || 0,
        lastModified: tag(c, 'LastModified')[0] || null,
        etag: unxml(tag(c, 'ETag')[0] || '').replace(/"/g, ''),
      });
    }
    token = tag(xml, 'IsTruncated')[0] === 'true' ? unxml(tag(xml, 'NextContinuationToken')[0] || '') : '';
  } while (token);
  return out;
}

// server side upload of a stream (used by the Blob migration)
export async function putStream(key, body, { size, type }) {
  const url = await presign('PUT', key, 900);
  const r = await fetch(url, { method: 'PUT', body, duplex: 'half', headers: { 'Content-Type': type || 'application/octet-stream', 'Content-Length': String(size) } });
  if (!r.ok) throw new Error(`R2 put ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
