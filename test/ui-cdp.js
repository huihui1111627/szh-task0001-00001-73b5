/* CDP 驱动真实 Chrome 做 UI 集成测试 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
process.env.NODE_PATH = '/opt/homebrew/lib/node_modules/openclaw/node_modules';
require('module').Module._initPaths();
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function httpJson(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + p, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TEST_FN = `(async () => {
  const log = [];
  const ok = (n, c) => { log.push((c ? 'PASS ' : 'FAIL ') + n); if (!c) throw new Error(n); };
  await new Promise(r => setTimeout(r, 800));
  ok('初始时钟00:00', document.getElementById('simClock').textContent === '00:00');
  ok('5台风机', document.querySelectorAll('#fanList .fan-item').length === 5);
  ok('隧道已绘制', document.getElementById('tunnelCanvas').width > 0);

  document.getElementById('fireSeg').value = 12;
  document.getElementById('igniteBtn').click();
  await new Promise(r => setTimeout(r, 100));
  ok('起火后按钮禁用', document.getElementById('igniteBtn').disabled);
  ok('启动可用', !document.getElementById('startBtn').disabled);

  document.querySelector('#fanList .mini-btn[data-dir="1"]').click();
  await new Promise(r => setTimeout(r, 60));
  ok('风机可开启', !!document.querySelector('#fanList .mini-btn.active:not(.off)'));

  [...document.querySelectorAll('#exitList .mini-btn')].find(b => b.textContent.trim() === '关闭').click();
  await new Promise(r => setTimeout(r, 60));
  ok('出口可关闭', !!document.querySelector('.exit-item.closed'));

  for (let i = 0; i < 30; i++) { document.getElementById('stepBtn').click(); await new Promise(r => setTimeout(r, 0)); }
  ok('时钟前进', document.getElementById('simClock').textContent !== '00:00');
  const danger = +document.querySelectorAll('.metric')[3].querySelector('.v').textContent;
  ok('出现危险区段(' + danger + ')', danger >= 1);

  const canvas = document.getElementById('tunnelCanvas');
  const rr = canvas.getBoundingClientRect(); const padL = 46, cellW = (canvas.clientWidth - padL - 16) / 24;
  canvas.dispatchEvent(new MouseEvent('click', { clientX: rr.left + padL + 12 * cellW + cellW / 2, clientY: rr.top + 200, bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  ok('区段详情#12', document.getElementById('detailBody').textContent.includes('#12'));
  ok('详情含能见度', document.getElementById('detailBody').textContent.includes('m'));

  ok('时间轴有决策事件', document.querySelectorAll('.tl-event').length >= 3);

  window.prompt = () => '测试方案A';
  document.getElementById('savePlanBtn').click();
  await new Promise(r => setTimeout(r, 400));
  ok('方案已保存', document.getElementById('planList').textContent.includes('测试方案A'));

  // 失败操作回滚: 起火后改密度应被拒绝且状态不变
  const before = document.getElementById('simClock').textContent;
  const sel = document.getElementById('densitySel');
  sel.value = 'jam'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 60));
  ok('非法操作被toast拦截', document.getElementById('toast').textContent.includes('起火后'));
  ok('状态保持', document.getElementById('simClock').textContent === before);

  return log.join('\\n');
})()`;

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--window-size=1600,1050', 'about:blank'],
    { stdio: 'ignore' });
  await sleep(1500);
  try {
    const tabs = await httpJson('/json');
    const tab = tabs.find(t => t.type === 'page');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise(res => {
      const mid = ++id; pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    await new Promise(r => ws.on('open', r));
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(2500);
    const r = await send('Runtime.evaluate', {
      expression: TEST_FN, awaitPromise: true, returnByValue: true, timeout: 20000
    });
    if (r.exceptionDetails) {
      console.log('PAGE_ERROR', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      process.exit(1);
    }
    console.log(r.result.value);
    const failed = (r.result.value || '').split('\n').filter(l => l.startsWith('FAIL'));
    process.exit(failed.length ? 1 : 0);
  } finally {
    chrome.kill();
  }
})().catch(e => { console.error('RUNNER_ERROR', e.message); process.exit(1); });
