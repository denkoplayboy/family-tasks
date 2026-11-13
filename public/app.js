'use strict';

// ================= Состояние и утилиты =================
const S = {
  pub: null,
  me: null,
  today: '',
  members: [],
  tasks: [],
  entries: [],
  payouts: [],
  tab: 'home',
  period: '30',
  openDetails: {},
};

const root = document.getElementById('root');
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка сети');
    err.status = res.status;
    throw err;
  }
  return data;
}

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (ag) => `${nf.format(ag / 100)} ₪`;
const moneyShort = (v) => `${nf0.format(v)} ₪`;

const dn = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000);
const nd = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const dow = (n) => (((n + 4) % 7) + 7) % 7; // 0 = воскресенье
const weekStart = (n) => n - dow(n); // неделя в Израиле начинается с воскресенья
const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function fmtDate(d, { rel = true } = {}) {
  const n = dn(d);
  const t = dn(S.today);
  if (rel && n === t) return 'сегодня';
  if (rel && n === t - 1) return 'вчера';
  const [y, m, day] = d.split('-').map(Number);
  const yr = y !== Number(S.today.slice(0, 4)) ? ` ${y}` : '';
  return `${day} ${MONTHS[m - 1]}${yr}`;
}
const shortDate = (d) => {
  const [, m, day] = d.split('-').map(Number);
  return `${day}.${String(m).padStart(2, '0')}`;
};
function fmtRange(a, b) {
  const [, ma, da] = a.split('-').map(Number);
  const [, mb, db] = b.split('-').map(Number);
  return ma === mb ? `${da}–${db} ${MONTHS[mb - 1]}` : `${da} ${MONTHS[ma - 1]} – ${db} ${MONTHS[mb - 1]}`;
}
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const tasksWord = (n) => `${n} ${plural(n, 'дело', 'дела', 'дел')}`;
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

const member = (id) => S.members.find((m) => m.id === id) || { id, name: '?', role: 'child' };
const kids = () => S.members.filter((m) => m.role === 'child');
const isParent = () => S.me && S.me.role === 'parent';
const colorVar = (id) => `var(--m-${id})`;
const avatar = (m, cls = '') => `<span class="avatar ${cls} c-${h(m.id)}">${h((m.name || '?')[0].toUpperCase())}</span>`;
const sum = (list) => list.reduce((s, e) => s + e.amountAg, 0);
const unpaidOf = (id) => S.entries.filter((e) => e.memberId === id && !e.payoutId);

function entryDetail(e) {
  const parts = [];
  if (e.type === 'fixed' && e.qty > 1) parts.push(`×${e.qty}`);
  if (e.type === 'hourly') parts.push(`${nf.format(e.hours)} ч`);
  if (e.type === 'percent') parts.push(`чек ${nf.format(e.receipt)} ₪`);
  if (e.note) parts.push(e.note);
  return parts.join(' · ');
}

function unitLabel(t) {
  if (t.type === 'hourly') return `${nf.format(t.price)} ₪/час`;
  if (t.type === 'percent') return `${nf.format(t.price)}% от чека`;
  if (t.type === 'custom') return 'любая сумма';
  return `${nf.format(t.price)} ₪`;
}

// Блокировка «не чаще раза в неделю» — общая на всю семью
function weeklyLock(task, date = S.today) {
  if (!task.weekly) return null;
  const d = dn(date);
  const hit = S.entries.find((e) => e.taskId === task.id && Math.abs(dn(e.date) - d) < 7);
  if (!hit) return null;
  return { entry: hit, who: member(hit.memberId).name, next: nd(dn(hit.date) + 7), days: dn(hit.date) + 7 - d };
}

function streak(id) {
  const days = new Set(S.entries.filter((e) => e.memberId === id).map((e) => dn(e.date)));
  let t = dn(S.today);
  if (!days.has(t)) t -= 1; // серия не сгорает, пока сегодня ещё не закончилось
  let n = 0;
  while (days.has(t)) {
    n++;
    t--;
  }
  return n;
}

function weekTotals(startN) {
  return kids().map((k) => {
    const list = S.entries.filter((e) => e.memberId === k.id && e.taskId !== 'bonus' && dn(e.date) >= startN && dn(e.date) < startN + 7);
    return { m: k, amount: sum(list), count: list.length };
  });
}

// ================= Тосты и шторки =================
function toast(msg, err = false) {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 3200);
}

function openSheet(html, mount) {
  closeSheet();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov) closeSheet();
  });
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  mount && mount($('.sheet', ov));
  return ov;
}
function closeSheet() {
  $$('.overlay').forEach((o) => o.remove());
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

function confirmSheet({ title, text, ok = 'Да', danger = false }) {
  return new Promise((resolve) => {
    openSheet(
      `<h2>${h(title)}</h2><p class="lead">${text}</p>
       <div class="row"><button class="btn block" data-no>Отмена</button><button class="btn block ${danger ? 'danger' : 'primary'}" data-yes>${h(ok)}</button></div>`,
      (sh) => {
        $('[data-no]', sh).onclick = () => (closeSheet(), resolve(false));
        $('[data-yes]', sh).onclick = () => (closeSheet(), resolve(true));
      }
    );
  });
}

// ================= Иконки =================
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12v4"/><path d="M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  house: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21 24 7l17 14v18a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path d="m17 28 5 5 9-10"/></svg>',
};

