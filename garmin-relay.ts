// Supabase Edge Function "garmin": a read-only relay between the Exercise Tool and the Garmin Connect Personal API.
// The Garmin key is read from this project's secrets. It is never in the web page and is never sent to the browser.
// Secrets to add (Supabase > Edge Functions > Secrets):
//   GARMIN_API_KEY      the personal key from Garmin Connect
//   GARMIN_OWNER_EMAIL  the email you sign in to the Exercise Tool with: nobody else may use the relay
// Turn OFF "Verify JWT with legacy secret" for this function: it checks the signed-in user itself.

const GARMIN = 'https://personal.connectapi.garmin.com';
const ORIGINS = ['https://mkirsten583.github.io'];
const D = '\\d{4}-\\d{2}-\\d{2}';
const DATE = new RegExp(`^${D}$`);
const NUM = /^\d{1,4}$/;
// Only these Garmin addresses can be read, each with only these settings.
const ALLOWED = [
  [/^\/usersummary-service\/v2\/dailysummaries$/, { startDate: DATE, endDate: DATE }],
  [/^\/sleep-service\/sleep\/dailySleepSummariesByDate$/, { startDate: DATE, endDate: DATE }],
  [new RegExp(`^/hrv-service/hrv/daily/${D}/${D}$`), {}],
  [new RegExp(`^/weight-service/weight/range/${D}/${D}$`), { includeAll: /^(true|false)$/ }],
  [/^\/activitylist-service\/activities\/search\/activities$/, { start: NUM, limit: NUM, startDate: DATE, endDate: DATE }],
  [/^\/download-service\/files\/activity\/\d{1,20}$/, {}],
];

let token = null, expires = 0;   // kept only while this copy of the function stays awake

const headers = (req) => {
  const o = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
};
const reply = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers(req), 'Content-Type': 'application/json' } });
class Problem extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function checkOwner(req) {
  const owner = (Deno.env.get('GARMIN_OWNER_EMAIL') || '').trim().toLowerCase();
  if (!owner) throw new Problem(500, 'setup', 'Add the GARMIN_OWNER_EMAIL secret in Supabase.');
  const auth = req.headers.get('authorization') || '';
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const r = await fetch(Deno.env.get('SUPABASE_URL') + '/auth/v1/user', { headers: { Authorization: auth, apikey } });
  if (!r.ok) throw new Problem(401, 'signin', 'Sign in to the Exercise Tool again.');
  const user = await r.json();
  if ((user.email || '').toLowerCase() !== owner) throw new Problem(403, 'owner', 'This relay only works for its owner. Check the GARMIN_OWNER_EMAIL secret.');
}

async function getToken() {
  if (token && Date.now() < expires) return token;
  const key = (Deno.env.get('GARMIN_API_KEY') || '').trim();
  if (!key) throw new Problem(500, 'setup', 'Add the GARMIN_API_KEY secret in Supabase.');
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Problem(500, 'key', 'The GARMIN_API_KEY secret has spaces or line breaks in it. Paste the key again.');
  const r = await fetch(GARMIN + '/personalapitoken-service/personal-api/personal-api-key/token',
    { method: 'POST', headers: { Authorization: 'ApiKey ' + key, Accept: '*/*' } });
  const text = (await r.text()).trim();
  if (r.status === 401 || r.status === 403) throw new Problem(502, 'key', 'Garmin refused the key: it is wrong, expired or revoked. Create a new key and replace the GARMIN_API_KEY secret.');
  if (r.status === 429) throw new Problem(429, 'busy', 'Garmin asked for a pause. Try again later.');
  if (!r.ok || !text) throw new Problem(502, 'garmin', `Garmin did not give access (HTTP ${r.status}). Try again later.`);
  let value = text.replace(/^"|"$/g, ''), seconds = 0;
  if (text.startsWith('{')) {
    let j; try { j = JSON.parse(text); } catch { throw new Problem(502, 'garmin', 'Garmin sent an access reply that could not be read.'); }
    value = j.access_token || j.accessToken || j.token || '';
    seconds = Number(j.expires_in || j.expiresIn) || 0;
  }
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Problem(502, 'garmin', 'Garmin sent no usable access token.');
  token = value;
  expires = Date.now() + (seconds > 120 ? seconds - 60 : 23 * 3600) * 1000;
  return token;
}

async function garminGet(path, query) {
  const url = GARMIN + path + (Object.keys(query).length ? '?' + new URLSearchParams(query) : '');
  const send = async (accept) => fetch(url, { headers: { Authorization: 'Bearer ' + await getToken(), Accept: accept } });
  let accept = path.startsWith('/download-service/') ? '*/*' : 'application/json';
  let r = await send(accept);
  if (r.status === 401) { token = null; r = await send(accept); }
  if (r.status === 406) r = await send('*/*');
  return r;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  try {
    if (req.method !== 'POST') throw new Problem(405, 'request', 'Not allowed.');
    await checkOwner(req);
    let body; try { body = await req.json(); } catch { throw new Problem(400, 'request', 'Not understood.'); }
    const path = String(body?.path || '');
    if (path === 'ping') { await getToken(); return reply(req, 200, { ok: true }); }
    const rule = ALLOWED.find(([re]) => re.test(path));
    if (!rule) throw new Problem(400, 'request', 'That Garmin address is not allowed.');
    const query = {};
    for (const [k, v] of Object.entries(body.query || {})) {
      if (!Object.hasOwn(rule[1], k) || !rule[1][k].test(String(v))) throw new Problem(400, 'request', 'That setting is not allowed: ' + k.slice(0, 20));
      query[k] = String(v);
    }
    const r = await garminGet(path, query);
    if (r.status === 204) return new Response(null, { status: 204, headers: headers(req) });
    if (r.status === 429) throw new Problem(429, 'busy', 'Garmin asked for a pause. Try again later.');
    if (!r.ok) throw new Problem(502, 'garmin', `Garmin answered HTTP ${r.status}.`);
    return new Response(await r.arrayBuffer(), { status: 200, headers: { ...headers(req), 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' } });
  } catch (e) {
    if (e instanceof Problem) return reply(req, e.status, { code: e.code, error: e.message });
    console.error(e.message);
    return reply(req, 502, { code: 'garmin', error: 'The relay could not reach Garmin. Try again later.' });
  }
});
