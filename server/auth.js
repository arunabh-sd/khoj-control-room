// Sign in with Google, for ShopDeck and Blitzscale accounts only. The page shows Google's button; Google hands it a
// signed ID token, which the server checks against Google's public keys (signature, audience = our client id, expiry,
// verified email) and the allowed Workspace domains. A good token gives a signed 30-day cookie (no session table).
// Allowed: ALLOWED_DOMAINS (Google Workspace domains) and ADMIN_EMAILS (who also sees the Usage tab).
// Without GOOGLE_CLIENT_ID the dashboard keeps the old behaviour: open, or DASHBOARD_PASSWORD (basic auth).
import crypto from 'node:crypto';

const COOKIE = 'khoj_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';

const list = (v) => String(v || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const googleClientId = (env = process.env) => String(env.GOOGLE_CLIENT_ID || '').trim();
export const loginOn = (env = process.env) => !!googleClientId(env);
export function envAccess(env = process.env) {
  return { admins: list(env.ADMIN_EMAILS), domains: list(env.ALLOWED_DOMAINS) };
}

// `hd` is Google's Workspace domain claim: it is only set for accounts managed by that Workspace, so a personal Google
// account registered with a company address doesn't get in.
export function decideAccess(email, hd, env = envAccess()) {
  const e = normEmail(email), domain = e.split('@')[1] || '';
  const admin = env.admins.includes(e);
  const workspace = !!hd && normEmail(hd) === domain;
  const allowed = workspace && (admin || env.domains.includes(domain));
  return { allowed, admin: allowed && admin };
}

// Google's signing keys, cached for as long as Google says (Cache-Control max-age).
let certs = null, certsUntil = 0;
async function googleKeys(fetchFn = fetch) {
  if (certs && Date.now() < certsUntil) return certs;
  const r = await fetchFn(GOOGLE_CERTS, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Google keys ${r.status}`);
  const maxAge = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  certs = (await r.json()).keys;
  certsUntil = Date.now() + maxAge * 1000;
  return certs;
}

// Checks a Google ID token. Returns its claims, or throws with the reason.
export async function verifyGoogleToken(token, { clientId = googleClientId(), keys = googleKeys, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('not a Google sign-in token');
  const [h, p, sig] = parts;
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); } catch { throw new Error('unreadable token'); }
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  const jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('token signed with an unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad token signature');
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error('token not issued by Google');
  if (claims.aud !== clientId) throw new Error('token is for a different app');
  if (!(claims.exp * 1000 > now - 60_000)) throw new Error('token expired');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified with Google');
  return claims;
}

export function createAuth(store, { keys } = {}) {
  let secret = null;

  // SESSION_SECRET if set; otherwise derived from the Metabase key (like the background pull token). Changing either
  // signs everyone out.
  async function getSecret() {
    if (secret) return secret;
    if (process.env.SESSION_SECRET) return (secret = process.env.SESSION_SECRET);
    if (process.env.METABASE_API_KEY) return (secret = sha(process.env.METABASE_API_KEY + ':khoj-session'));
    let s = store.getKV ? await store.getKV('auth-secret') : null;
    if (!s) { s = crypto.randomBytes(32).toString('hex'); if (store.setKV) await store.setKV('auth-secret', s); }
    return (secret = s);
  }

  async function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', await getSecret()).update(body).digest('base64url');
  }
  async function unsign(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(crypto.createHmac('sha256', await getSecret()).update(body).digest('base64url'));
    const got = Buffer.from(mac);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
  }
  const cookieOf = (req) => (String(req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '=')) || '').slice(COOKIE.length + 1);
  const cookie = (req, value, maxAge) => {
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  };

  function passwordOk(req) {
    const password = process.env.DASHBOARD_PASSWORD || '';
    if (!password) return true;
    const [scheme, encoded] = String(req.headers.get('authorization') || '').split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    return Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') === password;
  }

  // Who is asking. mode: 'google' (user set when signed in and still allowed), 'password' or 'open'. Access is checked
  // on every request, so taking a domain or admin out of the variables applies at once.
  async function identify(req) {
    if (!loginOn()) {
      const mode = process.env.DASHBOARD_PASSWORD ? 'password' : 'open';
      return { mode, ok: passwordOk(req), user: null };
    }
    const s = await unsign(cookieOf(req));
    if (!s?.e) return { mode: 'google', ok: false, user: null };
    const { allowed, admin } = decideAccess(s.e, s.hd);
    return allowed ? { mode: 'google', ok: true, user: { email: s.e, name: s.n || null, admin } } : { mode: 'google', ok: false, user: null, removed: true };
  }

  // The Google button's token → a session, or the reason it was refused (with the email, so refusals can be logged).
  async function signInWithGoogle(credential) {
    let claims;
    try { claims = await verifyGoogleToken(credential, keys ? { keys } : {}); } catch (e) { return { status: 401, error: 'Google sign-in failed: ' + e.message }; }
    const email = normEmail(claims.email);
    const { allowed, admin } = decideAccess(email, claims.hd);
    if (!allowed) {
      const domains = envAccess().domains.join(' or ') || 'an allowed domain';
      return { status: 403, email, error: `${email} can't open the control room. Sign in with your ${domains} Google account.` };
    }
    const now = Date.now();
    const user = { email, name: claims.name || null, admin };
    return { status: 200, ok: true, user, token: await sign({ e: email, hd: normEmail(claims.hd), n: claims.name || null, iat: now, exp: now + SESSION_DAYS * 86400_000 }) };
  }

  return {
    identify, signInWithGoogle,
    setCookie: (req, token) => cookie(req, token, SESSION_DAYS * 86400),
    clearCookie: (req) => cookie(req, '', 0)
  };
}
