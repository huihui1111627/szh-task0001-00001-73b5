// 后端 API 封装 + 帧解码
export const TICK_MS = 2000;

async function req(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

export const api = {
  config: () => req('/api/config'),
  listSessions: () => req('/api/sessions'),
  createSession: (setup, name) => req('/api/sessions', { method: 'POST', body: { setup, name } }),
  snapshot: id => req(`/api/sessions/${id}`),
  remove: id => req(`/api/sessions/${id}`, { method: 'DELETE' }),
  control: (id, action) => req(`/api/sessions/${id}/control`, { method: 'POST', body: { action } }),
  decide: (id, action, params) => req(`/api/sessions/${id}/decision`, {
    method: 'POST', body: { action, ...params }
  }),
  branch: (id, tick, name) => req(`/api/sessions/${id}/branch`, {
    method: 'POST', body: { tick, name }
  }),
  seek: (id, tick) => req(`/api/sessions/${id}/seek`, { method: 'POST', body: { tick } }),
  compare: ids => req(`/api/compare?ids=${encodeURIComponent(ids.join(','))}`),
  frames: id => req(`/api/sessions/${id}/frames`)
};

// 紧凑帧解码（与 lib/engine.js encodeFrame 对应）
export function decodeFrame(f) {
  if (!f) return null;
  return {
    tick: f[0],
    smoke: f[1].map(v => v / 100),
    temp: f[2],
    visibility: f[3],
    people: f[4],
    vehicles: f[5],
    wind: f[6].map(v => v / 10),
    evacuated: f[7],
    casualties: f[8],
    status: f[9],
    fanDirs: f[10],
    exitOpen: f[11],
    trapped: f[12] || []
  };
}

export function fmtTick(tick) {
  const total = tick * (TICK_MS / 1000);
  const m = Math.floor(total / 60), s = Math.round(total % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function toast(msg, isErr = false, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  el.classList.remove('hidden');
}
