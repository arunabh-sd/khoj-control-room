// Netlify Scheduled Function: the phase-2 questions (site sessions and repeat benchmark), asked about Khoj and the
// parent sellers of what Khoj has sold, using the order history and products from daily.mjs. Checks every 5 minutes
// (2 minutes after daily.mjs); one pull a day per question.
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';
import { backgroundDispatcher } from '../../server/dispatch.js';

export default async () => {
  const store = createStore();
  await store.init();
  const result = await createApi(store).runDaily({ phase: 2, dispatch: backgroundDispatcher() });
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '2-59/5 * * * *' };
