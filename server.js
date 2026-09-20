// 城市隧道通风与火灾疏散推演 —— HTTP 服务（REST + SSE）
import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from './lib/store.js';
import { CONFIG } from './lib/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let buf = '';
  req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

async function serveStatic(req, res, urlPath) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

const validateSetup = setup => {
  setup = setup || {};
  const fireSegment = Math.max(0, Math.min(CONFIG.SEGMENTS - 1, Number(setup.fireSegment ?? 12)));
  const fireLevel = Math.max(1, Math.min(3, Math.round(Number(setup.fireLevel ?? 2))));
  const trafficDensity = Math.max(0, Math.min(1, Number(setup.trafficDensity ?? 0.6)));
  if (!Number.isFinite(fireSegment) || !Number.isFinite(fireLevel) || !Number.isFinite(trafficDensity)) {
    return { error: '参数非法' };
  }
  return { setup: { fireSegment, fireLevel, trafficDensity, seed: setup.seed } };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);

    // ---- API ----
    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        segments: CONFIG.SEGMENTS, segmentLengthM: CONFIG.SEGMENT_LENGTH_M,
        tickMs: CONFIG.TICK_MS, maxTicks: CONFIG.MAX_TICKS,
        fanIndices: CONFIG.FAN_INDICES, exits: CONFIG.EXITS,
        dangerTemp: CONFIG.DANGER_TEMP, lethalTemp: CONFIG.LETHAL_TEMP
      });
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: store.list() });
    }

    // 方案对比：?ids=a,b,c —— 返回完整帧序列供前端同步回放
    if (p === '/api/compare' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const plans = ids.map(id => {
        const s = store.get(id);
        if (!s) return null;
        const snap = s.snapshot();
        return { id: s.id, name: s.name, status: s.liveStatus, frames: s.frames,
          decisions: s.decisions, setup: s.setup,
          evacuated: snap.evacuated, casualties: snap.casualties,
          remainingPeople: snap.remainingPeople, etaTicks: snap.etaTicks,
          warnings: snap.warnings, eventLog: s.eventLog };
      }).filter(Boolean);
      return json(res, 200, { plans, tickMs: CONFIG.TICK_MS });
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const v = validateSetup(body.setup);
      if (v.error) return json(res, 400, v);
      const session = store.create({ name: body.name, setup: v.setup });
      return json(res, 201, session.snapshot());
    }

    const m = p.match(/^\/api\/sessions\/([^/]+)(\/(stream|control|decision|frames|branch|seek))?$/);
    if (!m) return json(res, 404, { error: 'not found' });
    const session = store.get(m[1]);
    if (!session) return json(res, 404, { error: '会话不存在或已失效' });
    const sub = m[3];

    if (!sub && req.method === 'GET') return json(res, 200, session.snapshot());
    if (!sub && req.method === 'DELETE') return json(res, 200, { ok: store.remove(session.id) });

    if (sub === 'stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive'
      });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: 'snapshot', snapshot: session.snapshot() });
      const unsub = session.subscribe(send);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); unsub(); });
      return;
    }

    if (sub === 'control' && req.method === 'POST') {
      const { action } = await readBody(req);
      let out;
      if (action === 'start') out = session.start();
      else if (action === 'pause') out = session.pause();
      else if (action === 'step') out = session.singleStep();
      else return json(res, 400, { error: '未知控制动作' });
      return json(res, out.error ? 409 : 200, out);
    }

    if (sub === 'decision' && req.method === 'POST') {
      const body = await readBody(req);
      const allowed = ['setFan', 'allFans', 'toggleExit', 'extinguish'];
      if (!allowed.includes(body.action)) return json(res, 400, { error: '未知决策类型' });
      const out = session.decide(body.action, body);
      return json(res, out.error ? 400 : 200, out);
    }

    if (sub === 'frames' && req.method === 'GET') {
      const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10));
      return json(res, 200, { frames: session.frames.slice(from), from, tick: session.state.tick });
    }

    if (sub === 'branch' && req.method === 'POST') {
      const body = await readBody(req);
      const tick = Number.isFinite(body.tick) ? body.tick : session.state.tick;
      const branched = session.branchAt(tick, body.name);
      return json(res, 201, branched.snapshot());
    }

    if (sub === 'seek' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Number.isFinite(body.tick)) return json(res, 400, { error: 'tick 非法' });
      return json(res, 200, session.seekTo(body.tick));
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err.message || err) });
  }
});


await store.init();
server.listen(PORT, () => {
  console.log(`隧道推演服务已启动: http://localhost:${PORT}`);
});

const shutdown = async () => {
  console.log('\n正在保存所有推演状态...');
  await store.flushAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
