/* 服务端持久化 API; 服务不可用时自动降级到 localStorage */
(function () {
  const LS_SESSION = 'tunnel_sim_session_v1';
  const LS_PLANS = 'tunnel_sim_plans_v1';
  let serverOk = true;

  async function req(url, opts) {
    const res = await fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '请求失败');
    return res.json();
  }

  function lsGet(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; }
  }
  function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  const Api = {
    degraded() { return !serverOk; },

    async saveSession(sim) {
      try {
        await req('/api/session', { method: 'POST', body: JSON.stringify({ sim: sim, savedAt: Date.now() }) });
        serverOk = true;
      } catch (e) {
        serverOk = false;
        lsSet(LS_SESSION, { sim: sim, savedAt: Date.now() });
      }
    },

    async loadSession() {
      try {
        const r = await req('/api/session');
        serverOk = true;
        if (r.session) return r.session;
      } catch (e) { serverOk = false; }
      return lsGet(LS_SESSION, null);
    },

    async clearSession() {
      try { await req('/api/session', { method: 'DELETE' }); } catch (e) { /* ignore */ }
      localStorage.removeItem(LS_SESSION);
    },

    async listPlans() {
      try {
        const r = await req('/api/plans');
        serverOk = true;
        return r.plans || [];
      } catch (e) {
        serverOk = false;
        const all = lsGet(LS_PLANS, {});
        return Object.values(all).map(p => ({
          id: p.id, name: p.name, savedAt: p.savedAt, finalTick: p.finalTick, summary: p.summary
        })).sort((a, b) => b.savedAt - a.savedAt);
      }
    },

    async savePlan(plan) {
      plan.savedAt = Date.now();
      plan.id = plan.id || ('plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      try {
        const r = await req('/api/plans', { method: 'POST', body: JSON.stringify(plan) });
        serverOk = true;
        return r.plan;
      } catch (e) {
        serverOk = false;
        const all = lsGet(LS_PLANS, {});
        all[plan.id] = plan;
        lsSet(LS_PLANS, all);
        return plan;
      }
    },

    async getPlan(id) {
      try {
        const r = await req('/api/plans/' + encodeURIComponent(id));
        return r.plan;
      } catch (e) {
        const all = lsGet(LS_PLANS, {});
        return all[id] || null;
      }
    },

    async deletePlan(id) {
      try { await req('/api/plans/' + encodeURIComponent(id), { method: 'DELETE' }); }
      catch (e) {
        const all = lsGet(LS_PLANS, {});
        delete all[id];
        lsSet(LS_PLANS, all);
      }
    }
  };

  window.Api = Api;
})();