// ================= Экран настройки =================
function renderSetup() {
  const roles = { dad: 'Папа', daughter: 'Ника', son: 'Денис' };
  root.innerHTML = `
  <div class="center-screen"><div class="login">
    <div class="brand">${I.house}</div>
    <h1>Добро пожаловать</h1>
    <p class="lead">Пара минут настройки. Имена и PIN-коды потом можно поменять в настройках.</p>
    <form class="card stack" id="setup">
      ${S.pub.members
        .map(
          (m) => `<div class="setup-row">
          ${avatar(m)}
          <label><small>${roles[m.id] || m.role}</small><input class="input" name="name-${m.id}" value="${h(m.name)}" maxlength="30" required></label>
          <label><small>PIN</small><input class="input" name="pin-${m.id}" inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="••••" required autocomplete="off"></label>
        </div>`
        )
        .join('')}
      <div class="err-text" id="setup-err"></div>
      <button class="btn primary block" type="submit">Начать</button>
      <div class="hint">PIN — 4 цифры. Каждый вводит его на своём устройстве один раз.</div>
    </form>
  </div></div>`;
  $('#setup').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const members = S.pub.members.map((m) => ({ id: m.id, name: fd.get('name-' + m.id), pin: fd.get('pin-' + m.id) }));
    try {
      await api('POST', '/api/setup', { members });
      toast('Готово! Теперь войдите');
      boot();
    } catch (err) {
      $('#setup-err').textContent = err.message;
    }
  };
}

// ================= Вход =================
function renderLogin() {
  const desc = { parent: 'Панель выплат', child: 'Отмечать дела' };
  root.innerHTML = `
  <div class="center-screen"><div class="login">
    <div class="brand">${I.house}</div>
    <h1>Наш дом</h1>
    <p class="lead">Кто заходит?</p>
    <div class="who">
      ${S.pub.members
        .map((m) => `<button data-id="${h(m.id)}">${avatar(m, 'lg')}<div><b>${h(m.name)}</b><span>${desc[m.role]}</span></div></button>`)
        .join('')}
    </div>
  </div></div>`;
  $$('.who button').forEach((b) => (b.onclick = () => renderPin(b.dataset.id)));
}

function renderPin(id) {
  const m = S.pub.members.find((x) => x.id === id);
  let pin = '';
  root.innerHTML = `
  <div class="center-screen"><div class="login">
    ${avatar(m, 'lg')}
    <h1 style="margin-top:12px">${h(m.name)}</h1>
    <p class="lead" style="margin-bottom:0">Введите PIN</p>
    <div class="pin-dots">${'<i></i>'.repeat(4)}</div>
    <div class="err-text" id="pin-err"></div>
    <div class="pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button data-d="${d}">${d}</button>`).join('')}
      <button class="fn" data-back-login>Назад</button><button data-d="0">0</button><button class="fn" data-del>⌫</button>
    </div>
  </div></div>`;
  const dots = $('.pin-dots');
  const paint = () => $$('i', dots).forEach((el, i) => el.classList.toggle('on', i < pin.length));
  const submit = async () => {
    try {
      await api('POST', '/api/login', { memberId: id, pin });
      await boot();
    } catch (err) {
      pin = '';
      paint();
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      $('#pin-err').textContent = err.message;
    }
  };
  const press = (d) => {
    if (pin.length >= 4) return;
    pin += d;
    paint();
    if (pin.length === 4) setTimeout(submit, 120);
  };
  $$('[data-d]').forEach((b) => (b.onclick = () => press(b.dataset.d)));
  $('[data-del]').onclick = () => ((pin = pin.slice(0, -1)), paint());
  $('[data-back-login]').onclick = renderLogin;
  document.onkeydown = (e) => {
    if (!$('.pad')) return (document.onkeydown = null);
    if (/^\d$/.test(e.key)) press(e.key);
    if (e.key === 'Backspace') (pin = pin.slice(0, -1)), paint();
  };
}

// ================= Каркас приложения =================
function tabsFor() {
  return isParent()
    ? [
        ['home', 'Главная', I.home],
        ['pay', 'Выплаты', I.wallet],
        ['stats', 'Рейтинг', I.chart],
        ['settings', 'Настройки', I.gear],
      ]
    : [
        ['home', 'Главная', I.home],
        ['add', 'Отметить', I.plus],
        ['stats', 'Рейтинг', I.chart],
        ['history', 'История', I.list],
      ];
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Доброй ночи';
  if (hr < 12) return 'Доброе утро';
  if (hr < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function renderApp() {
  const tabs = tabsFor();
  if (!tabs.find((t) => t[0] === S.tab)) S.tab = 'home';
  const scroll = window.scrollY;
  const titles = { home: `${greeting()}, ${S.me.name}`, add: 'Что сделано?', stats: 'Рейтинг', history: 'Моя история', pay: 'Выплаты', settings: 'Настройки' };
  root.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div><h1>${h(titles[S.tab])}</h1><div class="sub">${h(subtitle())}</div></div>
      <button class="avatar c-${h(S.me.id)}" id="profile" aria-label="Профиль">${h(S.me.name[0].toUpperCase())}</button>
    </header>
    <main class="stack" id="view"></main>
  </div>
  <nav class="nav">${tabs
    .map(([id, label, icon]) => `<button data-tab="${id}" class="${id === S.tab ? 'on' : ''} ${id === 'add' ? 'plus' : ''}">${icon}<span>${label}</span></button>`)
    .join('')}</nav>`;
  $$('.nav button').forEach(
    (b) =>
      (b.onclick = () => {
        S.tab = b.dataset.tab;
        renderApp();
        window.scrollTo(0, 0);
      })
  );
  $('#profile').onclick = openProfile;
  const view = $('#view');
  ({ home: viewHome, add: viewAdd, stats: viewStats, history: viewHistory, pay: viewPay, settings: viewSettings })[S.tab](view);
  window.scrollTo(0, scroll);
}

function subtitle() {
  const n = dn(S.today);
  const ws = weekStart(n);
  return `${DAYS[dow(n)]}, ${fmtDate(S.today, { rel: false })} · неделя ${fmtRange(nd(ws), nd(ws + 6))}`;
}

