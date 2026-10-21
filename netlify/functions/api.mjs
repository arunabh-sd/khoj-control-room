// Netlify Function: the dashboard API (/api/*).
import { createStore } from '../../server/store.js';
import { createApi } from '../../server/app.js';

let ready;
function getApi() {
  if (!ready) {
    const store = createStore();
    ready = store.init().then(() => createApi(store));
  }
  return ready;
}

export default async (req) => (await getApi()).handle(req);

export const config = { path: ['/api/*', '/healthz'] };
