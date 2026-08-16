/**
 * Shared console helpers. Everything user- or API-supplied that lands in innerHTML
 * goes through esc() — app names, goals, and URLs are typed by whoever registered
 * the target.
 */

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export async function sendJson(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? res.statusText);
    err.detail = data.detail ?? null;
    throw err;
  }
  return data;
}

export const postJson = (url, body) => sendJson('POST', url, body);
export const putJson = (url, body) => sendJson('PUT', url, body);
export const deleteJson = (url) => sendJson('DELETE', url);

/** "member_id=10001 branch=riverside" → { member_id: '10001', branch: 'riverside' } */
export function parseParams(text) {
  const params = {};
  for (const pair of String(text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}
