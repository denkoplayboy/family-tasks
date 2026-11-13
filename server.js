#!/usr/bin/env node
// Семейные дела — сервер без внешних зависимостей (Node.js >= 18).
// Хранит данные в JSON-файле, раздаёт статику и шлёт живые обновления через SSE.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = process.env.APP_TZ || 'Asia/Jerusalem';
const SESSION_DAYS = 180;
const MAX_BACKDATE_DAYS = 30;

// ---------- Каталог дел по умолчанию ----------
// type: fixed — цена за раз; hourly — цена за час; percent — процент от чека; custom — сумма вручную (бонус от родителя)
const DEFAULT_TASKS = [
  { id: 'sweep', name: 'Подмести полы', icon: '🧹', type: 'fixed', price: 15, weekly: true },
  { id: 'mop', name: 'Помыть полы', icon: '🪣', type: 'fixed', price: 35, weekly: true },
  { id: 'cook', name: 'Приготовить еду', icon: '🍳', type: 'hourly', price: 15 },
  { id: 'dishes', name: 'Помыть посуду', icon: '🍽️', type: 'fixed', price: 10 },
  { id: 'shop', name: 'Сходить в магазин', icon: '🛒', type: 'percent', price: 10 },
  { id: 'laundry', name: 'Стирка и развешивание', icon: '👕', type: 'fixed', price: 10 },
  { id: 'sink', name: 'Помыть раковину', icon: '🚰', type: 'fixed', price: 10 },
  { id: 'stove', name: 'Помыть плиту', icon: '🔥', type: 'fixed', price: 10 },
  { id: 'toilet', name: 'Помыть унитаз', icon: '🚽', type: 'fixed', price: 40 },
  { id: 'dust', name: 'Протереть пыль в общей зоне', icon: '🪶', type: 'fixed', price: 20 },
  { id: 'microwave', name: 'Помыть микроволновку', icon: '⏲️', type: 'fixed', price: 20 },
  { id: 'oven', name: 'Помыть духовку', icon: '🥧', type: 'fixed', price: 30 },
  { id: 'extra', name: 'Внеплановые работы', icon: '🛠️', type: 'hourly', price: 20, noteRequired: true },
  { id: 'parcel', name: 'Забрать посылку', icon: '📦', type: 'fixed', price: 20 },
  { id: 'bonus', name: 'Бонус от родителя', icon: '🎁', type: 'custom', price: 0, parentOnly: true, noteRequired: true },
];

const DEFAULT_MEMBERS = [
  { id: 'dad', name: 'Папа', role: 'parent' },
  { id: 'daughter', name: 'Дочь', role: 'child' },
  { id: 'son', name: 'Сын', role: 'child' },
];

// ---------- Хранилище ----------
let db;

function freshDb() {
  return {
    version: 1,
    setupDone: false,
    members: DEFAULT_MEMBERS.map((m) => ({ ...m })),
    tasks: DEFAULT_TASKS.map((t) => ({ active: true, weekly: false, noteRequired: false, parentOnly: false, ...t })),
    entries: [],
    payouts: [],
    sessions: {},
  };
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Миграция: добавляем новые дела из каталога, если их ещё нет
    for (const t of DEFAULT_TASKS) {
      if (!db.tasks.find((x) => x.id === t.id)) {
        db.tasks.push({ active: true, weekly: false, noteRequired: false, parentOnly: false, ...t });
      }
    }
    db.sessions ||= {};
  } else {
    db = freshDb();
    saveDb();
  }
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

// Ежедневная резервная копия (хранятся последние 14)
function dailyBackup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `db-${todayStr()}.json`);
    if (!fs.existsSync(file) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, file);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('db-')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) {
    console.error('backup failed', e);
  }
}

// ---------- Утилиты ----------
const id = () => crypto.randomBytes(8).toString('hex');

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function checkPin(member, pin) {
  if (!member.pin) return false;
  const { hash } = hashPin(pin, member.pin.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(member.pin.hash, 'hex'));
}

