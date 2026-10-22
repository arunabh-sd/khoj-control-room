// Netlify Scheduled Function: pulls the heavy, slow-changing questions (universe, order history, buyer overlap)
// once a day, outside the page's 10-second limit. Runs hourly but only calls Metabase for a question that hasn't
// been pulled today (IST), with up to 3 tries a day.
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';

export default async () => {
  const store = createStore();
  await store.init();
  const result = await createApi(store).runDaily();
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '@hourly' };
