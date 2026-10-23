'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CLIENT_KEY = process.env.CLIENT_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = 'pcs_ai_state_v1';

if (!ADMIN_PASSWORD || !CLIENT_KEY) console.warn('[!] Set ADMIN_PASSWORD and CLIENT_KEY');

const DEFAULT_STATE = () => ({
  settings: {
    enabled: true,
    defaultLimit: parseInt(process.env.DEFAULT_DAILY_LIMIT || '50', 10),
    tzOffsetHours: parseFloat(process.env.TZ_OFFSET_HOURS || '3'),
    maxInputChars: 500, maxOutputTokens: 400, historyMessages: 10, temperature: 0.7,
    systemPrompt: 'You are an AI assistant inside GTA San Andreas (SA-MP), Arizona RP server. Reply in Russian, short and to the point (up to 4-5 sentences), no markdown or emoji. If you do not know - say so.',
    activeProvider: '',
  },
  providers: [], users: {},
});
let state = DEFAULT_STATE();
let dirty = false;

function merge(dst, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') merge(dst[k], src[k]);
    else dst[k] = src[k];
  }
  return dst;
}
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  return r.json();
}
async function loadState() {
  try {
    let raw = null;
    if (UP_URL && UP_TOKEN) { const j = await upstash(['GET', UP_KEY]); raw = j && j.result; }
    else { const f = path.join(DATA_DIR, 'state.json'); if (fs.existsSync(f)) raw = fs.readFileSync(f, 'utf8'); }
    if (raw) state = merge(DEFAULT_STATE(), JSON.parse(raw));
    console.log('[state] loaded:', state.providers.length, 'providers');
  } catch (e) { console.error('[state] load failed:', e.message); }
  bootstrapFromEnv();
}
function bootstrapFromEnv() {
  const pairs = [
    { env: 'GROQ_API_KEY', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { env: 'OPENAI_API_KEY', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { env: 'GEMINI_API_KEY', name: 'Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
  ];
  for (const spec of pairs) {
    const key = (process.env[spec.env] || '').trim();
    if (!key) continue;
    let p = state.providers.find((x) => x.name === spec.name);
    if (!p) { p = { id: crypto.randomBytes(5).toString('hex'), apiKey: '' }; state.providers.push(p); }
    Object.assign(p, { name: spec.name, type: spec.type, baseUrl: spec.baseUrl, model: spec.model, enabled: true, apiKey: key });
    if (!S().activeProvider) S().activeProvider = p.id;
    touch();
  }
}
function detectKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k || k.length < 10) return null;
  if (k.startsWith('gsk_')) return { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: k };
  if (k.startsWith('sk-') || k.startsWith('sk-proj-')) return { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: k };
  if (k.startsWith('AIza') || k.startsWith('AQ.')) return { name: 'Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', apiKey: k };
  return { name: 'Custom', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: k };
}
function upsertProvider(cfg) {
  let p = state.providers.find((x) => x.name === cfg.name);
  if (!p) { p = { id: crypto.randomBytes(5).toString('hex'), apiKey: '' }; state.providers.push(p); }
  Object.assign(p, { name: cfg.name, type: cfg.type, baseUrl: cfg.baseUrl, model: cfg.model, enabled: true, apiKey: cfg.apiKey });
  S().activeProvider = p.id; touch(); return p;
}
let saving = false;
async function saveState() {
  if (saving || !dirty) return;
  saving = true; dirty = false;
  try {
    const raw = JSON.stringify(state);
    if (UP_URL && UP_TOKEN) await upstash(['SET', UP_KEY, raw]);
    else { fs.mkdirSync(DATA_DIR, { recursive: true }); const f = path.join(DATA_DIR, 'state.json'); fs.writeFileSync(f + '.tmp', raw); fs.renameSync(f + '.tmp', f); }
  } catch (e) { dirty = true; console.error('[state] save failed:', e.message); }
  saving = false;
}
const touch = () => { dirty = true; };
setInterval(saveState, 4000);
process.on('SIGTERM', async () => { dirty = true; await saveState(); process.exit(0); });

const S = () => state.settings;
function dayKey(now = Date.now()) { return new Date(now + S().tzOffsetHours * 3600e3).toISOString().slice(0, 10); }
function secondsToReset(now = Date.now()) {
  const shifted = now + S().tzOffsetHours * 3600e3;
  return Math.max(1, Math.round((Math.floor(shifted / 86400e3 + 1) * 86400e3 - shifted) / 1000));
}
function getUser(id, nick) {
  let u = state.users[id];
  if (!u) { u = state.users[id] = { nick: nick || '', limit: null, banned: false, day: dayKey(), used: 0, total: 0, last: 0, history: [] }; touch(); }
  if (nick && u.nick !== nick) { u.nick = nick; touch(); }
  if (u.day !== dayKey()) { u.day = dayKey(); u.used = 0; touch(); }
  return u;
}
const limitOf = (u) => (u.limit === null || u.limit === undefined ? S().defaultLimit : u.limit);
const remainingOf = (u) => { const l = limitOf(u); return l < 0 ? -1 : Math.max(0, l - u.used); };
const b64u = {
  enc: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
};
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const mask = (k) => (k ? '****' + String(k).slice(-4) : '');
const hits = new Map();
function ipLimited(ip, max = 40, windowMs = 60000) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs); arr.push(now); hits.set(ip, arr); return arr.length > max;
}