function todayStr() {
  // YYYY-MM-DD в часовом поясе семьи
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function dayNum(dateStr) {
  return Math.round(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
}

function numToDate(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function publicMember(m) {
  return { id: m.id, name: m.name, role: m.role };
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

// Конфликт с ограничением «не чаще раза в неделю» (общий на всю семью, скользящие 7 дней)
function weeklyConflict(task, date, excludeId) {
  if (!task.weekly) return null;
  const d = dayNum(date);
  const hit = db.entries.find((e) => e.taskId === task.id && e.id !== excludeId && Math.abs(dayNum(e.date) - d) < 7);
  if (!hit) return null;
  const who = db.members.find((m) => m.id === hit.memberId);
  return { entry: hit, who: who ? who.name : '?', nextDate: numToDate(dayNum(hit.date) + 7) };
}

// ---------- Живые обновления (SSE) ----------
const clients = new Set();

function broadcast(event) {
  const data = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

// ---------- HTTP-хелперы ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionMember(req) {
  const token = parseCookies(req).ft_session;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_DAYS * 86400000) {
    delete db.sessions[token];
    return null;
  }
  return db.members.find((m) => m.id === s.memberId) || null;
}

function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `ft_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// Защита от перебора PIN
const attempts = new Map();
function loginBlocked(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function loginFailed(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) {
    a.until = Date.now() + 60000 * Math.min(10, a.count - 4);
  }
  attempts.set(key, a);
}

// ---------- API ----------
function statePayload(me) {
  return {
    me: publicMember(me),
    today: todayStr(),
    members: db.members.map(publicMember),
    tasks: db.tasks,
    entries: db.entries,
    payouts: db.payouts,
  };
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/public') {
    return send(res, 200, { setupDone: db.setupDone, members: db.members.map(publicMember), today: todayStr() });
  }

  if (route === 'POST /api/setup') {
    if (db.setupDone) return fail(res, 409, 'Приложение уже настроено');
    const body = await readBody(req);
    const list = Array.isArray(body.members) ? body.members : [];
    for (const m of db.members) {
      const inp = list.find((x) => x.id === m.id) || {};
      const name = String(inp.name || '').trim().slice(0, 30);
      if (!name) return fail(res, 400, 'Укажите все имена');
      if (!validPin(inp.pin)) return fail(res, 400, `PIN для «${name}» должен состоять из 4 цифр`);
    }
    for (const m of db.members) {
      const inp = list.find((x) => x.id === m.id);
      m.name = String(inp.name).trim().slice(0, 30);
      m.pin = hashPin(inp.pin);
    }
    db.setupDone = true;
    saveDb();
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/login') {
    const body = await readBody(req);
    const member = db.members.find((m) => m.id === body.memberId);
    if (!member) return fail(res, 404, 'Нет такого участника');
    const key = `${req.socket.remoteAddress}|${member.id}`;
    const wait = loginBlocked(key);
    if (wait) return fail(res, 429, `Слишком много попыток. Подождите ${wait} сек.`);
    if (!checkPin(member, String(body.pin || ''))) {
      loginFailed(key);
      return fail(res, 401, 'Неверный PIN');
    }
    attempts.delete(key);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { memberId: member.id, createdAt: Date.now() };
    saveDb();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (route === 'POST /api/logout') {
    const token = parseCookies(req).ft_session;
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      saveDb();
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // --- всё ниже требует входа ---
  const me = sessionMember(req);
  if (!me) return fail(res, 401, 'Нужно войти');
  const isParent = me.role === 'parent';

  if (route === 'GET /api/state') return send(res, 200, statePayload(me));

  if (route === 'GET /api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (route === 'POST /api/entries') {
    const b = await readBody(req);
    const task = db.tasks.find((t) => t.id === b.taskId);
    if (!task || !task.active) return fail(res, 400, 'Неизвестное дело');
    if (task.parentOnly && !isParent) return fail(res, 403, 'Это может добавить только родитель');

    let memberId = me.id;
    if (isParent) {
      const target = db.members.find((m) => m.id === b.memberId && m.role === 'child');
      if (!target) return fail(res, 400, 'Выберите, за кого добавить');
      memberId = target.id;
    } else if (me.role !== 'child') {
      return fail(res, 403, 'Нет доступа');
    }

    const today = todayStr();
    const date = b.date || today;
    if (!isDate(date)) return fail(res, 400, 'Неверная дата');
    const diff = dayNum(today) - dayNum(date);
    if (diff < -1) return fail(res, 400, 'Нельзя отметить дело в будущем');
    if (diff > MAX_BACKDATE_DAYS) return fail(res, 400, `Можно отметить дело не старше ${MAX_BACKDATE_DAYS} дней`);

    const note = String(b.note || '').trim().slice(0, 300);
    if (task.noteRequired && !note) return fail(res, 400, 'Добавьте короткое описание');

    const entry = {
      id: id(),
      memberId,
      taskId: task.id,
      taskName: task.name,
      icon: task.icon,
      type: task.type,
      price: task.price,
      date,
      note,
      createdAt: new Date().toISOString(),
      createdBy: me.id,
      payoutId: null,
    };

    let amount;
    if (task.type === 'fixed') {
      const qty = Math.round(Number(b.qty) || 1);
      if (qty < 1 || qty > 10) return fail(res, 400, 'Количество от 1 до 10');
      if (task.weekly && qty !== 1) return fail(res, 400, 'Это дело можно отметить только один раз');
      entry.qty = qty;
      amount = task.price * qty;
    } else if (task.type === 'hourly') {
      const hours = Math.round(Number(b.hours) * 4) / 4;
      if (!(hours >= 0.25 && hours <= 12)) return fail(res, 400, 'Укажите время от 15 минут до 12 часов');
      entry.hours = hours;
      amount = task.price * hours;
    } else if (task.type === 'percent') {
      const receipt = Math.round(Number(b.receipt) * 100) / 100;
      if (!(receipt > 0 && receipt <= 10000)) return fail(res, 400, 'Укажите сумму чека');
      entry.receipt = receipt;
      amount = (receipt * task.price) / 100;
    } else if (task.type === 'custom') {
      const sum = Math.round(Number(b.amount) * 100) / 100;
      if (!(sum > 0 && sum <= 10000)) return fail(res, 400, 'Укажите сумму');
      amount = sum;
    } else return fail(res, 400, 'Неизвестный тип дела');

    const conflict = weeklyConflict(task, date);
    if (conflict) {
      return fail(res, 409, `«${task.name}» уже отмечено (${conflict.who}, ${conflict.entry.date}). Не чаще раза в неделю — снова можно с ${conflict.nextDate}`);
    }

    entry.amountAg = Math.round(amount * 100);
    db.entries.push(entry);
    saveDb();
    broadcast({ kind: 'entry', by: me.id, memberId, text: `${task.icon} ${task.name}`, amountAg: entry.amountAg });
    return send(res, 200, { ok: true, entry });
  }

  let m;
  if (req.method === 'DELETE' && (m = url.pathname.match(/^\/api\/entries\/([a-f0-9]+)$/))) {
    const idx = db.entries.findIndex((e) => e.id === m[1]);
    if (idx < 0) return fail(res, 404, 'Запись не найдена');
    const e = db.entries[idx];
    if (e.payoutId) return fail(res, 409, 'Запись уже выплачена — сначала отмените выплату');
    if (!isParent && e.memberId !== me.id) return fail(res, 403, 'Можно удалять только свои записи');
    db.entries.splice(idx, 1);
    saveDb();
    broadcast({ kind: 'entry-deleted', by: me.id, memberId: e.memberId });
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/payouts') {
    if (!isParent) return fail(res, 403, 'Только для родителя');
    const b = await readBody(req);
    const child = db.members.find((x) => x.id === b.memberId && x.role === 'child');
    if (!child) return fail(res, 400, 'Неизвестный участник');
    const unpaid = db.entries.filter((e) => e.memberId === child.id && !e.payoutId);
    if (!unpaid.length) return fail(res, 400, 'Нечего выплачивать');
    const payout = {
      id: id(),
      memberId: child.id,
      amountAg: unpaid.reduce((s, e) => s + e.amountAg, 0),
      count: unpaid.length,
      entryIds: unpaid.map((e) => e.id),
      createdAt: new Date().toISOString(),
      note: String(b.note || '').trim().slice(0, 200),
    };
    for (const e of unpaid) e.payoutId = payout.id;
    db.payouts.push(payout);
    saveDb();
    broadcast({ kind: 'payout', by: me.id, memberId: child.id, amountAg: payout.amountAg });
    return send(res, 200, { ok: true, payout });
  }

  if (req.method === 'DELETE' && (m = url.pathname.match(/^\/api\/payouts\/([a-f0-9]+)$/))) {
    if (!isParent) return fail(res, 403, 'Только для родителя');
    const idx = db.payouts.findIndex((p) => p.id === m[1]);
    if (idx < 0) return fail(res, 404, 'Выплата не найдена');
    const p = db.payouts[idx];
    for (const e of db.entries) if (e.payoutId === p.id) e.payoutId = null;
    db.payouts.splice(idx, 1);
    saveDb();
    broadcast({ kind: 'payout-undone', by: me.id, memberId: p.memberId });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && (m = url.pathname.match(/^\/api\/members\/([a-z]+)$/))) {
    const target = db.members.find((x) => x.id === m[1]);
    if (!target) return fail(res, 404, 'Нет такого участника');
    if (!isParent && target.id !== me.id) return fail(res, 403, 'Нет доступа');
    const b = await readBody(req);
    if (b.name !== undefined) {
      if (!isParent) return fail(res, 403, 'Имя меняет родитель');
      const name = String(b.name).trim().slice(0, 30);
      if (!name) return fail(res, 400, 'Пустое имя');
      target.name = name;
    }
    if (b.pin !== undefined && b.pin !== '') {
      if (!validPin(b.pin)) return fail(res, 400, 'PIN — 4 цифры');
      if (!isParent && !checkPin(me, String(b.oldPin || ''))) return fail(res, 401, 'Текущий PIN неверный');
      target.pin = hashPin(b.pin);
    }
    saveDb();
    broadcast({ kind: 'members', by: me.id });
    return send(res, 200, { ok: true });
  }

  if (route === 'PUT /api/tasks') {
    if (!isParent) return fail(res, 403, 'Только для родителя');
    const b = await readBody(req);
    const list = Array.isArray(b.tasks) ? b.tasks : [];
    for (const upd of list) {
      const t = db.tasks.find((x) => x.id === upd.id);
      if (!t) continue;
      if (upd.price !== undefined && t.type !== 'custom') {
        const p = Math.round(Number(upd.price) * 100) / 100;
        if (!(p >= 0 && p <= 10000)) return fail(res, 400, `Неверная цена для «${t.name}»`);
        t.price = p;
      }
      if (upd.weekly !== undefined) t.weekly = !!upd.weekly;
      if (upd.active !== undefined && t.id !== 'bonus') t.active = !!upd.active;
    }
    saveDb();
    broadcast({ kind: 'tasks', by: me.id });
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/export') {
    if (!isParent) return fail(res, 403, 'Только для родителя');
    const { sessions, ...rest } = db;
    const safe = { ...rest, members: db.members.map(publicMember) };
    return send(res, 200, JSON.stringify(safe, null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="family-tasks-${todayStr()}.json"`,
    });
  }

  return fail(res, 404, 'Не найдено');
}

// ---------- Статика ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(target);
    fs.readFile(target, (err2, buf) => {
      if (err2) return fail(res, 404, 'not found');
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    });
  });
}

// ---------- Запуск ----------
function main() {
  loadDb();

  // CLI: node server.js --reset-pin <memberId> <pin>
  const ri = process.argv.indexOf('--reset-pin');
  if (ri > -1) {
    const [mid, pin] = process.argv.slice(ri + 1);
    const member = db.members.find((x) => x.id === mid);
    if (!member || !validPin(pin)) {
      console.error('Использование: node server.js --reset-pin <dad|daughter|son> <PIN из 4 цифр>');
      process.exit(1);
    }
    member.pin = hashPin(pin);
    saveDb();
    console.log(`PIN для «${member.name}» обновлён`);
    process.exit(0);
  }

  dailyBackup();
  setInterval(dailyBackup, 3600000).unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else fail(res, 405, 'method not allowed');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) fail(res, 400, e.message === 'bad json' ? 'Неверный запрос' : 'Ошибка сервера');
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Семейные дела: http://localhost:${PORT}  (данные: ${DB_FILE})`);
  });
}

main();
