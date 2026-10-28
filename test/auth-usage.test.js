import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApi } from '../server/app.js';
import { createStore } from '../server/store.js';
import { decideAccess, verifyGoogleToken } from '../server/auth.js';
import { summarise } from '../server/usage.js';

const BASE = 'https://khoj.example';
const CLIENT = 'test-client.apps.googleusercontent.com';
// A stand-in for Google's signing key: tokens are built and signed exactly as Google's are.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function googleToken(email, extra = {}, key = privateKey) {
  const claims = { iss: 'https://accounts.google.com', aud: CLIENT, email, email_verified: true, hd: email.split('@')[1], name: 'Test', exp: Math.floor(Date.now() / 1000) + 3600, ...extra };
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), body = b64(claims);
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

let api;
beforeEach(async () => {
  for (const k of ['DASHBOARD_PASSWORD']) delete process.env[k];
  Object.assign(process.env, { GOOGLE_CLIENT_ID: CLIENT, ALLOWED_DOMAINS: 'shopdeck.com, blitzscale.co', ADMIN_EMAILS: 'arunabh.mishra@blitzscale.co,piyush.sinhal@blitzscale.co', SESSION_SECRET: 'test-secret' });
  const store = createStore();
  await store.init();
  api = createApi(store, { googleKeys: KEYS });
});
const call = (path, { method = 'GET', body, cookie } = {}) => api.handle(new Request(BASE + path, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
}));
const google = (credential) => call('/api/auth/google', { method: 'POST', body: { credential } });
async function signIn(email, extra) {
  const r = await google(googleToken(email, extra));
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get('set-cookie').split(';')[0];
}

test('access: only Workspace accounts on the allowed domains; admins by email', () => {
  const env = { admins: ['arunabh.mishra@blitzscale.co'], domains: ['shopdeck.com', 'blitzscale.co'] };
  assert.deepEqual(decideAccess('Arunabh.Mishra@blitzscale.co', 'blitzscale.co', env), { allowed: true, admin: true });
  assert.deepEqual(decideAccess('ops@shopdeck.com', 'shopdeck.com', env), { allowed: true, admin: false });
  assert.deepEqual(decideAccess('someone@gmail.com', undefined, env), { allowed: false, admin: false });
  // A personal Google account made with a company address has no hd claim.
  assert.deepEqual(decideAccess('ops@shopdeck.com', undefined, env), { allowed: false, admin: false });
  assert.deepEqual(decideAccess('ops@shopdeck.com', 'other.com', env), { allowed: false, admin: false });
});

test('Google token checks: signature, audience, issuer, expiry, verified email', async () => {
  const opts = { clientId: CLIENT, keys: KEYS };
  assert.equal((await verifyGoogleToken(googleToken('a@shopdeck.com'), opts)).email, 'a@shopdeck.com');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleToken(googleToken('a@shopdeck.com', {}, other), opts), /signature/);
  await assert.rejects(verifyGoogleToken(googleToken('a@shopdeck.com', { aud: 'someone-else' }), opts), /different app/);
  await assert.rejects(verifyGoogleToken(googleToken('a@shopdeck.com', { iss: 'evil.com' }), opts), /not issued by Google/);
  await assert.rejects(verifyGoogleToken(googleToken('a@shopdeck.com', { exp: Math.floor(Date.now() / 1000) - 600 }), opts), /expired/);
  await assert.rejects(verifyGoogleToken(googleToken('a@shopdeck.com', { email_verified: false }), opts), /not verified/);
  // A tampered body (email swapped) breaks the signature.
  const [h, , sig] = googleToken('a@gmail.com', { hd: undefined }).split('.');
  await assert.rejects(verifyGoogleToken(`${h}.${b64({ iss: 'accounts.google.com', aud: CLIENT, email: 'x@shopdeck.com', hd: 'shopdeck.com', email_verified: true, exp: 9e9 })}.${sig}`, opts), /signature/);
});

test('sign-in: API closed until Google sign-in; cookie is HttpOnly, Secure, SameSite', async () => {
  const me = await (await call('/api/auth/me')).json();
  assert.equal(me.mode, 'google'); assert.equal(me.user, null); assert.equal(me.googleClientId, CLIENT);
  assert.deepEqual(me.domains, ['shopdeck.com', 'blitzscale.co']);
  assert.equal((await call('/api/sources')).status, 401);
  const r = await google(googleToken('ops@shopdeck.com'));
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/);
  const cookie = c.split(';')[0];
  assert.equal((await call('/api/sources', { cookie })).status, 200);
  assert.deepEqual((await (await call('/api/auth/me', { cookie })).json()).user, { email: 'ops@shopdeck.com', name: 'Test', admin: false });
  const forged = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await call('/api/sources', { cookie: forged })).status, 401);
});

