'use strict';
/* 城市隧道火灾推演 - 零依赖 HTTP 服务
 *  - 静态文件 public/
 *  - /api/session  中断恢复 (GET/POST/DELETE)
 *  - /api/plans    方案保存与对比数据 (GET/POST/DELETE)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function send(res, status, body, type) {
  const contentType = type || 'application/json; charset=utf-8';
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 20 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    // ---------- API ----------
    if (url.startsWith('/api/')) {
      if (url === '/api/session' && req.method === 'GET') {
        return send(res, 200, { session: store.loadSession() });
      }
      if (url === '/api/session' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.sim) return send(res, 400, { error: '缺少 sim 快照' });
        store.saveSession({ sim: body.sim, savedAt: body.savedAt || Date.now() });
        return send(res, 200, { ok: true, savedAt: Date.now() });
      }
      if (url === '/api/session' && req.method === 'DELETE') {
        store.clearSession();
        return send(res, 200, { ok: true });
      }

      if (url === '/api/plans' && req.method === 'GET') {
        return send(res, 200, { plans: store.listPlans() });
      }
      if (url === '/api/plans' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.config || !body.decisions) return send(res, 400, { error: '方案数据不完整' });
        return send(res, 200, { plan: store.savePlan(body) });
      }
      const planMatch = url.match(/^\/api\/plans\/([^/]+)$/);
      if (planMatch) {
        const id = planMatch[1];
        if (req.method === 'GET') {
          const p = store.getPlan(id);
          return p ? send(res, 200, { plan: p }) : send(res, 404, { error: '方案不存在' });
        }
        if (req.method === 'DELETE') {
          return send(res, 200, { ok: store.deletePlan(id) });
        }
      }
      return send(res, 404, { error: 'unknown api' });
    }
    // ---------- 静态 ----------
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('隧道火灾推演服务已启动: http://localhost:' + PORT);
});

module.exports = server;
