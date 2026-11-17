// Worker entry (shape only; not deployable until the D1 atomic executor exists - see d1.js).
import { createApp } from './api.js';
import { d1Adapter } from './d1.js';

export default {
  async fetch(request, env) {
    return createApp({ db: d1Adapter(env.DB), master: env.MNP_MASTER_SECRET }).fetch(request);
  },
};
