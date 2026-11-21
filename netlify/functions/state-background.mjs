// Netlify Background Function (up to 15 minutes): computes the dashboard state from the stored pulls and caches it,
// so page loads don't have to (that took longer than the page function's time limit). Started with a token whenever
// a pull lands or the rules / plan change; returns 202 at once.
import { createStore } from '../../server/store.js';
import { createApi, checkPullToken } from '../../server/app.js';

export default async (req) => {
  if (!checkPullToken(req.headers.get('x-pull-token'))) return new Response('Forbidden', { status: 403 });
  const store = createStore();
  await store.init();
  const t0 = Date.now();
  const result = await createApi(store).computeAndCacheState();
  console.log(JSON.stringify({ ...result, ms: Date.now() - t0 }));
};
