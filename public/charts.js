// Лёгкие SVG-графики без библиотек: линия нарастающим итогом и сгруппированные столбцы.
// Цвета берутся из CSS-переменных участников, поэтому тёмная тема работает автоматически.

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function niceScale(max, ticks = 4) {
    if (max <= 0) return { max: ticks * 10, step: 10 };
    const raw = max / ticks;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    return { max: step * Math.ceil(max / step), step };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function makeTip(el) {
    let tip = el.querySelector('.tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      el.appendChild(tip);
    }
    return tip;
  }

  function showTip(el, tip, html, x, y) {
    tip.innerHTML = html;
    const w = el.clientWidth;
    tip.classList.add('show');
    const tw = tip.offsetWidth;
    const cx = Math.max(tw / 2 + 4, Math.min(w - tw / 2 - 4, x));
    tip.style.left = cx + 'px';
    tip.style.top = y - 10 + 'px';
  }

  // series: [{ name, color, values: [число] }], labels: [строки по оси X], fmt: функция форматирования
  function line(el, { labels, series, fmt, tipLabels }) {
    const W = Math.max(300, el.clientWidth || 600);
    const H = 230;
    const m = { l: 46, r: 70, t: 14, b: 28 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const n = labels.length;
    const maxV = Math.max(0, ...series.flatMap((s) => s.values));
    const { max, step } = niceScale(maxV);
    const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => m.t + ih - (v / max) * ih;

    let g = `<g class="grid">`;
    let ax = `<g class="axis">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      if (v > 0) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      ax += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v, true))}</text>`;
    }
    g += `</g>`;
    const every = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += every) {
      ax += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`;
    }
    ax += `</g>`;

    let lines = '';
    let ends = [];
    for (const s of series) {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      lines += `<path d="${d}" style="fill:none;stroke:${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = s.values[s.values.length - 1] || 0;
      lines += `<circle cx="${x(n - 1)}" cy="${y(last)}" r="4" style="fill:${s.color};stroke:var(--surface)" stroke-width="2"/>`;
      ends.push({ s, y: y(last) });
    }
    // Разводим подписи на концах линий, чтобы не налезали друг на друга
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    for (const e of ends) lines += `<text class="dlabel" x="${x(n - 1) + 9}" y="${e.y + 4}">${esc(e.s.name)}</text>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="График нарастающим итогом">
      ${g}<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>${ax}${lines}
      <line class="xhair" y1="${m.t}" y2="${m.t + ih}" x1="-10" x2="-10" visibility="hidden"/>
      <g class="hover-dots"></g>
      <rect class="hit" x="${m.l - 10}" y="0" width="${iw + 20}" height="${H}" fill="transparent"/>
    </svg>`;

    const svg = el.querySelector('svg');
    const hair = svg.querySelector('.xhair');
    const dots = svg.querySelector('.hover-dots');
    const tip = makeTip(el);
    const hit = svg.querySelector('.hit');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
      hair.setAttribute('x1', x(i));
      hair.setAttribute('x2', x(i));
      hair.setAttribute('visibility', 'visible');
      dots.innerHTML = series
        .map((s) => `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="4.5" style="fill:${s.color};stroke:var(--surface)" stroke-width="2"/>`)
        .join('');
      const topY = Math.min(...series.map((s) => y(s.values[i])));
      const html =
        `<b>${esc((tipLabels || labels)[i])}</b><br>` +
        series.map((s) => `<span class="dot" style="background:${s.color}"></span>${esc(s.name)}: <b>${esc(fmt(s.values[i]))}</b>`).join('<br>');
      showTip(el, tip, html, (x(i) / W) * r.width, (topY / H) * r.height);
    };
    const leave = () => {
      hair.setAttribute('visibility', 'hidden');
      dots.innerHTML = '';
      tip.classList.remove('show');
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
  }

  // Сгруппированные вертикальные столбцы
  function bars(el, { labels, series, fmt, tipLabels }) {
    const W = Math.max(300, el.clientWidth || 600);
    const H = 220;
    const m = { l: 46, r: 8, t: 14, b: 28 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const n = labels.length;
    const maxV = Math.max(0, ...series.flatMap((s) => s.values));
    const { max, step } = niceScale(maxV);
    const y = (v) => m.t + ih - (v / max) * ih;
    const groupW = iw / n;
    const gap = 2;
    const barW = Math.min(22, (groupW * 0.62 - gap * (series.length - 1)) / series.length);
    const groupInner = barW * series.length + gap * (series.length - 1);

    let g = `<g class="grid">`;
    let ax = `<g class="axis">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      if (v > 0) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      ax += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v, true))}</text>`;
    }
    g += `</g>`;
    labels.forEach((l, i) => {
      ax += `<text x="${m.l + groupW * i + groupW / 2}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`;
    });
    ax += `</g>`;

    let marks = '';
    let hits = '';
    for (let i = 0; i < n; i++) {
      const gx = m.l + groupW * i + (groupW - groupInner) / 2;
      series.forEach((s, k) => {
        const v = s.values[i];
        const bx = gx + k * (barW + gap);
        const top = y(v);
        const h = y(0) - top;
        if (h > 0.5) {
          const r = Math.min(4, h, barW / 2);
          marks += `<path d="M${bx},${y(0)}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${y(0)}Z" style="fill:${s.color}"/>`;
        }
      });
      hits += `<rect data-i="${i}" x="${m.l + groupW * i}" y="${m.t}" width="${groupW}" height="${ih}" fill="transparent"/>`;
    }

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Столбчатая диаграмма">
      ${g}${ax}${marks}<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>${hits}</svg>`;

    const svg = el.querySelector('svg');
    const tip = makeTip(el);
    svg.querySelectorAll('rect[data-i]').forEach((rect) => {
      const show = () => {
        const i = Number(rect.dataset.i);
        const r = svg.getBoundingClientRect();
        const topV = Math.max(...series.map((s) => s.values[i]));
        const html =
          `<b>${esc((tipLabels || labels)[i])}</b><br>` +
          series.map((s) => `<span class="dot" style="background:${s.color}"></span>${esc(s.name)}: <b>${esc(fmt(s.values[i]))}</b>`).join('<br>');
        showTip(el, tip, html, ((m.l + groupW * i + groupW / 2) / W) * r.width, (y(topV) / H) * r.height);
      };
      rect.addEventListener('pointerenter', show);
      rect.addEventListener('pointerdown', show);
      rect.addEventListener('pointerleave', () => tip.classList.remove('show'));
    });
  }

  window.Charts = { line, bars };
})();
