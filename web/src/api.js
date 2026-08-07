/** Thin fetch wrapper. Surfaces the server's `needsReconnect` flag so the shell can send
 *  the user back to Connect instead of showing a dead-end error. */

class ApiError extends Error {
  constructor(message, { status, needsReconnect, name }) {
    super(message);
    this.status = status;
    this.needsReconnect = Boolean(needsReconnect);
    this.serverName = name;
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = isJson ? payload.error : payload || `${res.status} ${res.statusText}`;
    throw new ApiError(message, {
      status: res.status,
      needsReconnect: isJson ? payload.needsReconnect : false,
      name: isJson ? payload.name : undefined,
    });
  }
  return payload;
}

const get = (url) => request('GET', url);
const post = (url, body) => request('POST', url, body);
const patch = (url, body) => request('PATCH', url, body);
const del = (url) => request('DELETE', url);

const q = (params) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();

export const api = {
  health: () => get('/api/health'),

  environments: () => get('/api/auth/environments'),
  session: (env) => get(`/api/auth/session?${q({ env })}`),
  verifySession: (env) => post('/api/auth/session/verify', { env }),
  refreshSession: (env) => post('/api/auth/session/refresh', { env }),
  logout: (env, forgetBrowser = false) => post('/api/auth/logout', { env, forgetBrowser }),
  forgetBrowser: (env) => post('/api/auth/forget-browser', { env }),

  login: (body) => post('/api/auth/login', body),
  loginStatus: (attemptId) => get(`/api/auth/login/${attemptId}`),
  submitMfa: (attemptId, code) => post(`/api/auth/login/${attemptId}/mfa`, { code }),
  cancelLogin: (attemptId) => post(`/api/auth/login/${attemptId}/cancel`, {}),
  manualSession: (body) => post('/api/auth/session/manual', body),

  setSmtp: (body) => post('/api/auth/smtp', body),
  clearSmtp: (env) => del(`/api/auth/smtp?${q({ env })}`),

  lifecycle: () => get('/api/catalog/lifecycle'),
  runLifecycle: (runId) => get(`/api/runs/${runId}/lifecycle`),

  families: (env) => get(`/api/catalog/families?${q({ env })}`),
  templates: () => get('/api/catalog/templates'),
  products: (env, params = {}) => get(`/api/catalog/products?${q({ env, ...params })}`),
  picklists: (env) => get(`/api/catalog/picklists?${q({ env })}`),
  recentOrders: (env) => get(`/api/catalog/orders/recent?${q({ env })}`),
  order: (env, orderNumber) =>
    get(`/api/catalog/orders/${encodeURIComponent(orderNumber)}?${q({ env })}`),

  runs: () => get('/api/runs'),
  createRun: (body) => post('/api/runs', body),
  run: (runId) => get(`/api/runs/${runId}`),
  patchRun: (runId, body) => patch(`/api/runs/${runId}`, body),
  deleteRun: (runId) => del(`/api/runs/${runId}`),

  cursors: (runId) => get(`/api/runs/${runId}/cursors`),
  resetCursors: (runId, family) => post(`/api/runs/${runId}/cursors/reset`, { family }),
  setCursor: (runId, templateId, seriesName, value) =>
    post(`/api/runs/${runId}/cursors/set`, { templateId, seriesName, value }),
  allocate: (runId) => post(`/api/runs/${runId}/allocate`, {}),
  checkIds: (runId) => post(`/api/runs/${runId}/check-ids`, {}),

  generate: (runId, operation, deviceIds) =>
    post(`/api/runs/${runId}/generate`, { operation, ...(deviceIds ? { deviceIds } : {}) }),
  operations: (runId) => get(`/api/runs/${runId}/operations`),
  preview: (runId, key, maxBytes) =>
    get(`/api/runs/${runId}/preview/${encodeURIComponent(key)}?${q({ maxBytes })}`),
  validate: (runId, operation) => get(`/api/runs/${runId}/validate?${q({ operation })}`),
  send: (runId, body) => post(`/api/runs/${runId}/send`, body),
  confirmSend: (runId, body) => post(`/api/runs/${runId}/send/confirm`, body),
  closeMailWindow: (runId) => post(`/api/runs/${runId}/mail/close`, {}),
  outlookSignIn: (env) => post('/api/auth/outlook/signin', { env }),
  outlookVerify: (env) => post('/api/auth/outlook/verify', { env }),
  outlookForget: (env) => post('/api/auth/outlook/forget', { env }),

  startPoll: (runId, stage) => post(`/api/runs/${runId}/poll/${stage}/start`, {}),
  stopPoll: (runId, stage) => post(`/api/runs/${runId}/poll/${stage}/stop`, {}),
  pollOnce: (runId, stage) => post(`/api/runs/${runId}/poll/${stage}/once`, {}),
  poll: (runId, stage) => get(`/api/runs/${runId}/poll/${stage}`),
  assets: (runId) => get(`/api/runs/${runId}/assets`),
  result: (runId) => get(`/api/runs/${runId}/result`),

  downloadUrl: (runId, key, asUpload = false) =>
    `/api/runs/${runId}/download/${encodeURIComponent(key)}?${q({ asUpload: asUpload ? 'true' : undefined })}`,
  emlUrl: (runId, operation, family) => `/api/runs/${runId}/eml?${q({ operation, family })}`,
  resultTextUrl: (runId) => `/api/runs/${runId}/result?format=text`,
};

export { ApiError };
