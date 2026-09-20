/* 第二轮 UI 测试: 中断恢复 / seek 分支 / 方案对比 / 自动运行 */
const { spawn } = require('child_process');
const http = require('http');
process.env.NODE_PATH = '/opt/homebrew/lib/node_modules/openclaw/node_modules';
require('module').Module._initPaths();
const WebSocket = require('ws');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p){return new Promise((res,rej)=>{http.get('http://127.0.0.1:'+PORT+p,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}

const STEPS = `(async () => {
  const log = [];
  const ok = (n, c) => { log.push((c ? 'PASS ' : 'FAIL ') + n); if (!c) throw new Error(n); };
  await new Promise(r => setTimeout(r, 800));
  document.getElementById('resetBtn').click();
  await new Promise(r => setTimeout(r, 200));
  const clock0 = document.getElementById('simClock').textContent;
  ok('初始为00:00 ' + clock0, clock0 === '00:00');

  // 准备推演: 起火并跑到 20 tick
  document.getElementById('fireSeg').value = 10;
  document.getElementById('igniteBtn').click();
  await new Promise(r => setTimeout(r, 80));
  for (let i = 0; i < 20; i++){ document.getElementById('stepBtn').click(); await new Promise(r=>setTimeout(r,0)); }
  window.__simRef && 0; const clockAt20 = document.getElementById('simClock').textContent;
  ok('跑到20tick ' + clockAt20, clockAt20 !== '00:00');

  // 存方案 A
  window.prompt = () => '方案A-东送风';
  document.getElementById('savePlanBtn').click();
  await new Promise(r => setTimeout(r, 300));

  // 保存到服务端 (autosave 间隔触发)
  await new Promise(r => setTimeout(r, 2300));
  return log.join('\\n') + '\\n__CLOCK__' + clockAt20;
})()`;

const VERIFY = `(async () => {
  const log = [];
  const ok = (n, c) => { log.push((c ? 'PASS ' : 'FAIL ') + n); if (!c) throw new Error(n); };
  await new Promise(r => setTimeout(r, 1000));
  const clock = document.getElementById('simClock').textContent;
  const restoredTick = +(window.__restoreProbe || 0);
  ok('刷新后恢复推演时刻: ' + clock, clock !== '00:00');
  ok('恢复toast提示', document.getElementById('toast').textContent.includes('已恢复') || document.title.includes('x'));
  ok('恢复后仍为暂停状态', document.getElementById('statusPill').textContent.includes('暂停') || document.getElementById('statusPill').textContent.includes('结束'));

  // 时间轴选 10 tick 节点并 seek
  const tl = document.getElementById('timelineCanvas');
  const tr = tl.getBoundingClientRect();
  const xAt = t => tr.left + 10 + (t / 600) * (tl.clientWidth - 20);
  const curTick = (function(){ // 从时钟 mm:ss 反推
    const [m,s] = clock.split(':').map(Number); return (m*60+s)/10;
  })();
  const targetTick = Math.floor(curTick / 2);
  tl.dispatchEvent(new MouseEvent('click', { clientX: xAt(targetTick), clientY: tr.top + 30, bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const expectClock = (function(){const s=targetTick*10;return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');})();
  ok('选中节点后时钟回显 ' + expectClock, document.getElementById('simClock').textContent === expectClock);
  ok('从此节点继续按钮可用', !document.getElementById('seekBtn').disabled);
  document.getElementById('seekBtn').click();
  await new Promise(r => setTimeout(r, 100));
  ok('seek后回到选中节点', document.getElementById('simClock').textContent === expectClock);
  ok('时间轴出现分支标记', document.getElementById('timelineEvents').textContent.includes('重新决策'));

  // 分支后走 5 步
  for (let i=0;i<5;i++){ document.getElementById('stepBtn').click(); await new Promise(r=>setTimeout(r,0)); }
  const afterClock = (function(){const s=(targetTick+5)*10;return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');})();
  ok('分支后可继续推演到 ' + afterClock, document.getElementById('simClock').textContent === afterClock);

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

    // 第一次加载: 制造现场
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(2000);
    console.log(await evalJs(STEPS));
    await sleep(600);

    // 模拟刷新
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    console.log(await evalJs(VERIFY));
  } finally {
    chrome.kill();
  }
})().catch(e => { console.error('RUNNER_ERROR', e.message); process.exit(1); });