// ================= Главная =================
function viewHome(v) {
  const n = dn(S.today);
  const ws = weekStart(n);
  let hero;
  if (isParent()) {
    const total = kids().reduce((s, k) => s + sum(unpaidOf(k.id)), 0);
    hero = `<section class="card hero">
      <div class="eyebrow">К выплате всего</div>
      <div class="hero-num num">${money(total)}</div>
      <div class="split">${kids()
        .map((k) => {
          const u = unpaidOf(k.id);
          return `<div class="split-item">${avatar(k, 'sm')}<div><b class="num">${money(sum(u))}</b><span>${h(k.name)} · ${tasksWord(u.length)}</span></div></div>`;
        })
        .join('')}</div>
      <div class="chips"><button class="btn primary" data-go="pay">Открыть выплаты</button></div>
    </section>`;
  } else {
    const u = unpaidOf(S.me.id);
    const wk = S.entries.filter((e) => e.memberId === S.me.id && dn(e.date) >= ws);
    const st = streak(S.me.id);
    const lastPay = S.payouts.filter((p) => p.memberId === S.me.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    hero = `<section class="card hero">
      <div class="eyebrow">Заработано и ещё не выплачено</div>
      <div class="hero-num num">${money(sum(u))}</div>
      <div class="hero-sub">На этой неделе: <b class="num">${money(sum(wk))}</b> · ${tasksWord(wk.length)}</div>
      <div class="chips">
        ${st ? `<span class="chip">🔥 Серия: ${daysWord(st)}</span>` : `<span class="chip">Отметь дело сегодня — начнётся серия 🔥</span>`}
        ${lastPay ? `<span class="chip">Последняя выплата: ${money(lastPay.amountAg)}, ${fmtDate(lastPay.createdAt.slice(0, 10))}</span>` : ''}
      </div>
    </section>`;
  }

  v.innerHTML =
    hero +
    battleCard(ws) +
    (isParent() ? '' : quickAdd()) +
    `<section class="card"><div class="card-head"><h2 class="card-title">Лента</h2><span class="card-note">последние дела</span></div>${feed(
      [...S.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
    )}</section>`;

  $$('[data-go]', v).forEach((b) => (b.onclick = () => ((S.tab = b.dataset.go), renderApp())));
  bindTaskTiles(v);
}

function battleCard(ws) {
  const rows = weekTotals(ws);
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  const leader = sorted[0] && sorted[0].amount > 0 && sorted[0].amount !== (sorted[1] || {}).amount ? sorted[0].m.id : null;
  const prev = weekTotals(ws - 7).sort((a, b) => b.amount - a.amount);
  const prevChamp = prev[0] && prev[0].amount > 0 && prev[0].amount !== (prev[1] || {}).amount ? prev[0] : null;
  const daysLeft = ws + 7 - dn(S.today);

  let foot;
  if (!sorted[0] || sorted[0].amount === 0) foot = 'Неделя только началась — кто первый?';
  else if (!leader) foot = 'Ничья! Решает следующее дело.';
  else {
    const gap = sorted[0].amount - (sorted[1] ? sorted[1].amount : 0);
    foot = `${h(sorted[0].m.name)} впереди на <b class="num">${money(gap)}</b>. До конца недели ${daysWord(daysLeft)}.`;
  }
  if (prevChamp) foot += ` <br>Прошлая неделя: 👑 ${h(prevChamp.m.name)} (${money(prevChamp.amount)})`;

  return `<section class="card">
    <div class="card-head"><h2 class="card-title">Битва недели</h2><span class="card-note">${fmtRange(nd(ws), nd(ws + 6))}</span></div>
    ${rows
      .map(
        (r) => `<div class="battle-row c-${h(r.m.id)}">
        ${avatar(r.m)}
        <div><div class="battle-name">${h(r.m.name)} ${leader === r.m.id ? '<span class="crown" title="Лидер недели">👑</span>' : ''}</div>
          <div class="battle-track"><div class="battle-bar" style="width:${(r.amount / max) * 100}%"></div></div></div>
        <div class="battle-sum num">${money(r.amount)}<small>${tasksWord(r.count)}</small></div>
      </div>`
      )
      .join('')}
    <div class="battle-foot">${foot}</div>
  </section>`;
}

function feed(list, { showWho = true, deletable = false } = {}) {
  if (!list.length) return `<div class="empty">Пока пусто. Самое время что-нибудь сделать ✨</div>`;
  return `<ul class="feed">${list
    .map((e) => {
      const m = member(e.memberId);
      const det = entryDetail(e);
      const canDel = deletable && !e.payoutId && (isParent() || e.memberId === S.me.id);
      return `<li>
        <div class="feed-icon">${h(e.icon)}</div>
        <div class="feed-main">
          <div class="feed-title">${h(e.taskName)}</div>
          <div class="feed-meta">${showWho ? `<span class="dot c-${h(m.id)}" style="width:8px;height:8px"></span> ${h(m.name)} · ` : ''}${fmtDate(e.date)}${det ? ' · ' + h(det) : ''}</div>
        </div>
        <div class="feed-amt num ${e.payoutId ? 'paid' : ''}">+${money(e.amountAg)}</div>
        ${canDel ? `<button class="icon-btn" data-del="${h(e.id)}" aria-label="Удалить">${I.x}</button>` : ''}
      </li>`;
    })
    .join('')}</ul>`;
}

function bindDeletes(v) {
  $$('[data-del]', v).forEach(
    (b) =>
      (b.onclick = async () => {
        const e = S.entries.find((x) => x.id === b.dataset.del);
        if (!e) return;
        const ok = await confirmSheet({
          title: 'Удалить запись?',
          text: `${h(e.icon)} ${h(e.taskName)}, ${fmtDate(e.date)} — ${money(e.amountAg)}`,
          ok: 'Удалить',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('DELETE', '/api/entries/' + e.id);
          await refresh();
          toast('Запись удалена');
        } catch (err) {
          toast(err.message, true);
        }
      })
  );
}

// ================= Отметить дело =================
function taskTiles(list) {
  return `<div class="tasks">${list
    .map((t) => {
      const lock = weeklyLock(t);
      return `<button class="task ${lock ? 'locked' : ''}" data-task="${h(t.id)}">
        <span class="task-icon">${h(t.icon)}</span>
        <span class="task-name">${h(t.name)}</span>
        <span class="task-price">${lock ? `🔒 через ${daysWord(lock.days)}` : unitLabel(t) + (t.weekly ? ' · раз в неделю' : '')}</span>
      </button>`;
    })
    .join('')}</div>`;
}

function availableTasks() {
  return S.tasks.filter((t) => t.active && (!t.parentOnly || isParent()));
}

function quickAdd() {
  // самые частые дела этого участника
  const counts = {};
  S.entries.filter((e) => e.memberId === S.me.id).forEach((e) => (counts[e.taskId] = (counts[e.taskId] || 0) + 1));
  const list = availableTasks()
    .slice()
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0))
    .slice(0, 4);
  return `<div class="section-label">Быстро отметить</div>${taskTiles(list)}`;
}

