// One-time copy of the songs in the old private Vercel Blob store into R2 (music/<same path>).
// Each call copies for ~45 seconds and reports what is left; the settings page calls it until done.
// Blob files are not deleted.
import { list, get } from '@vercel/blob';
import { requireUser, json } from '../lib/session.js';
import { r2Configured, listObjects, putStream, MUSIC_PREFIX, AUDIO } from '../lib/r2.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!requireUser(req, res)) return;
  if (!r2Configured()) return json(res, 500, { error: 'r2_not_configured' });
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return json(res, 200, { done: true, total: 0, copied: 0, remaining: 0, noBlob: true });
  const started = Date.now();
  try {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ access: 'private', cursor, limit: 1000 });
      blobs.push(...page.blobs.filter((b) => AUDIO.test(b.pathname)));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const inR2 = new Map((await listObjects(MUSIC_PREFIX)).map((o) => [o.key, o.size]));
    const todo = blobs.filter((b) => inR2.get(MUSIC_PREFIX + b.pathname) !== b.size);
    let copied = 0;
    const failed = [];
    for (const b of todo) {
      if (Date.now() - started > 45e3) break;
      try {
        const r = await get(b.pathname, { access: 'private' });
        if (!r?.stream) throw new Error('empty');
        await putStream(MUSIC_PREFIX + b.pathname, r.stream, { size: b.size, type: r.blob.contentType });
        copied++;
      } catch (e) {
        console.error('migrate failed', b.pathname, e);
        failed.push(b.pathname);
      }
    }
    const remaining = todo.length - copied - failed.length;
    json(res, 200, { done: remaining === 0, total: blobs.length, copied, failed, remaining });
  } catch (e) {
    console.error('migrate failed', e);
    json(res, 502, { error: 'migrate_failed', detail: String(e.message || e).slice(0, 200) });
  }
}