const TYPES = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
};

async function timedFetch(url, opts, ms = 45000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

async function callProvider(p, system, messages) {
  const cfg = S();
  const base = (p.baseUrl || TYPES[p.type].baseUrl).replace(/\/+$/, '');
  const model = p.model || TYPES[p.type].model;
  if (p.type === 'anthropic') {
    const r = await timedFetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature, system, messages }) });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  }
  if (p.type === 'gemini') {
    const r = await timedFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': p.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature } }),
    });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    return (parts || []).map((x) => x.text || '').join('').trim();
  }
  const r = await timedFetch(base + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + p.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || 'HTTP ' + r.status);
  return String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
}

async function askAI(system, messages) {
  const list = state.providers.filter((p) => p.enabled && p.apiKey);
  if (!list.length) { const e = new Error('no_provider'); e.code = 'no_provider'; throw e; }
  const active = list.find((p) => p.id === S().activeProvider);
  const order = active ? [active, ...list.filter((p) => p !== active)] : list;
  let lastErr;
  for (const p of order) {
    try {
      const text = await callProvider(p, system, messages);
      if (text) return { text, provider: p };
      lastErr = new Error('empty');
    } catch (e) { lastErr = e; console.warn('[ai]', p.name, e.message); }
  }
  const e = new Error(lastErr ? lastErr.message : 'fail'); e.code = 'upstream'; throw e;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.get('/', (_q, res) => res.type('text').send('PCStats AI backend is running'));
app.get('/health', (_q, res) => res.json({ ok: true }));
const reply = (res, obj) => { res.set('Cache-Control', 'no-store'); res.status(200).type('application/json').send(JSON.stringify(obj)); };

function clientAuth(req, res, next) {
  if (ipLimited(req.ip)) return reply(res, { ok: false, err: 'rate' });
  if (!CLIENT_KEY || !safeEq(req.query.k || '', CLIENT_KEY)) return reply(res, { ok: false, err: 'auth' });
  const id = String(req.query.u || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (id.length < 6) return reply(res, { ok: false, err: 'bad_user' });
  req.uid = id; req.nick = String(req.query.nick || '').replace(/[^\w.\-\[\]]/g, '').slice(0, 32); next();
}
function statusPayload(u) { return { remaining: remainingOf(u), limit: limitOf(u), resetIn: secondsToReset(), enabled: S().enabled }; }

app.get('/api/status', clientAuth, (req, res) => {
  const u = getUser(req.uid, req.nick);
  const p = state.providers.find((x) => x.id === S().activeProvider) || state.providers.find((x) => x.enabled && x.apiKey);
  reply(res, { ok: true, ...statusPayload(u), banned: !!u.banned, model: p ? (p.model || TYPES[p.type].model) : '' });
});
app.get('/api/clear', clientAuth, (req, res) => { const u = getUser(req.uid, req.nick); u.history = []; touch(); reply(res, { ok: true, ...statusPayload(u) }); });

const busy = new Set();
app.get('/api/chat', clientAuth, async (req, res) => {
  const u = getUser(req.uid, req.nick); const st = statusPayload(u);
  if (!S().enabled) return reply(res, { ok: false, err: 'disabled', ...st });
  if (u.banned) return reply(res, { ok: false, err: 'banned', ...st });
  if (busy.has(req.uid)) return reply(res, { ok: false, err: 'busy', ...st });
  let text = b64u.dec(req.query.m).replace(/\s+/g, ' ').trim().slice(0, S().maxInputChars);
  if (!text) return reply(res, { ok: false, err: 'empty', ...st });
  if (st.remaining === 0) return reply(res, { ok: false, err: 'limit', ...st });
  busy.add(req.uid); const limited = limitOf(u) >= 0; if (limited) u.used++;
  try {
    const hist = u.history.slice(-S().historyMessages);
    const { text: answer } = await askAI(S().systemPrompt, [...hist, { role: 'user', content: text }]);
    u.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    u.history = u.history.slice(-Math.max(2, S().historyMessages)); u.total++; u.last = Date.now(); touch();
    reply(res, { ok: true, r: b64u.enc(answer), ...statusPayload(u) });
  } catch (e) {
    if (limited) u.used = Math.max(0, u.used - 1);
    reply(res, { ok: false, err: e.code || 'upstream', ...statusPayload(u) });
  } finally { busy.delete(req.uid); touch(); }
});

function adminAuth(req, res, next) {
  if (ipLimited('adm' + req.ip, 60)) return res.status(429).json({ error: 'rate' });
  if (!ADMIN_PASSWORD || !safeEq(req.get('x-admin-password') || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'auth' });
  next();
}
const pubProvider = (p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, keyMask: mask(p.apiKey), hasKey: !!p.apiKey });

app.get('/admin/api/state', adminAuth, (_q, res) => {
  const day = dayKey();
  const users = Object.entries(state.users).map(([id, u]) => ({ id, nick: u.nick, limit: u.limit, effectiveLimit: limitOf(u), used: u.day === day ? u.used : 0, total: u.total, banned: u.banned, last: u.last })).sort((a, b) => b.last - a.last).slice(0, 300);
  res.json({ settings: S(), providers: state.providers.map(pubProvider), users, types: TYPES, resetIn: secondsToReset(), storage: UP_URL ? 'upstash' : 'file' });
});

app.post('/admin/api/settings', adminAuth, (req, res) => {
  const b = req.body || {}, s = S();
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  if ('enabled' in b) s.enabled = !!b.enabled;
  if ('defaultLimit' in b) s.defaultLimit = Math.round(num(b.defaultLimit, -1, 100000, s.defaultLimit));
  if ('tzOffsetHours' in b) s.tzOffsetHours = num(b.tzOffsetHours, -12, 14, s.tzOffsetHours);
  if ('maxInputChars' in b) s.maxInputChars = Math.round(num(b.maxInputChars, 20, 2000, s.maxInputChars));
  if ('maxOutputTokens' in b) s.maxOutputTokens = Math.round(num(b.maxOutputTokens, 50, 4000, s.maxOutputTokens));
  if ('historyMessages' in b) s.historyMessages = Math.round(num(b.historyMessages, 0, 40, s.historyMessages));
  if ('temperature' in b) s.temperature = num(b.temperature, 0, 1, s.temperature);
  if ('systemPrompt' in b) s.systemPrompt = String(b.systemPrompt).slice(0, 4000);
  if ('activeProvider' in b) s.activeProvider = String(b.activeProvider);
  touch(); res.json({ ok: true });
});

app.post('/admin/api/quick-key', adminAuth, async (req, res) => {
  const cfg = detectKey(req.body && req.body.apiKey);
  if (!cfg) return res.status(400).json({ ok: false, error: 'Вставь API-ключ' });
  const p = upsertProvider(cfg);
  try {
    const t0 = Date.now();
    const text = await callProvider(p, 'Answer with one word.', [{ role: 'user', content: 'Say: works' }]);
    res.json({ ok: true, name: p.name, model: p.model, ms: Date.now() - t0, text: String(text).slice(0, 80) });
  } catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 200), name: p.name, model: p.model }); }
});

