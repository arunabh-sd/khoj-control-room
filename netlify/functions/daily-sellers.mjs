// Netlify Scheduled Function, half past every hour: the phase-2 questions (site sessions and repeat benchmark),
// asked about Khoj and the parent sellers of what Khoj has sold. Needs the order history and products pulled by
// daily.mjs on the hour. One pull a day per question.
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';

export default async () => {
  const store = createStore();
  await store.init();
  const result = await createApi(store).runDaily({ phase: 2 });
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '30 * * * *' };