function viewAdd(v) {
  v.innerHTML = `<p class="hint" style="margin:0 4px">Выберите, что сделали. Подметание и мытьё полов — не чаще раза в неделю на всю семью: кто первый, тот и молодец.</p>${taskTiles(
    availableTasks()
  )}`;
  bindTaskTiles(v);
}

function bindTaskTiles(v, forMember) {
  $$('[data-task]', v).forEach(
    (b) =>
      (b.onclick = () => {
        const t = S.tasks.find((x) => x.id === b.dataset.task);
        const lock = weeklyLock(t);
        if (lock && !isParent()) {
          toast(`Уже сделано: ${lock.who}, ${fmtDate(lock.entry.date)}. Снова можно с ${fmtDate(lock.next, { rel: false })}`, true);
          return;
        }
        openAddSheet(t, forMember);
      })
  );
}

function openAddSheet(task, forMember) {
  const st = { date: S.today, qty: 1, hours: 1, receipt: '', amount: '', note: '', memberId: forMember || (isParent() ? kids()[0].id : S.me.id) };
  const n = dn(S.today);
  const dateOpts = [
    [S.today, 'Сегодня'],
    [nd(n - 1), 'Вчера'],
    [nd(n - 2), 'Позавчера'],
  ];

  const calc = () => {
    if (task.type === 'fixed') return task.price * st.qty;
    if (task.type === 'hourly') return task.price * st.hours;
    if (task.type === 'percent') return ((Number(st.receipt) || 0) * task.price) / 100;
    return Number(st.amount) || 0;
  };

  const body = () => {
    let f = '';
    if (isParent()) {
      f += `<label class="field"><span>За кого</span><div class="pills">${kids()
        .map((k) => `<button type="button" class="pill ${st.memberId === k.id ? 'on' : ''}" data-mem="${h(k.id)}">${h(k.name)}</button>`)
        .join('')}</div></label>`;
    }
    f += `<div class="field"><span>Когда</span><div class="pills">${dateOpts
      .map(([d, l]) => `<button type="button" class="pill ${st.date === d ? 'on' : ''}" data-date="${d}">${l}</button>`)
      .join('')}<input type="date" class="input" style="width:auto;padding:6px 10px" value="${st.date}" max="${S.today}" min="${nd(n - 30)}" data-datepick></div></div>`;
    if (task.type === 'fixed' && !task.weekly)
      f += `<div class="field"><span>Сколько раз</span><div class="stepper"><button type="button" data-q="-1">−</button><b class="num">${st.qty}</b><button type="button" data-q="1">+</button></div></div>`;
    if (task.type === 'hourly')
      f += `<div class="field"><span>Сколько времени</span><div class="stepper"><button type="button" data-hr="-0.5">−</button><b class="num">${nf.format(st.hours)} ч</b><button type="button" data-hr="0.5">+</button></div>
        <div class="pills">${[0.5, 1, 1.5, 2, 3].map((x) => `<button type="button" class="pill ${st.hours === x ? 'on' : ''}" data-hset="${x}">${nf.format(x)} ч</button>`).join('')}</div></div>`;
    if (task.type === 'percent')
      f += `<label class="field"><span>Сумма чека, ₪</span><input class="input" inputmode="decimal" data-receipt placeholder="например, 245" value="${h(st.receipt)}"></label>`;
    if (task.type === 'custom')
      f += `<label class="field"><span>Сумма бонуса, ₪</span><input class="input" inputmode="decimal" data-amount placeholder="например, 50" value="${h(st.amount)}"></label>`;
    f += `<label class="field"><span>${task.noteRequired ? 'Что именно сделано' : 'Комментарий (необязательно)'}</span><textarea class="input" data-note maxlength="300" placeholder="${
      task.type === 'custom' ? 'За что бонус' : task.id === 'extra' ? 'Например: разобрал балкон' : ''
    }">${h(st.note)}</textarea></label>`;
    const lock = weeklyLock(task, st.date);
    if (lock) f += `<div class="err-text">Уже отмечено: ${h(lock.who)}, ${fmtDate(lock.entry.date)}. Раз в неделю — снова с ${fmtDate(lock.next, { rel: false })}.</div>`;
    f += `<div class="total-line"><span>Итого</span><b class="num">${money(Math.round(calc() * 100))}</b></div>
      <button class="btn primary block" data-save ${lock ? 'disabled' : ''}>Отметить</button>`;
    return f;
  };

  openSheet(
    `<div class="row" style="margin-bottom:6px"><span style="font-size:34px">${h(task.icon)}</span><div><h2>${h(task.name)}</h2><div class="hint">${unitLabel(task)}${
      task.weekly ? ' · не чаще раза в неделю' : ''
    }</div></div></div><div class="stack" style="margin-top:14px" data-body></div>`,
    (sh) => {
      const box = $('[data-body]', sh);
      const paint = () => {
        box.innerHTML = body();
        bind();
      };
      const bind = () => {
        $$('[data-mem]', box).forEach((b) => (b.onclick = () => ((st.memberId = b.dataset.mem), paint())));
        $$('[data-date]', box).forEach((b) => (b.onclick = () => ((st.date = b.dataset.date), paint())));
        const dp = $('[data-datepick]', box);
        dp.onchange = () => dp.value && ((st.date = dp.value), paint());
        $$('[data-q]', box).forEach((b) => (b.onclick = () => ((st.qty = Math.min(10, Math.max(1, st.qty + Number(b.dataset.q)))), paint())));
        $$('[data-hr]', box).forEach((b) => (b.onclick = () => ((st.hours = Math.min(12, Math.max(0.5, st.hours + Number(b.dataset.hr)))), paint())));
        $$('[data-hset]', box).forEach((b) => (b.onclick = () => ((st.hours = Number(b.dataset.hset)), paint())));
        const upd = (sel, key) => {
          const el = $(sel, box);
          if (el) el.oninput = () => {
            st[key] = el.value.replace(',', '.');
            $('.total-line b', box).textContent = money(Math.round(calc() * 100));
          };
        };
        upd('[data-receipt]', 'receipt');
        upd('[data-amount]', 'amount');
        const note = $('[data-note]', box);
        note.oninput = () => (st.note = note.value);
        $('[data-save]', box).onclick = async (e) => {
          e.target.disabled = true;
          try {
            await api('POST', '/api/entries', {
              taskId: task.id,
              memberId: st.memberId,
              date: st.date,
              qty: st.qty,
              hours: st.hours,
              receipt: st.receipt,
              amount: st.amount,
              note: st.note,
            });
            closeSheet();
            toast(`${task.icon} Отмечено: +${money(Math.round(calc() * 100))}`);
            await refresh();
          } catch (err) {
            toast(err.message, true);
            e.target.disabled = false;
          }
        };
      };
      paint();
    }
  );
}

