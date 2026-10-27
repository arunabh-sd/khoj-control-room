// Netlify Background Function (the -background suffix gives it up to 15 minutes): pulls one scheduled question that
// is too slow for a scheduled function's 30 seconds. Started by daily*.mjs with a token; returns 202 at once.
import { createStore } from '../../server/store.js';
import { createApi, checkPullToken } from '../../server/app.js';

export default async (req) => {
  if (!checkPullToken(req.headers.get('x-pull-token'))) return new Response('Forbidden', { status: 403 });
  const name = new URL(req.url).searchParams.get('source');
  const store = createStore();
  await store.init();
  const result = await createApi(store).pullInBackground(name);
  console.log(JSON.stringify(result));
};
