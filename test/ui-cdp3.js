/* 第三轮: 保存两个不同处置方案 -> 勾选 -> 同步回放对比 */
const { spawn } = require('child_process');
const http = require('http');
process.env.NODE_PATH = '/opt/homebrew/lib/node_modules/openclaw/node_modules';
require('module').Module._initPaths();
const WebSocket = require('ws');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9336;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p){return new Promise((res,rej)=>{http.get('http://127.0.0.1:'+PORT+p,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}

const SCEN = (name, fanDir) => `(async () => {
  document.getElementById('resetBtn').click();
  await new Promise(r=>setTimeout(r,200));
  document.getElementById('fireSeg').value = 11;
  document.getElementById('igniteBtn').click();
  await new Promise(r=>setTimeout(r,80));
  // 风机策略: 全部 ${fanDir === 1 ? '向东(→)' : fanDir === -1 ? '向西(←)' : '关闭'}
  document.querySelectorAll('#fanList .mini-btn[data-dir="${fanDir}"]').forEach(b => b.click());
  await new Promise(r=>setTimeout(r,80));
  for (let i=0;i<40;i++){ document.getElementById('stepBtn').click(); await new Promise(r=>setTimeout(r,0)); }
  window.prompt = () => '${name}';
  document.getElementById('savePlanBtn').click();
  await new Promise(r=>setTimeout(r,400));
  return document.getElementById('simClock').textContent + '|' + document.getElementById('planList').textContent.includes('${name}');
})()`;

const COMPARE = `(async () => {
  const log = [];
  const ok = (n,c) => { log.push((c?'PASS ':'FAIL ')+n); if(!c) throw new Error(n); };
  await new Promise(r=>setTimeout(r,500));
  ok('存在两个方案 ' + document.querySelectorAll('.plan-item').length,
     document.querySelectorAll('.plan-item').length >= 2);
  // 保存方案时自动勾选; 若数量不足再手动勾选
  if (document.querySelectorAll('.plan-item.selected').length < 2) {
    const u = document.querySelector('.plan-item:not(.selected)');
    if (u) u.click();
    await new Promise(r=>setTimeout(r,300));
  }
  ok('已勾选两个方案 ' + log.slice(-2).join('|'), document.querySelectorAll('.plan-item.selected').length >= 2);
  ok('同步回放按钮可用', !document.getElementById('compareBtn').disabled);
  document.getElementById('compareBtn').click();
  await new Promise(r=>setTimeout(r,1500));
  const modal = document.getElementById('compareModal');
  ok('对比弹层打开', !modal.hidden);
  ok('三条对比曲线', document.querySelectorAll('#compareCharts canvas').length === 3);
  const rows = document.querySelectorAll('#compareTable tr').length;
  ok('对比表多行指标 ' + rows, rows >= 6);
  ok('含完成时间行', document.getElementById('compareTable').textContent.includes('预计完成时间'));
  ok('含风机冲突行', document.getElementById('compareTable').textContent.includes('风机冲突'));
  ok('方案名出现在表头', document.getElementById('compareTable').textContent.includes('方案') );
  // 拖动回放游标
  const scrub = document.getElementById('cmpScrub');
  scrub.value = Math.floor(scrub.max / 2);
  scrub.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,200));
  ok('游标回放在中间时刻', document.getElementById('cmpClock').textContent !== '00:00');
  return log.join('\\n');
})()`;

(async () => {
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox',
    '--remote-debugging-port='+PORT,'--window-size=1600,1050','about:blank'], { stdio: 'ignore' });
  await sleep(1500);
  let ws, id = 0; const pending = new Map();
  try {
    const tab = (await httpJson('/json')).find(t => t.type === 'page');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    await send('Page.enable'); await send('Runtime.enable');
    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 25000 });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(2000);
    console.log('方案A:', await evalJs(SCEN('方案A-全部向东', 1)));
    console.log('方案B:', await evalJs(SCEN('方案B-全部向西', -1)));
    console.log(await evalJs(COMPARE));
  } finally { chrome.kill(); }
})().catch(e => { console.error('RUNNER_ERROR', e.message); process.exit(1); });