// ================= Рейтинг и графики =================
function viewStats(v) {
  const n = dn(S.today);
  const periods = { 7: '7 дней', 30: '30 дней', all: 'Всё время' };
  const first = S.entries.length ? Math.min(...S.entries.map((e) => dn(e.date))) : n;
  const from = S.period === 'all' ? Math.min(first, n - 6) : n - Number(S.period) + 1;
  const inPeriod = S.entries.filter((e) => dn(e.date) >= from && dn(e.date) <= n);
  const K = kids();

  // Плитки
  const tiles = K.map((k) => {
    const list = inPeriod.filter((e) => e.memberId === k.id);
    const hours = list.filter((e) => e.type === 'hourly').reduce((s, e) => s + e.hours, 0);
    return `<div class="tile c-${h(k.id)}"><div class="tile-label"><span class="dot"></span>${h(k.name)}</div>
      <div class="tile-value num">${money(sum(list))}</div>
      <div class="tile-sub">${tasksWord(list.length)}${hours ? ` · ${nf.format(hours)} ч работы` : ''}</div></div>`;
  }).join('');

  const legend = `<div class="legend">${K.map((k) => `<span class="c-${h(k.id)}"><span class="dot"></span>${h(k.name)}</span>`).join('')}</div>`;

  // Кто что делает
  const byTask = S.tasks
    .map((t) => ({ t, counts: K.map((k) => inPeriod.filter((e) => e.taskId === t.id && e.memberId === k.id).length) }))
    .filter((x) => x.counts.some((c) => c > 0))
    .sort((a, b) => b.counts.reduce((s, c) => s + c, 0) - a.counts.reduce((s, c) => s + c, 0));
  const maxC = Math.max(1, ...byTask.flatMap((x) => x.counts));
  const whoDoes = byTask.length
    ? `<div class="who-does">${byTask
        .map(
          (x) => `<div class="wd-row"><div class="wd-icon">${h(x.t.icon)}</div><div><div class="wd-name">${h(x.t.name)}</div><div class="wd-bars">${K.map(
            (k, i) => `<div class="wd-bar c-${h(k.id)}"><i style="width:${(x.counts[i] / maxC) * 70}%"></i><span class="num">${x.counts[i]}</span></div>`
          ).join('')}</div></div></div>`
        )
        .join('')}</div>`
    : `<div class="empty">За этот период дел ещё нет</div>`;

  v.innerHTML = `
    <div class="row"><div class="seg">${Object.entries(periods)
      .map(([k, l]) => `<button data-p="${k}" class="${S.period === k ? 'on' : ''}">${l}</button>`)
      .join('')}</div></div>
    <div class="tiles">${tiles}</div>
    <section class="card"><div class="card-head"><h2 class="card-title">Заработано нарастающим итогом</h2></div>${legend}<div class="chart" id="ch-line"></div>
      <details class="table-toggle"><summary>Показать таблицей</summary><div id="tb-line"></div></details></section>
    <section class="card"><div class="card-head"><h2 class="card-title">По неделям</h2><span class="card-note">последние 8 недель</span></div>${legend}<div class="chart" id="ch-bars"></div>
      <details class="table-toggle"><summary>Показать таблицей</summary><div id="tb-bars"></div></details></section>
    <section class="card"><div class="card-head"><h2 class="card-title">Кто что делает</h2><span class="card-note">количество раз</span></div>${legend}<div style="margin-top:12px">${whoDoes}</div></section>
    ${records(K)}`;

  $$('[data-p]', v).forEach((b) => (b.onclick = () => ((S.period = b.dataset.p), renderApp())));

  // Линия
  const days = [];
  for (let d = from; d <= n; d++) days.push(d);
  const lineSeries = K.map((k) => {
    let acc = 0;
    const per = {};
    inPeriod.filter((e) => e.memberId === k.id).forEach((e) => (per[dn(e.date)] = (per[dn(e.date)] || 0) + e.amountAg));
    return { name: k.name, color: colorVar(k.id), values: days.map((d) => (acc += per[d] || 0) / 100) };
  });
  const dayLabels = days.map((d) => shortDate(nd(d)));
  const dayTips = days.map((d) => `${DAYS[dow(d)]}, ${fmtDate(nd(d))}`);
  Charts.line($('#ch-line'), { labels: dayLabels, tipLabels: dayTips, series: lineSeries, fmt: (x) => moneyShort(x) });
  $('#tb-line').innerHTML = dataTable(
    ['Дата', ...K.map((k) => k.name)],
    days.map((d, i) => [fmtDate(nd(d)), ...lineSeries.map((s) => moneyShort(s.values[i]))])
  );

  // Недели
  const ws = weekStart(n);
  const weeks = [];
  for (let i = 7; i >= 0; i--) weeks.push(ws - i * 7);
  const barSeries = K.map((k) => ({
    name: k.name,
    color: colorVar(k.id),
    values: weeks.map((w) => sum(S.entries.filter((e) => e.memberId === k.id && dn(e.date) >= w && dn(e.date) < w + 7)) / 100),
  }));
  Charts.bars($('#ch-bars'), {
    labels: weeks.map((w) => shortDate(nd(w))),
    tipLabels: weeks.map((w) => fmtRange(nd(w), nd(w + 6))),
    series: barSeries,
    fmt: (x) => moneyShort(x),
  });
  $('#tb-bars').innerHTML = dataTable(
    ['Неделя', ...K.map((k) => k.name)],
    weeks.map((w, i) => [fmtRange(nd(w), nd(w + 6)), ...barSeries.map((s) => moneyShort(s.values[i]))])
  );
}

