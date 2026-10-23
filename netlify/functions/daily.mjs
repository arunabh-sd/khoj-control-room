// Netlify Scheduled Function: pulls the slow questions (products every 6 hours; universe, order history, buyer
// overlap once a day) outside the page's 10-second limit. Checks every 5 minutes but only calls Metabase for a
// question that is due, with up to 3 tries per window, so the first run after a deploy comes within minutes.
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';

export default async () => {
  const store = createStore();
  await store.init();
  const result = await createApi(store).runDaily();
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '*/5 * * * *' };
