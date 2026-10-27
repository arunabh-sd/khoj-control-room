// Used by the scheduled functions: starts a background pull for one source. Returns true when Netlify accepted it
// (202); false means "run it here instead" (background functions unavailable, or no site URL).
import { pullToken } from './app.js';

export function backgroundDispatcher() {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base || !process.env.METABASE_API_KEY || process.env.KHOJ_NO_BACKGROUND) return null;
  return async (name) => {
    const r = await fetch(`${base}/.netlify/functions/pull-background?source=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'x-pull-token': pullToken() }, signal: AbortSignal.timeout(8000)
    });
    return r.status === 202;
  };
}
