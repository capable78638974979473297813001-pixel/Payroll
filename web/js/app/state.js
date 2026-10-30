import { api } from '../api.js';
import { session } from '../session.js';

/** The signed-in company's dashboard (config, catalog) and the data behind its cards. Loaded once, refreshed on demand. */
export const app = { companyId: null, dash: null, data: null };

export async function loadApp({ force = false } = {}) {
  const cid = session.user.companyId;
  if (!force && app.dash && app.companyId === cid) return app;
  const [dash, data] = await Promise.all([api.get(`/v1/companies/${cid}/dashboard`), api.get(`/v1/companies/${cid}/dashboard/data`)]);
  app.companyId = cid; app.dash = dash; app.data = data;
  return app;
}

export async function refreshData() {
  app.data = await api.get(`/v1/companies/${app.companyId}/dashboard/data`);
  return app.data;
}

export const cid = () => app.companyId;
export const base = () => `/v1/companies/${app.companyId}`;