function dataTable(head, rows) {
  return `<table class="data-table"><thead><tr>${head.map((x, i) => `<th class="${i ? 'n' : ''}">${h(x)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((x, i) => `<td class="${i ? 'n' : ''}">${h(x)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function records(K) {
  const items = K.map((k) => {
    const list = S.entries.filter((e) => e.memberId === k.id);
    if (!list.length) return '';
    const byDay = {};
    list.forEach((e) => (byDay[e.date] = (byDay[e.date] || 0) + e.amountAg));
    const [bestDay, bestSum] = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
    const byT = {};
    list.forEach((e) => (byT[e.taskName] = (byT[e.taskName] || 0) + 1));
    const [fav, favN] = Object.entries(byT).sort((a, b) => b[1] - a[1])[0];
    const total = sum(list);
    // Самая длинная серия
    const days = [...new Set(list.map((e) => dn(e.date)))].sort((a, b) => a - b);
    let best = 1,
      cur = 1;
    for (let i = 1; i < days.length; i++) {
      cur = days[i] === days[i - 1] + 1 ? cur + 1 : 1;
      best = Math.max(best, cur);
    }
    return `<div class="tile c-${h(k.id)}"><div class="tile-label"><span class="dot"></span>${h(k.name)}</div>
      <div class="tile-sub" style="margin-top:8px;line-height:1.7">
      Всего заработано: <b class="num">${money(total)}</b><br>
      Лучший день: <b>${fmtDate(bestDay)}</b> — ${money(bestSum)}<br>
      Любимое дело: <b>${h(fav)}</b> (${favN}×)<br>
      Рекордная серия: <b>${daysWord(best)}</b> 🔥</div></div>`;
  }).join('');
  return items ? `<div class="section-label">Рекорды</div><div class="tiles">${items}</div>` : '';
}

// ================= История (ребёнок) =================
function viewHistory(v) {
  const mine = S.entries.filter((e) => e.memberId === S.me.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const unpaid = mine.filter((e) => !e.payoutId);
  const pays = S.payouts.filter((p) => p.memberId === S.me.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  v.innerHTML = `
    <section class="card"><div class="card-head"><h2 class="card-title">Ожидает выплаты</h2><b class="num">${money(sum(unpaid))}</b></div>
      ${feed(unpaid, { showWho: false, deletable: true })}
      ${unpaid.length ? `<div class="hint" style="margin-top:8px">Ошиблись? Невыплаченную запись можно удалить крестиком.</div>` : ''}
    </section>
    <section class="card"><div class="card-head"><h2 class="card-title">Полученные выплаты</h2><span class="card-note">${pays.length}</span></div>
      ${
        pays.length
          ? `<ul class="feed">${pays
              .map(
                (p) => `<li><div class="feed-icon">💸</div><div class="feed-main"><div class="feed-title num">${money(p.amountAg)}</div>
            <div class="feed-meta">${fmtDate(p.createdAt.slice(0, 10))} · ${tasksWord(p.count)}</div></div>
            <button class="btn ghost" data-payview="${h(p.id)}">Детали</button></li>`
              )
              .join('')}</ul>`
          : `<div class="empty">Выплат пока не было</div>`
      }
    </section>`;
  bindDeletes(v);
  bindPayView(v);
}

function bindPayView(v) {
  $$('[data-payview]', v).forEach(
    (b) =>
      (b.onclick = () => {
        const p = S.payouts.find((x) => x.id === b.dataset.payview);
        const list = S.entries.filter((e) => e.payoutId === p.id).sort((a, b) => b.date.localeCompare(a.date));
        openSheet(
          `<h2>Выплата ${money(p.amountAg)}</h2><p class="lead">${h(member(p.memberId).name)} · ${fmtDate(p.createdAt.slice(0, 10), { rel: false })} · ${tasksWord(p.count)}</p>${feed(list, { showWho: false })}`
        );
      })
  );
}

// ================= Выплаты (родитель) =================
function viewPay(v) {
  const cards = kids()
    .map((k) => {
      const u = unpaidOf(k.id).sort((a, b) => b.date.localeCompare(a.date));
      const total = sum(u);
      const since = u.length ? u[u.length - 1].date : null;
      const open = S.openDetails[k.id];
      return `<section class="card c-${h(k.id)}">
        <div class="pay-head">${avatar(k, 'lg')}<div class="grow"><div class="eyebrow">${h(k.name)} · к выплате</div>
          <div class="pay-sum num">${money(total)}</div>
          <div class="hint">${u.length ? `${tasksWord(u.length)} · с ${fmtDate(since)}` : 'Всё выплачено'}</div></div></div>
        <div class="pay-actions">
          <button class="btn primary" data-payout="${h(k.id)}" ${u.length ? '' : 'disabled'}>Выплачено — обнулить</button>
          <button class="btn" data-toggle="${h(k.id)}" ${u.length ? '' : 'disabled'}>${open ? 'Скрыть детали' : 'Детали'}</button>
          <button class="btn ghost" data-addfor="${h(k.id)}">+ Дело или бонус</button>
        </div>
        ${open && u.length ? `<div class="details">${feed(u, { showWho: false, deletable: true })}</div>` : ''}
      </section>`;
    })
    .join('');

  const pays = [...S.payouts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  v.innerHTML =
    cards +
    `<section class="card"><div class="card-head"><h2 class="card-title">История выплат</h2><span class="card-note">всего ${money(sum(pays))}</span></div>
    ${
      pays.length
        ? `<ul class="feed">${pays
            .map((p) => {
              const m = member(p.memberId);
              return `<li>${avatar(m, 'sm')}<div class="feed-main"><div class="feed-title num">${money(p.amountAg)}</div>
            <div class="feed-meta">${h(m.name)} · ${fmtDate(p.createdAt.slice(0, 10))} · ${tasksWord(p.count)}</div></div>
            <button class="btn ghost" data-payview="${h(p.id)}">Детали</button>
            <button class="icon-btn" data-undo="${h(p.id)}" title="Отменить выплату" aria-label="Отменить выплату">↺</button></li>`;
            })
            .join('')}</ul>`
        : `<div class="empty">Выплат ещё не было</div>`
    }</section>`;

  $$('[data-toggle]', v).forEach((b) => (b.onclick = () => ((S.openDetails[b.dataset.toggle] = !S.openDetails[b.dataset.toggle]), renderApp())));
  $$('[data-addfor]', v).forEach((b) => (b.onclick = () => openTaskPicker(b.dataset.addfor)));
  $$('[data-payout]', v).forEach(
    (b) =>
      (b.onclick = async () => {
        const k = member(b.dataset.payout);
        const u = unpaidOf(k.id);
        const ok = await confirmSheet({
          title: `Выплатить ${money(sum(u))}?`,
          text: `${h(k.name)} получает деньги за ${tasksWord(u.length)}. Сумма обнулится, записи уйдут в историю выплат. Если ошиблись — выплату можно отменить.`,
          ok: 'Да, выплачено',
        });
        if (!ok) return;
        try {
          await api('POST', '/api/payouts', { memberId: k.id });
          S.openDetails[k.id] = false;
          await refresh();
          toast(`💸 ${k.name}: выплачено ${money(sum(u))}`);
        } catch (err) {
          toast(err.message, true);
        }
      })
  );
  $$('[data-undo]', v).forEach(
    (b) =>
      (b.onclick = async () => {
        const p = S.payouts.find((x) => x.id === b.dataset.undo);
        const ok = await confirmSheet({
          title: 'Отменить выплату?',
          text: `${money(p.amountAg)} для ${h(member(p.memberId).name)} снова станут «к выплате».`,
          ok: 'Отменить выплату',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('DELETE', '/api/payouts/' + p.id);
          await refresh();
          toast('Выплата отменена');
        } catch (err) {
          toast(err.message, true);
        }
      })
  );
  bindDeletes(v);
  bindPayView(v);
}

function openTaskPicker(memberId) {
  openSheet(`<h2>Добавить за ${h(member(memberId).name)}</h2><p class="lead">Например, если ребёнок забыл отметить, или бонус за что-то особенное.</p><div data-grid></div>`, (sh) => {
    $('[data-grid]', sh).innerHTML = taskTiles(availableTasks().sort((a, b) => (b.id === 'bonus') - (a.id === 'bonus')));
    bindTaskTiles(sh, memberId);
  });
}

// ================= Настройки (родитель) =================
function viewSettings(v) {
  const tasks = S.tasks.filter((t) => t.type !== 'custom');
  v.innerHTML = `
  <section class="card"><div class="card-head"><h2 class="card-title">Семья</h2></div>
    <form id="fam" class="stack">
      ${S.members
        .map(
          (m) => `<div class="setup-row">${avatar(m)}
          <label><small>Имя</small><input class="input" name="name-${m.id}" value="${h(m.name)}" maxlength="30"></label>
          <label><small>Новый PIN</small><input class="input" name="pin-${m.id}" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></label></div>`
        )
        .join('')}
      <button class="btn primary" type="submit">Сохранить</button>
    </form>
  </section>
  <section class="card"><div class="card-head"><h2 class="card-title">Цены</h2><span class="card-note">изменения не влияют на уже отмеченные дела</span></div>
    <form id="prices">
      ${tasks
        .map(
          (t) => `<div class="price-row"><div style="font-size:20px">${h(t.icon)}</div>
          <div><div style="font-weight:600">${h(t.name)}</div><div class="opts">
            <label><span class="switch"><input type="checkbox" name="weekly-${t.id}" ${t.weekly ? 'checked' : ''}><span></span></span>раз в неделю</label>
            <label><span class="switch"><input type="checkbox" name="active-${t.id}" ${t.active ? 'checked' : ''}><span></span></span>активно</label>
          </div></div>
          <div style="white-space:nowrap"><input class="input small num" name="price-${t.id}" value="${t.price}" inputmode="decimal"><span class="unit">${
            t.type === 'hourly' ? '₪/ч' : t.type === 'percent' ? '%' : '₪'
          }</span></div></div>`
        )
        .join('')}
      <button class="btn primary" type="submit" style="margin-top:14px">Сохранить цены</button>
    </form>
  </section>
  <section class="card"><div class="card-head"><h2 class="card-title">Данные</h2></div>
    <p class="hint" style="margin-top:0">Сервер сам делает ежедневные копии. Можно также скачать всё в файл.</p>
    <a class="btn" href="/api/export" download>Скачать резервную копию</a>
  </section>
  <section class="card"><div class="card-head"><h2 class="card-title">Установить на телефон</h2></div>
    <p class="hint" style="margin:0">iPhone: Safari → «Поделиться» → «На экран Домой».<br>Android: Chrome → меню ⋮ → «Добавить на главный экран».</p>
  </section>`;

  $('#fam').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      for (const m of S.members) {
        const body = {};
        const name = String(fd.get('name-' + m.id)).trim();
        const pin = String(fd.get('pin-' + m.id)).trim();
        if (name && name !== m.name) body.name = name;
        if (pin) body.pin = pin;
        if (Object.keys(body).length) await api('PUT', '/api/members/' + m.id, body);
      }
      await refresh();
      toast('Сохранено');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#prices').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const list = tasks.map((t) => ({
      id: t.id,
      price: String(fd.get('price-' + t.id)).replace(',', '.'),
      weekly: fd.get('weekly-' + t.id) === 'on',
      active: fd.get('active-' + t.id) === 'on',
    }));
    try {
      await api('PUT', '/api/tasks', { tasks: list });
      await refresh();
      toast('Цены обновлены');
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ================= Профиль =================
function openProfile() {
  openSheet(
    `<div class="row">${avatar(S.me, 'lg')}<div><h2>${h(S.me.name)}</h2><div class="hint">${isParent() ? 'Глава семьи' : 'Участник'}</div></div></div>
    <form class="stack" style="margin-top:18px" id="pinform">
      <div class="section-label" style="margin:0">Сменить PIN</div>
      ${isParent() ? '' : `<input class="input" name="old" inputmode="numeric" maxlength="4" placeholder="Текущий PIN" autocomplete="off">`}
      <input class="input" name="pin" inputmode="numeric" maxlength="4" placeholder="Новый PIN (4 цифры)" autocomplete="off">
      <button class="btn" type="submit">Сменить PIN</button>
    </form>
    <div class="row" style="margin-top:18px"><button class="btn danger block" id="logout">Выйти</button></div>`,
    (sh) => {
      $('#logout', sh).onclick = async () => {
        await api('POST', '/api/logout').catch(() => {});
        closeSheet();
        S.me = null;
        stopEvents();
        boot();
      };
      $('#pinform', sh).onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await api('PUT', '/api/members/' + S.me.id, { pin: fd.get('pin'), oldPin: fd.get('old') });
          closeSheet();
          toast('PIN изменён');
        } catch (err) {
          toast(err.message, true);
        }
      };
    }
  );
}

// ================= Живые обновления =================
let es = null;
function startEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('change', async (ev) => {
    const data = JSON.parse(ev.data);
    await refresh();
    if (data.by === S.me.id) return;
    const who = member(data.by).name;
    if (data.kind === 'entry') toast(`${who === member(data.memberId).name ? who : `${who} → ${member(data.memberId).name}`}: ${data.text} +${money(data.amountAg)}`);
    if (data.kind === 'payout' && data.memberId === S.me.id) toast(`💸 Выплата: ${money(data.amountAg)}!`);
  });
  es.onerror = () => {
    // браузер переподключится сам; если сессия закончилась — вернёмся на вход
    api('GET', '/api/state').catch((e) => e.status === 401 && (stopEvents(), boot()));
  };
}
function stopEvents() {
  es && es.close();
  es = null;
}

async function refresh() {
  const st = await api('GET', '/api/state');
  Object.assign(S, st);
  if (!$('.overlay')) renderApp();
  else pendingRender = true;
}
let pendingRender = false;
new MutationObserver(() => {
  if (pendingRender && !$('.overlay')) {
    pendingRender = false;
    renderApp();
  }
}).observe(document.body, { childList: true });

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => S.me && S.tab === 'stats' && renderApp(), 200);
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && S.me && refresh().catch(() => {}));

// ================= Старт =================
async function boot() {
  try {
    S.pub = await api('GET', '/api/public');
    S.today = S.pub.today;
  } catch {
    root.innerHTML = `<div class="center-screen"><div class="login"><h1>Нет связи</h1><p class="lead">Не удаётся связаться с сервером.</p><button class="btn primary" onclick="location.reload()">Повторить</button></div></div>`;
    return;
  }
  if (!S.pub.setupDone) return renderSetup();
  try {
    Object.assign(S, await api('GET', '/api/state'));
    renderApp();
    startEvents();
  } catch (e) {
    if (e.status === 401) renderLogin();
    else toast(e.message, true);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
