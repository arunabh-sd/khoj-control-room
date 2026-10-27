// Netlify Scheduled Function: the ShopDeck universe question (Q16457) on its own, once a day. It is the heaviest
// question; alone it gets the full scheduled-function time and can't stop the others from loading.
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';
import { backgroundDispatcher } from '../../server/dispatch.js';

export default async () => {
  const store = createStore();
  await store.init();
  const result = await createApi(store).runDaily({ phase: 3, dispatch: backgroundDispatcher() });
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '4-59/5 * * * *' };