test('outside domains are refused, get no cookie, and show up as blocked sign-ins', async () => {
  const r = await google(googleToken('someone@gmail.com', { hd: undefined }));
  assert.equal(r.status, 403); assert.equal(r.headers.get('set-cookie'), null);
  assert.match((await r.json()).error, /shopdeck\.com or blitzscale\.co/);
  await google(googleToken('someone@gmail.com', { hd: undefined }));
  assert.equal((await google('garbage')).status, 401);
  const admin = await signIn('arunabh.mishra@blitzscale.co');
  const U = await (await call('/api/usage?days=7', { cookie: admin })).json();
  assert.deepEqual(U.denied.map((d) => [d.email, d.tries]), [['someone@gmail.com', 2]]);
  assert.ok(!U.users.some((u) => u.email === 'someone@gmail.com'));
});

test('usage: only the two admins see it; a domain taken out of the variables signs its people out', async () => {
  const ops = await signIn('ops@shopdeck.com');
  assert.equal((await call('/api/usage', { cookie: ops })).status, 403);
  assert.equal((await call('/api/usage', { cookie: await signIn('piyush.sinhal@blitzscale.co') })).status, 200);
  process.env.ALLOWED_DOMAINS = 'blitzscale.co';
  assert.equal((await call('/api/sources', { cookie: ops })).status, 401);
  assert.equal((await (await call('/api/auth/me', { cookie: ops })).json()).removed, true);
});

test('usage: sign-ins, page events and actions land in the report', async () => {
  const admin = await signIn('arunabh.mishra@blitzscale.co');
  const ops = await signIn('ops@shopdeck.com');
  await call('/api/usage/events', { method: 'POST', cookie: ops, body: { session: 's1', events: [
    { type: 'open', tab: 'status' }, { type: 'view', tab: 'pmf/hits' }, { type: 'active', tab: 'pmf/hits', sec: 300 }, { type: 'active', tab: 'status', sec: 60 },
    { type: 'login', tab: 'x' }   // not a page event: dropped
  ] } });
  await call('/api/settings', { method: 'PUT', cookie: ops, body: { heroOrdersAll: 250 } });
  const U = await (await call('/api/usage?days=7', { cookie: admin })).json();
  const p = U.users.find((u) => u.email === 'ops@shopdeck.com');
  assert.equal(p.logins, 1); assert.equal(p.activeMin, 6); assert.equal(p.topTab, 'pmf/hits'); assert.equal(p.actions.rules, 1); assert.equal(p.sessions, 1);
  assert.equal(U.totals.usersToday, 2);
  assert.ok(U.users.some((u) => u.email === 'piyush.sinhal@blitzscale.co' && !u.lastSeen));   // admin who hasn't signed in yet
  assert.ok(U.recent.some((e) => e.type === 'rules' && /L30D orders/.test(e.detail)));
  assert.equal(U.tabs[0].tab, 'pmf/hits');
  const csv = await (await call('/api/usage.csv?days=7', { cookie: admin })).text();
  assert.match(csv.split('\n')[0], /^at,email,type/);
});

test('without GOOGLE_CLIENT_ID the dashboard keeps the old open / password behaviour', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal((await call('/api/sources')).status, 200);
  assert.equal((await (await call('/api/auth/me')).json()).mode, 'open');
  process.env.DASHBOARD_PASSWORD = 'pw';
  assert.equal((await call('/api/sources')).status, 401);
  const ok = await api.handle(new Request(BASE + '/api/sources', { headers: { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } }));
  assert.equal(ok.status, 200);
  delete process.env.DASHBOARD_PASSWORD;
});

test('summarise: never-seen people listed, days and windows in IST', () => {
  const ev = (email, at, type, extra = {}) => ({ id: Math.random().toString(), email, at, type, ...extra });
  const U = summarise([
    ev('a@x.com', '2026-10-27T19:00:00Z', 'active', { tab: 'status', sec: 120, session: 's' }),   // 28 Oct 00:30 IST
    ev('a@x.com', '2026-10-20T05:00:00Z', 'login'),
    ev('b@x.com', '2026-09-01T05:00:00Z', 'login'),                                               // outside 30 days
    ev('z@gmail.com', '2026-10-27T05:00:00Z', 'denied')
  ], { days: 30, today: '2026-10-28', people: ['c@x.com'] });
  assert.equal(U.totals.usersToday, 1);
  assert.equal(U.daily.at(-1).activeMin, 2);
  assert.deepEqual(U.users.map((u) => [u.email, !!u.lastSeen]), [['a@x.com', true], ['c@x.com', false]]);
  assert.equal(U.users[0].daysActive7, 1); assert.equal(U.users[0].daysActive, 2);
  assert.deepEqual(U.denied.map((d) => d.email), ['z@gmail.com']);
});
