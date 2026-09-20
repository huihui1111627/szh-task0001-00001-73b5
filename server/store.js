'use strict';
/* JSON 文件存储: 原子写入, 进程重启后数据保留 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SIM_DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const PLANS_DIR = path.join(DATA_DIR, 'plans');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

function atomicWrite(file, obj) {
  ensureDirs();
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// ---------- 当前会话 (未完成推演的实时快照) ----------
function saveSession(session) { atomicWrite(SESSION_FILE, session); }
function loadSession() { return readJson(SESSION_FILE, null); }
function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch (e) { /* ignore */ }
}

// ---------- 处置方案 ----------
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 80) || ('plan_' + Date.now());
}

function savePlan(plan) {
  const id = plan.id || ('plan_' + Date.now().toString(36));
  plan.id = id;
  const file = path.join(PLANS_DIR, id + '.json');
  atomicWrite(file, plan);
  return plan;
}

function listPlans() {
  ensureDirs();
  return fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(PLANS_DIR, f), null))
    .filter(Boolean)
    .map(p => ({ id: p.id, name: p.name, savedAt: p.savedAt, finalTick: p.finalTick, summary: p.summary }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function getPlan(id) {
  return readJson(path.join(PLANS_DIR, safeName(id) + '.json'), null);
}

function deletePlan(id) {
  try { fs.unlinkSync(path.join(PLANS_DIR, safeName(id) + '.json')); return true; }
  catch (e) { return false; }
}

module.exports = { saveSession, loadSession, clearSession, savePlan, listPlans, getPlan, deletePlan };
