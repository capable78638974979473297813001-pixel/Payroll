export class ApiFail extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      // The server only accepts a signed-in browser's writes when this header is present: a forged cross-site form cannot send it.
      headers: { 'x-totali-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFail(0, 'offline', 'Can’t reach Totali. Check your connection and try again.');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a plain-text answer (a payment file) */ }
  if (!res.ok) {
    const e = json && json.error;
    throw new ApiFail(res.status, (e && e.code) || 'error', (e && e.message) || `Something went wrong (${res.status}).`, e && e.details);
  }
  return json === null ? text : json;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  put: (p, b = {}) => call('PUT', p, b),
  patch: (p, b = {}) => call('PATCH', p, b),
  del: (p) => call('DELETE', p),
  /** Fetch a plain-text file (a payment file) as a download. */
  async download(path, filename) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'x-totali-csrf': '1' } });
    if (!res.ok) throw new ApiFail(res.status, 'error', `Could not download (${res.status}).`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};