app.post('/admin/api/playground', adminAuth, async (req, res) => {
  const text = String((req.body && req.body.message) || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text) return res.json({ ok: false, error: 'Пустое сообщение' });
  const hist = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-20) : [];
  const messages = [];
  for (const h of hist) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
    const c = String(h.content || '').slice(0, 2000);
    if (c) messages.push({ role: h.role, content: c });
  }
  messages.push({ role: 'user', content: text });
  try {
    const t0 = Date.now();
    const { text: answer, provider } = await askAI(S().systemPrompt, messages);
    res.json({ ok: true, answer, ms: Date.now() - t0, provider: provider ? provider.name : '', model: provider ? (provider.model || '') : '' });
  } catch (e) {
    res.json({ ok: false, error: e.code === 'no_provider' ? 'Нет провайдера с ключом — сначала сохрани API-ключ выше' : String(e.message).slice(0, 300) });
  }
});

app.post('/admin/api/provider', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!TYPES[b.type]) return res.status(400).json({ error: 'type' });
  let p = b.id && state.providers.find((x) => x.id === b.id);
  if (!p) { p = { id: crypto.randomBytes(5).toString('hex'), apiKey: '' }; state.providers.push(p); }
  p.name = String(b.name || b.type).slice(0, 40); p.type = b.type;
  p.baseUrl = String(b.baseUrl || '').trim().slice(0, 200); p.model = String(b.model || '').trim().slice(0, 100);
  p.enabled = b.enabled !== false; if (b.apiKey) p.apiKey = String(b.apiKey).trim();
  if (!S().activeProvider) S().activeProvider = p.id; touch(); res.json({ ok: true, id: p.id });
});
app.post('/admin/api/provider/delete', adminAuth, (req, res) => {
  state.providers = state.providers.filter((p) => p.id !== req.body.id);
  if (S().activeProvider === req.body.id) S().activeProvider = (state.providers[0] || {}).id || '';
  touch(); res.json({ ok: true });
});
app.post('/admin/api/provider/test', adminAuth, async (req, res) => {
  const p = state.providers.find((x) => x.id === req.body.id);
  if (!p) return res.status(404).json({ error: 'nf' });
  try {
    const t0 = Date.now();
    const text = await callProvider(p, 'Answer with one word.', [{ role: 'user', content: 'Say: works' }]);
    res.json({ ok: true, ms: Date.now() - t0, text: text.slice(0, 120) });
  } catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 200) }); }
});
app.post('/admin/api/user', adminAuth, (req, res) => {
  const b = req.body || {}, u = state.users[b.id]; if (!u) return res.status(404).json({ error: 'nf' });
  if ('limit' in b) u.limit = (b.limit === null || b.limit === '') ? null : Math.round(Number(b.limit));
  if ('banned' in b) u.banned = !!b.banned; if (b.resetUsed) u.used = 0; if (b.clearHistory) u.history = []; if (b.remove) delete state.users[b.id];
  touch(); res.json({ ok: true });
});
app.post('/admin/api/reset-all', adminAuth, (_q, res) => { for (const u of Object.values(state.users)) u.used = 0; touch(); res.json({ ok: true }); });

loadState().then(() => app.listen(PORT, () => console.log('PCStats AI backend on :' + PORT)));
