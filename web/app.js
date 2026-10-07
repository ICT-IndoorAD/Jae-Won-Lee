'use strict';

/* =========================================================================
 * 공통 유틸
 * ========================================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = (path, q = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null));
  return fetch(`/api/${path}?${qs}`).then(r => r.json());
};
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};
const pad = n => String(n).padStart(2, '0');
function fmtTime(ms, withSec = false) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${withSec ? ':' + pad(d.getSeconds()) : ''}`;
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d}일 ${h}시간`;
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분`;
  return `${sec}초`;
}
function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function alpha(color, a) {
  const h = color.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

const DECIMALS = { temp: 1, humi: 1, co2: 0, pm25: 0, voc: 1 };
const LEVEL_TXT = { good: '좋음', caution: '주의', danger: '위험' };
const TYPE_TXT = { threshold: '기준 이탈', spike: '급상승', drop: '급하강', flatline: '값 고정', fault: '센서 고장', gap: '수신 공백' };
// 추이 판단: 시간당 변화량이 이 값 미만이면 '안정'
const STABLE_EPS = { temp: 0.3, humi: 1.5, co2: 50, pm25: 3, voc: 0.3 };

const state = {
  cfg: null, meta: {}, current: null, health: null,
  tab: 'now', range: { preset: 'all' }, trendWin: 60,
  evFilter: { kind: 'all', metric: 'all', sev: 'all' },
  loc: null, outdoor: null, wx: null, aq: null,
  charts: {},
};

function meta(key) { return state.meta[key]; }
function fmtVal(key, v, withUnit = true) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const m = meta(key);
  const s = v.toFixed(DECIMALS[m.group]);
  return withUnit && m.unit ? `${s}${m.unit}` : s;
}
function badge(level) {
  if (!level) return `<span class="badge na">데이터 없음</span>`;
  return `<span class="badge ${level}">${LEVEL_TXT[level]}</span>`;
}
function levelOf(group, v) {
  if (v === null || v === undefined) return null;
  const th = state.cfg.thresholds[group];
  if (th.high_danger !== undefined && v > th.high_danger) return 'danger';
  if (th.low_danger !== undefined && v < th.low_danger) return 'danger';
  if (th.high_caution !== undefined && v > th.high_caution) return 'caution';
  if (th.low_caution !== undefined && v < th.low_caution) return 'caution';
  return 'good';
}

/* =========================================================================
 * 테마
 * ========================================================================= */
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
applyTheme(store.get('theme'));
$('#theme-toggle').addEventListener('click', () => {
  const dark = css('--surface') === '#1a1a19';
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
  rerenderAll();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => rerenderAll());

/* =========================================================================
 * 차트 공통
 * ========================================================================= */
// 이상 구간 음영, 임계선, 크로스헤어를 그리는 플러그인
const overlayPlugin = {
  id: 'overlays',
  beforeDatasetsDraw(chart, _a, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!opts.spans?.length || !x) return;
    ctx.save();
    for (const s of opts.spans) {
      const x0 = Math.max(a.left, x.getPixelForValue(s.start));
      const x1 = Math.min(a.right, x.getPixelForValue(s.end));
      if (x1 < a.left || x0 > a.right) continue;
      ctx.fillStyle = s.color;
      ctx.fillRect(x0, a.top, Math.max(2, x1 - x0), a.bottom - a.top);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart, _a, opts) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    ctx.save();
    for (const l of opts.lines || []) {
      const py = y.getPixelForValue(l.y);
      if (py < a.top || py > a.bottom) continue;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = l.color;
      ctx.font = '11px system-ui, sans-serif';
      // 주의선 라벨은 오른쪽, 위험선 라벨은 왼쪽에 두어 가까운 선끼리 겹치지 않게 함
      const left = l.label.startsWith('위험');
      ctx.textAlign = left ? 'left' : 'right';
      ctx.textBaseline = py - 14 < a.top ? 'top' : 'bottom';
      ctx.fillText(l.label, left ? a.left + 4 : a.right - 4, py + (py - 14 < a.top ? 3 : -3));
    }
    const act = chart.tooltip?.getActiveElements?.();
    if (act?.length && opts.crosshair !== false) {
      const px = act[0].element.x;
      ctx.strokeStyle = css('--axis');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    }
    ctx.restore();
  },
};
Chart.register(overlayPlugin);

function chartTheme() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.animation = false;
}

function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

function thresholdLines(group) {
  const th = state.cfg.thresholds[group];
  const L = [];
  const add = (k, color, label) => th[k] !== undefined && L.push({ y: th[k], color, label });
  add('high_caution', css('--warning'), `주의 ${th.high_caution}`);
  add('high_danger', css('--critical'), `위험 ${th.high_danger}`);
  add('low_caution', css('--warning'), `주의 ${th.low_caution}`);
  add('low_danger', css('--critical'), `위험 ${th.low_danger}`);
  return L;
}

function eventSpans(events, keys) {
  return (events || [])
    .filter(e => e.type !== 'gap' && e.type !== 'fault' && keys.includes(e.metric))
    .map(e => ({
      start: e.start, end: e.end,
      color: e.kind === 'sensor' ? alpha(css('--muted'), 0.12)
        : alpha(e.severity === 'danger' ? css('--critical') : css('--warning'), e.severity === 'danger' ? 0.14 : 0.2),
    }));
}

const SERIES_COLOR = i => css(`--series-${i}`);

/**
 * 시계열 라인 차트 (모든 시리즈가 같은 시간축 labels 를 공유 → index 모드 툴팁)
 * series: [{name, color, data, min?, max?, stepped?}]
 */
function lineChart(id, canvas, { labels, series, unit, group, spans, xMin, xMax, decimals }) {
  destroyChart(id);
  const datasets = [];
  for (const s of series) {
    if (s.min && s.max) {
      datasets.push({ label: '_max', data: s.max, borderWidth: 0, pointRadius: 0, fill: '+1',
        backgroundColor: alpha(s.color, 0.16), spanGaps: false, _aux: true });
      datasets.push({ label: '_min', data: s.min, borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false, _aux: true });
    }
    datasets.push({
      label: s.name, data: s.data, borderColor: s.color, backgroundColor: s.color,
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'),
      spanGaps: false, stepped: s.stepped || false, tension: 0, _min: s.min, _max: s.max,
    });
  }
  const th = state.cfg.thresholds[group];
  state.charts[id] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time', min: xMin, max: xMax,
          time: { displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'M/d HH:mm', day: 'M/d' }, tooltipFormat: 'yyyy-MM-dd HH:mm:ss' },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          grid: { display: false }, border: { color: css('--axis') },
        },
        y: {
          suggestedMin: th.low_caution, suggestedMax: th.high_caution,
          ticks: { maxTicksLimit: 6 }, grid: { color: css('--grid') }, border: { display: false },
          title: { display: !!unit, text: unit },
        },
      },
      plugins: {
        legend: { display: false },
        overlays: { spans, lines: thresholdLines(group) },
        tooltip: {
          filter: it => !it.dataset._aux && it.raw !== null,
          backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'),
          borderColor: css('--border'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: {
            label: it => {
              const d = it.dataset;
              const v = it.raw;
              let s = ` ${d.label}: ${v.toFixed(decimals)}${unit}`;
              const mn = d._min?.[it.dataIndex], mx = d._max?.[it.dataIndex];
              if (mn !== undefined && mx !== undefined && mn !== null && mx !== mn) s += `  (${mn.toFixed(decimals)}~${mx.toFixed(decimals)})`;
              return s;
            },
          },
        },
      },
    },
  });
}

function legendHtml(series, { band, thr, anom }) {
  const items = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`);
  if (band) items.push(`<span><i class="band" style="background:${series[0].color}"></i>최소~최대</span>`);
  if (thr) items.push(`<span><i class="thr"></i>기준선</span>`);
  if (anom) items.push(`<span><i class="anom"></i>이상 구간</span>`);
  return `<div class="legend">${items.join('')}</div>`;
}

// 외부 시간별 값을 차트 시간축에 선형 보간
function interpOutdoor(series, labels) {
  if (!series?.t?.length) return null;
  const { t, v } = series; // t: ms
  let j = 0;
  return labels.map(x => {
    if (x < t[0] || x > t[t.length - 1]) return null;
    while (j < t.length - 2 && t[j + 1] < x) j++;
    const a = v[j], b = v[j + 1];
    if (a === null || b === null || a === undefined || b === undefined) return a ?? b ?? null;
    const r = (x - t[j]) / (t[j + 1] - t[j]);
    return a + (b - a) * Math.max(0, Math.min(1, r));
  });
}

/* 차트 그룹 정의 */
const GROUPS = [
  { id: 'temp', title: '온도', unit: '°C', series: [
    { key: 'dht_temp_C', name: '실내 (DHT)', c: 1, band: true },
    { key: 'am_temp_C', name: '실내 (AM)', c: 2 },
    { outdoor: 'temp', name: '외부 기온', c: 3 }] },
  { id: 'humi', title: '습도', unit: '%', series: [
    { key: 'dht_humi_pct', name: '실내 (DHT)', c: 1, band: true },
    { key: 'am_humi_pct', name: '실내 (AM)', c: 2 },
    { outdoor: 'humi', name: '외부 습도', c: 3 }] },
  { id: 'co2', title: 'CO₂', unit: 'ppm', series: [{ key: 'co2_ppm', name: 'CO₂', c: 1, band: true }] },
  { id: 'pm25', title: 'PM2.5', unit: 'µg/m³', series: [
    { key: 'pm25_ugm3', name: '실내', c: 1, band: true },
    { outdoor: 'pm', name: '외부', c: 3 }] },
  { id: 'voc', title: 'VOC 등급', unit: '', series: [{ key: 'voc_level', name: 'VOC', c: 1, stepped: true }] },
];

function renderGroupCharts(container, prefix, data, { events, showOutdoor, xMin, xMax, groups, band = true }) {
  container.innerHTML = '';
  for (const g of GROUPS.filter(g => !groups || groups.includes(g.id))) {
    const series = [];
    for (const s of g.series) {
      let arr = null, mn = null, mx = null;
      if (s.key) {
        const m = data.metrics[s.key];
        arr = m.mean;
        if (s.band && band) { mn = m.min; mx = m.max; }
        if (!arr.some(v => v !== null)) continue; // 해당 구간 데이터 없는 센서는 생략
      } else {
        if (!showOutdoor || !state.outdoor) continue;
        arr = interpOutdoor(state.outdoor[s.outdoor], data.t);
        if (!arr || !arr.some(v => v !== null)) continue;
      }
      series.push({ name: s.name, color: SERIES_COLOR(s.c), data: arr, min: mn, max: mx, stepped: s.stepped });
    }
    const keys = g.series.filter(s => s.key).map(s => s.key);
    const spans = events ? eventSpans(events, keys) : [];
    const card = document.createElement('article');
    card.className = 'card chart-card';
    const hasBand = series.some(s => s.min);
    card.innerHTML = `<div class="card-head"><h2>${g.title}</h2>${series.length ? legendHtml(series, { band: hasBand, thr: true, anom: spans.length > 0 }) : ''}</div>
      <div class="chart-box"><canvas></canvas></div>`;
    container.appendChild(card);
    const id = `${prefix}-${g.id}`;
    if (!series.length) {
      destroyChart(id);
      $('.chart-box', card).innerHTML = '<div class="empty">이 구간에는 데이터가 없습니다.</div>';
      continue;
    }
    lineChart(id, $('canvas', card), {
      labels: data.t, series, unit: g.unit, group: g.id, spans, xMin, xMax, decimals: DECIMALS[g.id],
    });
  }
}

/* =========================================================================
 * 탭 전환
 * ========================================================================= */
$$('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  location.hash = tab;
  refreshTab();
}

function refreshTab() {
  ({ now: loadNow, history: loadHistory, trend: loadTrend, events: loadEvents })[state.tab]?.();
}
function rerenderAll() { chartTheme(); refreshTab(); }

/* =========================================================================
 * 현재 탭
 * ========================================================================= */
async function refreshCurrent() {
  const [cur, health] = await Promise.all([api('current'), api('health')]);
  state.current = cur;
  state.health = health;
  const fs = $('#feed-status');
  if (cur.empty) { fs.textContent = '데이터 없음'; return; }
  const age = Date.now() / 1000 - cur.time;
  fs.textContent = `마지막 수신 ${fmtTime(cur.time * 1000, true)} · ${cur.stale ? fmtDur(age) + ' 전 (수신 지연)' : '실시간'}`;
  fs.classList.toggle('stale', cur.stale);
  if (state.tab === 'now') { renderKpis(); renderAlerts(); renderCompare(); }
}

const KPI_EXTRA = { dht_temp_C: 'am_temp_C', dht_humi_pct: 'am_humi_pct' };
function renderKpis() {
  const cur = state.current;
  $('#kpis').innerHTML = state.cfg.primary.map(k => {
    const m = cur.metrics[k], md = meta(k);
    const d = m.delta;
    const dTxt = d === null ? '' : `${fmtDur(cur.delta_sec)} 전 대비 ${d > 0 ? '+' : ''}${d.toFixed(DECIMALS[md.group])}${md.unit}`;
    let extra = '';
    if (KPI_EXTRA[k]) {
      const am = cur.metrics[KPI_EXTRA[k]];
      extra = `<div class="sub">AM 센서: ${am.ok ? fmtVal(KPI_EXTRA[k], am.value) : '센서 이상/값 없음'}</div>`;
    }
    const name = md.label.replace(/ \(DHT\)/, '');
    return `<article class="card kpi ${m.level || ''}">
      <div class="label"><span>${esc(name)}</span>${badge(m.level)}</div>
      <div class="value">${m.value === null ? '–' : m.value.toFixed(DECIMALS[md.group])}<span class="unit">${md.unit}</span></div>
      <div class="sub">${dTxt || '&nbsp;'}</div>${extra}
    </article>`;
  }).join('');
}

function renderAlerts() {
  const cur = state.current, A = [];
  if (cur.stale) {
    A.push({ lv: 'danger', t: '수신 지연', m: `센서 데이터가 ${fmtDur(Date.now() / 1000 - cur.time)} 동안 들어오지 않았습니다. 아래 값은 마지막 수신 시점 기준입니다.` });
  }
  for (const k of state.cfg.primary) {
    const m = cur.metrics[k];
    if (m.level === 'caution' || m.level === 'danger') {
      A.push({ lv: m.level, t: `${meta(k).label} ${LEVEL_TXT[m.level]}`, m: `현재 ${fmtVal(k, m.value)} — ${thresholdText(meta(k).group)}` });
    }
  }
  if (!cur.metrics.am_temp_C.ok) A.push({ lv: 'caution', t: 'AM 센서 이상', m: 'AM 온·습도 센서가 0.0°C / 99.0% 고장 패턴을 출력하거나 값이 없습니다. 배선/전원을 확인하세요.' });
  const last = cur.time * 1000;
  for (const e of state.events || []) {
    if (e.type === 'flatline' && e.end >= last - 120000) A.push({ lv: 'caution', t: '센서 값 고정', m: e.desc });
  }
  $('#alerts').innerHTML = A.map(a => `<div class="alert ${a.lv}">${badge(a.lv)}<div><strong>${esc(a.t)}</strong> · ${esc(a.m)}</div></div>`).join('');
}

function thresholdText(group) {
  const th = state.cfg.thresholds[group], u = { temp: '°C', humi: '%', co2: 'ppm', pm25: 'µg/m³', voc: '' }[group];
  const parts = [];
  if (th.low_caution !== undefined) parts.push(`적정 ${th.low_caution}~${th.high_caution}${u}`);
  else parts.push(`주의 ${th.high_caution}${u} 초과, 위험 ${th.high_danger}${u} 초과`);
  return parts.join(', ');
}

function renderCompare() {
  const cur = state.current, wx = state.wx, aq = state.aq;
  const iT = cur.metrics.dht_temp_C.value, iH = cur.metrics.dht_humi_pct.value, iP = cur.metrics.pm25_ugm3.value;
  const oT = wx?.current?.temperature_2m ?? null, oH = wx?.current?.relative_humidity_2m ?? null, oP = aq?.current?.pm2_5 ?? null;
  const diff = (a, b, d, u) => (a === null || b === null) ? '–' : `${a - b > 0 ? '+' : ''}${(a - b).toFixed(d)}${u}`;
  const v = (x, d, u) => x === null ? '–' : `${x.toFixed(d)}${u}`;
  $('#compare-body').innerHTML = `
    <div class="cmp-row head"><span></span><span class="num">실내</span><span class="num">외부</span><span class="num">차이 (실내−외부)</span></div>
    <div class="cmp-row"><span>온도</span><span class="num">${v(iT, 1, '°C')}</span><span class="num">${v(oT, 1, '°C')}</span><span class="num">${diff(iT, oT, 1, '°C')}</span></div>
    <div class="cmp-row"><span>습도</span><span class="num">${v(iH, 0, '%')}</span><span class="num">${v(oH, 0, '%')}</span><span class="num">${diff(iH, oH, 0, '%p')}</span></div>
    <div class="cmp-row"><span>PM2.5</span><span class="num">${v(iP, 0, '')}</span><span class="num">${v(oP, 0, '')}</span><span class="num">${diff(iP, oP, 0, '')}</span></div>`;
  $('#advice').innerHTML = advice({ iT, iH, iP, oT, oH, oP, co2: cur.metrics.co2_ppm.value, stale: cur.stale })
    .map(s => `<p>${s}</p>`).join('');
}

function advice({ iT, iH, iP, oT, oH, oP, co2, stale }) {
  const out = [];
  const th = state.cfg.thresholds;
  const outdoorClean = oP !== null && oP <= th.pm25.high_caution;
  if (co2 !== null && co2 > th.co2.high_caution) {
    if (oP === null) out.push(`💨 CO₂가 ${co2.toFixed(0)}ppm으로 높습니다. 환기가 필요합니다.`);
    else if (outdoorClean) out.push(`💨 CO₂가 ${co2.toFixed(0)}ppm으로 높고 외부 PM2.5(${oP.toFixed(0)})가 양호합니다. 창문을 열어 환기하세요.`);
    else out.push(`💨 CO₂가 높지만 외부 PM2.5(${oP.toFixed(0)})도 나쁩니다. 5~10분 짧게 환기한 뒤 공기청정기를 가동하세요.`);
  }
  if (iP !== null && iP > th.pm25.high_caution) {
    out.push(outdoorClean ? `🌫️ 실내 미세먼지가 외부보다 높습니다. 실내 오염원(조리, 연소 등)을 확인하고 환기하세요.`
      : `🌫️ 실내 미세먼지가 높습니다. 공기청정기 가동을 권장합니다.`);
  }
  if (iT !== null) {
    if (iT < th.temp.low_caution) out.push(`🥶 실내 온도가 ${iT.toFixed(1)}°C로 낮습니다${oT !== null ? ` (외부 ${oT.toFixed(1)}°C)` : ''}. 난방 또는 창문 단속을 확인하세요.`);
    else if (iT > th.temp.high_caution) out.push(oT !== null && oT < iT - 3 ? `🥵 실내가 덥고 외부(${oT.toFixed(1)}°C)가 더 시원합니다. 환기로 온도를 낮출 수 있습니다.` : `🥵 실내 온도가 높습니다. 냉방을 고려하세요.`);
  }
  if (iH !== null) {
    if (iH < th.humi.low_caution) out.push(`🏜️ 실내 습도가 ${iH.toFixed(0)}%로 건조합니다. 가습을 권장합니다.`);
    else if (iH > th.humi.high_caution) out.push(oH !== null && oH < iH ? `💧 실내 습도가 높고 외부(${oH.toFixed(0)}%)가 더 건조합니다. 환기 또는 제습하세요.` : `💧 실내 습도가 높습니다. 제습기를 가동하세요.`);
  }
  if (iT !== null && oT !== null && Math.abs(iT - oT) >= 15) out.push(`🌡️ 실내외 온도차가 ${Math.abs(iT - oT).toFixed(0)}°C로 큽니다. 창가 결로와 출입 시 온도 충격에 유의하세요.`);
  if (!out.length) out.push('✅ 현재 실내 환경은 기준 범위 내에 있습니다.');
  if (stale) out.push('⚠️ 센서 데이터가 지연되어 위 판단은 마지막 수신 값 기준입니다.');
  return out;
}

async function loadNow() {
  await refreshCurrent();
  const last = state.current?.time;
  if (!last) return;
  const [data, ev] = await Promise.all([
    api('series', { start: (last - 3600) * 1000, end: (last + 1) * 1000, points: 360 }),
    api('anomalies', { start: (last - 3600) * 1000 }),
  ]);
  const covered = data.t.filter((_, i) => data.metrics.dht_temp_C.mean[i] !== null).length * data.bucket;
  $('#recent-note').textContent = `${fmtTime((last - 3600) * 1000)} ~ ${fmtTime(last * 1000)} · 데이터 확보 ${fmtDur(covered)}`;
  renderGroupCharts($('#recent-charts'), 'recent', data, {
    events: ev.events, showOutdoor: true, xMin: (last - 3600) * 1000, xMax: last * 1000,
    groups: ['temp', 'humi', 'co2', 'pm25'], band: false,
  });
}

/* =========================================================================
 * 외부 날씨 (Open-Meteo, API 키 불필요)
 * ========================================================================= */
const DEFAULT_LOC = { lat: 37.5665, lon: 126.978, name: '서울 (기본 위치)', source: 'default' };
const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '서리 안개',
  51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비', 56: '어는 이슬비', 57: '어는 이슬비',
  61: '약한 비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '강한 어는 비',
  71: '약한 눈', 73: '눈', 75: '강한 눈', 77: '싸락눈', 80: '약한 소나기', 81: '소나기', 82: '강한 소나기',
  85: '약한 소낙눈', 86: '강한 소낙눈', 95: '뇌우', 96: '우박 동반 뇌우', 99: '강한 우박 뇌우',
};

function initLocation() {
  const saved = store.get('loc');
  if (saved) setLoc(saved);
  else useGeolocation(true);
}

function useGeolocation(fallback) {
  if (!navigator.geolocation) { if (fallback) setLoc(DEFAULT_LOC); return; }
  $('#weather-body').innerHTML = '<p class="muted">브라우저 위치 확인 중… (권한 요청 창을 확인하세요)</p>';
  navigator.geolocation.getCurrentPosition(async pos => {
    const loc = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), name: null, source: 'gps' };
    try {
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.lat}&longitude=${loc.lon}&localityLanguage=ko`).then(r => r.json());
      loc.name = [r.principalSubdivision, r.city || r.locality].filter(Boolean).join(' ') || null;
    } catch { /* 지명 조회 실패 시 좌표 표시 */ }
    store.set('loc', loc);
    setLoc(loc);
  }, err => {
    if (fallback || !state.loc) setLoc({ ...DEFAULT_LOC, name: `서울 (위치 권한 ${err.code === 1 ? '거부' : '확인 실패'} — 기본값)` });
  }, { timeout: 10000, maximumAge: 600000 });
}

function setLoc(loc) {
  state.loc = loc;
  loadWeather();
}

async function loadWeather() {
  const loc = state.loc;
  if (!loc) return;
  const first = state.health?.first ?? Date.now();
  const past = Math.min(92, Math.max(1, Math.ceil((Date.now() - first) / 86400000) + 1));
  const common = `latitude=${loc.lat}&longitude=${loc.lon}&past_days=${past}&forecast_days=1&timezone=auto&timeformat=unixtime`;
  const [wxR, aqR] = await Promise.allSettled([
    fetch(`https://api.open-meteo.com/v1/forecast?${common}&wind_speed_unit=ms&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&hourly=temperature_2m,relative_humidity_2m`).then(r => r.json()),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${common}&current=pm2_5,pm10&hourly=pm2_5`).then(r => r.json()),
  ]);
  const wx = wxR.status === 'fulfilled' && !wxR.value.error ? wxR.value : null;
  const aq = aqR.status === 'fulfilled' && !aqR.value.error ? aqR.value : null;
  state.wx = wx; state.aq = aq;
  const ms = a => a.map(x => x * 1000);
  state.outdoor = {
    temp: wx ? { t: ms(wx.hourly.time), v: wx.hourly.temperature_2m } : null,
    humi: wx ? { t: ms(wx.hourly.time), v: wx.hourly.relative_humidity_2m } : null,
    pm: aq ? { t: ms(aq.hourly.time), v: aq.hourly.pm2_5 } : null,
  };
  renderWeather();
  if (state.current) renderCompare();
  if (state.tab !== 'events') refreshTab();
}

function renderWeather() {
  const wx = state.wx, aq = state.aq, loc = state.loc;
  const name = loc.name || `위도 ${loc.lat}, 경도 ${loc.lon}`;
  if (!wx) {
    $('#weather-body').innerHTML = `<p class="wx-loc">📍 ${esc(name)}</p><p class="muted">외부 날씨를 불러오지 못했습니다. 인터넷 연결을 확인하세요.</p>`;
    return;
  }
  const c = wx.current;
  const pmLv = aq?.current?.pm2_5 != null ? levelOf('pm25', aq.current.pm2_5) : null;
  $('#weather-body').innerHTML = `
    <div class="wx-loc">📍 ${esc(name)} · 관측 ${fmtTime(c.time * 1000)}</div>
    <div class="wx-main"><span class="wx-temp">${c.temperature_2m.toFixed(1)}°C</span><span class="wx-desc">${WMO[c.weather_code] ?? '–'}</span></div>
    <div class="kv">
      <div><span class="k">체감 온도</span><span class="v">${c.apparent_temperature.toFixed(1)}°C</span></div>
      <div><span class="k">습도</span><span class="v">${c.relative_humidity_2m}%</span></div>
      <div><span class="k">바람</span><span class="v">${c.wind_speed_10m.toFixed(1)} m/s</span></div>
      <div><span class="k">강수</span><span class="v">${c.precipitation} mm</span></div>
      <div><span class="k">외부 PM2.5</span><span class="v">${aq?.current?.pm2_5 != null ? aq.current.pm2_5.toFixed(0) + ' µg/m³ ' + badge(pmLv) : '–'}</span></div>
    </div>
    <p class="muted small">출처: Open-Meteo (모델 기반 값으로 실제 관측소 값과 다를 수 있습니다)</p>`;
}

$('#btn-geo').addEventListener('click', () => useGeolocation(false));
let locTimer;
$('#loc-input').addEventListener('input', e => {
  clearTimeout(locTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#loc-results').hidden = true; return; }
  locTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=ko`).then(r => r.json());
      const list = r.results || [];
      $('#loc-results').innerHTML = list.length ? list.map((p, i) => `<li tabindex="0" data-i="${i}">${esc(p.name)} <span class="muted small">${esc([p.admin1, p.country].filter(Boolean).join(', '))}</span></li>`).join('')
        : '<li class="muted">검색 결과 없음</li>';
      $('#loc-results').hidden = false;
      $$('#loc-results li[data-i]').forEach(li => {
        const pick = () => {
          const p = list[+li.dataset.i];
          const loc = { lat: p.latitude, lon: p.longitude, name: [p.admin1, p.name].filter(Boolean).join(' '), source: 'search' };
          store.set('loc', loc);
          $('#loc-results').hidden = true;
          $('#loc-input').value = '';
          setLoc(loc);
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', ev => ev.key === 'Enter' && pick());
      });
    } catch { $('#loc-results').hidden = true; }
  }, 300);
});
$('#loc-form').addEventListener('submit', e => { e.preventDefault(); $('#loc-results li[data-i]')?.click(); });
document.addEventListener('click', e => { if (!e.target.closest('.loc-form')) $('#loc-results').hidden = true; });

/* =========================================================================
 * 과거 이력 탭
 * ========================================================================= */
$$('#range-presets button').forEach(b => b.addEventListener('click', () => {
  state.range = { preset: b.dataset.range };
  loadHistory();
}));
$('#range-apply').addEventListener('click', () => {
  const from = new Date($('#range-from').value).getTime(), to = new Date($('#range-to').value).getTime();
  if (!from || !to || to <= from) { alert('시작/종료 시각을 올바르게 입력하세요.'); return; }
  state.range = { preset: 'custom', from, to };
  loadHistory();
});
$('#show-outdoor').addEventListener('change', () => loadHistory());
$('#show-anom').addEventListener('change', () => loadHistory());

function resolveRange() {
  const r = state.range, h = state.health;
  if (r.preset === 'custom') return [r.from, r.to];
  if (r.preset === 'all' || !h) return [h?.first, h ? h.last + 1000 : undefined];
  return [h.last - (+r.preset) * 1000, h.last + 1000];
}

async function loadHistory() {
  if (!state.health) await refreshCurrent();
  $$('#range-presets button').forEach(b => b.classList.toggle('on', b.dataset.range === state.range.preset));
  const [start, end] = resolveRange();
  $('#range-from').value = toLocalInput(start);
  $('#range-to').value = toLocalInput(end);
  const [data, ev, prof] = await Promise.all([
    api('series', { start, end, points: 700 }),
    api('anomalies', { start, end }),
    api('profile'),
  ]);
  const bucketTxt = data.bucket >= 60 ? fmtDur(data.bucket) : `${data.bucket}초`;
  const gaps = ev.events.filter(e => e.type === 'gap');
  $('#history-note').textContent = `${fmtTime(start)} ~ ${fmtTime(end)} · 집계 단위 ${bucketTxt} 평균 (음영 = 구간 내 최소~최대)`
    + (gaps.length ? ` · 수신 공백 ${gaps.length}건 (선이 끊긴 구간)` : '');
  renderGroupCharts($('#history-charts'), 'hist', data, {
    events: $('#show-anom').checked ? ev.events : null, showOutdoor: $('#show-outdoor').checked, xMin: start, xMax: end,
  });
  renderDaily(prof.daily);
  renderHistoryTable(data);
}

function renderDaily(daily) {
  const cols = [
    ['dht_temp_C', ['min', 'mean', 'max'], '온도 °C'], ['dht_humi_pct', ['min', 'mean', 'max'], '습도 %'],
    ['co2_ppm', ['mean', 'max'], 'CO₂ ppm'], ['pm25_ugm3', ['mean', 'max'], 'PM2.5'], ['voc_level', ['mean', 'max'], 'VOC'],
  ];
  const sub = { min: '최저', mean: '평균', max: '최고' };
  const head1 = `<tr><th rowspan="2">날짜</th><th rowspan="2" class="num">기록</th>${cols.map(([, s, t]) => `<th colspan="${s.length}" class="num">${t}</th>`).join('')}<th colspan="2" class="num">이상 이벤트</th></tr>`;
  const head2 = `<tr>${cols.map(([, s]) => s.map(x => `<th class="num">${sub[x]}</th>`).join('')).join('')}<th class="num">환경</th><th class="num">센서</th></tr>`;
  const rows = daily.map(d => `<tr><td>${d.date}</td><td class="num">${fmtDur(d.minutes * 60)}</td>${cols.map(([k, s]) => s.map(x => `<td class="num">${d.metrics[k] ? fmtVal(k, d.metrics[k][x], false) : '–'}</td>`).join('')).join('')}
    <td class="num">${d.anomalies.env}</td><td class="num">${d.anomalies.sensor}</td></tr>`).join('');
  $('#daily-table').innerHTML = `<thead>${head1}${head2}</thead><tbody>${rows}</tbody>`;
}

function renderHistoryTable(data) {
  const keys = state.cfg.metrics.map(m => m.key);
  const head = `<tr><th>시각</th>${keys.map(k => `<th class="num">${esc(meta(k).label)}${meta(k).unit ? ` (${meta(k).unit})` : ''}</th>`).join('')}</tr>`;
  const rows = [];
  for (let i = data.t.length - 1; i >= 0; i--) {
    if (keys.every(k => data.metrics[k].mean[i] === null)) continue;
    rows.push(`<tr><td>${fmtTime(data.t[i], data.bucket < 60)}</td>${keys.map(k => `<td class="num">${fmtVal(k, data.metrics[k].mean[i], false)}</td>`).join('')}</tr>`);
  }
  $('#history-table').innerHTML = `<thead>${head}</thead><tbody>${rows.join('') || '<tr><td>데이터 없음</td></tr>'}</tbody>`;
}

/* =========================================================================
 * 추이 분석 탭
 * ========================================================================= */
$$('#trend-window button').forEach(b => b.addEventListener('click', () => {
  state.trendWin = +b.dataset.win;
  $$('#trend-window button').forEach(x => x.classList.toggle('on', x === b));
  loadTrend();
}));
$('#profile-metric').addEventListener('change', () => loadTrend());

async function loadTrend() {
  if (!state.health) await refreshCurrent();
  const h = state.health;
  const [tr, prof, hourly] = await Promise.all([
    api('trend', { window: state.trendWin }),
    api('profile'),
    api('series', { start: h.first, end: h.last + 1000, points: Math.min(3000, Math.ceil((h.last - h.first) / 3600000) + 2) }),
  ]);
  renderTrendCards(tr);
  renderProfile(prof);
  renderIndoorOutdoor(hourly);
}

function renderTrendCards(tr) {
  $('#trend-cards').innerHTML = state.cfg.primary.map(k => {
    const t = tr.metrics[k], md = meta(k), dec = DECIMALS[md.group];
    if (!t) return `<article class="card trend-card"><div class="head"><h2>${esc(md.label)}</h2>${badge(null)}</div><p class="muted">선택 구간에 분석 가능한 데이터가 부족합니다.</p></article>`;
    const perMin = t.span_sec < 600;
    const slope = perMin ? t.slope_per_h / 60 : t.slope_per_h;
    const eps = STABLE_EPS[md.group];
    const dir = Math.abs(t.slope_per_h) < eps ? ['→', '안정'] : t.slope_per_h > 0
      ? ['↑', Math.abs(t.slope_per_h) > eps * 5 ? '급상승' : '상승'] : ['↓', Math.abs(t.slope_per_h) > eps * 5 ? '급하강' : '하강'];
    if (!t.reliable && dir[1] !== '안정') dir[1] = dir[1].replace('급', '') + ' (단기)';
    const fit = !t.reliable ? '추세 판단 보류' : t.r2 >= 0.7 ? '추세 뚜렷' : t.r2 >= 0.3 ? '추세 보통' : '변동 위주';
    const eta = t.eta ? `<div class="eta">현재 추세가 이어지면 약 <strong>${fmtDur(t.eta.hours * 3600)}</strong> 후 ${t.eta.target}${md.unit} (기준선) 도달</div>` : '';
    const note = t.reliable ? '' : `<div class="note">확보된 데이터가 ${fmtDur(t.span_sec)}뿐이라 30분 예측을 생략했습니다.</div>`;
    return `<article class="card trend-card">
      <div class="head"><h2>${esc(md.label)}</h2>${badge(t.forecast_level ?? levelOf(md.group, t.current))}</div>
      <div class="slope">${dir[0]} ${slope > 0 ? '+' : ''}${slope.toFixed(dec + 1)}<span class="unit">${md.unit}/${perMin ? '분' : '시간'}</span></div>
      <div class="dir">${dir[1]} · ${fit} (R² ${t.r2.toFixed(2)})</div>
      <dl>
        <dt>현재</dt><dd>${fmtVal(k, t.current)}</dd>
        <dt>구간 평균</dt><dd>${fmtVal(k, t.mean)}</dd>
        <dt>최소 ~ 최대</dt><dd>${fmtVal(k, t.min, false)} ~ ${fmtVal(k, t.max)}</dd>
        <dt>30분 후 예측</dt><dd>${t.forecast_30m === null ? '–' : fmtVal(k, t.forecast_30m)}</dd>
        <dt>분석 데이터</dt><dd>${t.n.toLocaleString()}개 · ${fmtDur(t.span_sec)}</dd>
      </dl>${eta}${note}
    </article>`;
  }).join('');
}

function renderProfile(prof) {
  const sel = $('#profile-metric');
  if (!sel.options.length) {
    sel.innerHTML = state.cfg.primary.map(k => `<option value="${k}">${esc(meta(k).label)}</option>`).join('');
  }
  const k = sel.value, md = meta(k);
  const vals = prof.hourly[k];
  destroyChart('profile');
  const th = state.cfg.thresholds[md.group];
  state.charts.profile = new Chart($('#profile-chart'), {
    type: 'bar',
    data: { labels: vals.map((_, i) => `${i}시`), datasets: [{ label: md.label, data: vals, backgroundColor: SERIES_COLOR(1), borderRadius: 4, borderSkipped: 'start', barPercentage: 0.8, categoryPercentage: 0.9 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, border: { color: css('--axis') } },
        y: { suggestedMin: md.group === 'temp' || md.group === 'humi' ? th.low_caution : 0, suggestedMax: th.high_caution, grid: { color: css('--grid') }, border: { display: false }, title: { display: !!md.unit, text: md.unit } },
      },
      plugins: {
        legend: { display: false },
        overlays: { lines: thresholdLines(md.group), crosshair: false },
        tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'), borderColor: css('--border'), borderWidth: 1,
          callbacks: { label: it => it.raw === null ? ' 데이터 없음' : ` 평균 ${fmtVal(k, it.raw)}` } },
      },
    },
  });
}

function renderIndoorOutdoor(hourly) {
  const out = state.outdoor?.temp;
  const pts = [];
  if (out) {
    const idx = new Map(out.t.map((t, i) => [t, out.v[i]]));
    hourly.t.forEach((t, i) => {
      const iv = hourly.metrics.dht_temp_C.mean[i], ov = idx.get(t);
      if (iv !== null && ov !== null && ov !== undefined) pts.push({ x: ov, y: iv, t });
    });
  }
  const n = pts.length;
  let stats = '<div><span class="k">비교 가능 시간</span><span class="v">0시간</span></div>';
  if (n) {
    const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
    const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0), syy = pts.reduce((a, p) => a + (p.y - my) ** 2, 0);
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
    const diffs = pts.map(p => p.y - p.x);
    stats = `
      <div><span class="k">평균 온도차 (실내−외부)</span><span class="v">${(my - mx) > 0 ? '+' : ''}${(my - mx).toFixed(1)}°C</span></div>
      <div><span class="k">온도차 범위</span><span class="v">${Math.min(...diffs).toFixed(1)} ~ ${Math.max(...diffs).toFixed(1)}°C</span></div>
      <div><span class="k">상관계수 r</span><span class="v">${r === null ? '–' : r.toFixed(2)}</span></div>
      <div><span class="k">비교 시간</span><span class="v">${n}시간</span></div>`;
  }
  $('#io-stats').innerHTML = stats;
  destroyChart('io');
  const box = $('#io-box');
  if (!n) {
    box.innerHTML = `<div class="empty">${out ? '실내 데이터와 겹치는 외부 기온 자료가 없습니다.' : '외부 기온을 불러오지 못했습니다.'}</div>`;
    return;
  }
  if (!$('#io-chart')) box.innerHTML = '<canvas id="io-chart"></canvas>';
  state.charts.io = new Chart($('#io-chart'), {
    type: 'scatter',
    data: { datasets: [{ label: '시간별', data: pts, backgroundColor: alpha(SERIES_COLOR(1), 0.7), borderColor: css('--surface'), borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, pointHitRadius: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: '외부 기온 (°C)' }, grid: { color: css('--grid') }, border: { color: css('--axis') } },
        y: { title: { display: true, text: '실내 온도 (°C)' }, grid: { color: css('--grid') }, border: { display: false } },
      },
      plugins: {
        legend: { display: false }, overlays: { crosshair: false },
        tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'), borderColor: css('--border'), borderWidth: 1,
          callbacks: { title: it => fmtTime(it[0].raw.t), label: it => ` 외부 ${it.raw.x.toFixed(1)}°C · 실내 ${it.raw.y.toFixed(1)}°C` } },
      },
    },
  });
}

/* =========================================================================
 * 이상 이벤트 탭
 * ========================================================================= */
$$('#ev-kind button').forEach(b => b.addEventListener('click', () => {
  state.evFilter.kind = b.dataset.kind;
  $$('#ev-kind button').forEach(x => x.classList.toggle('on', x === b));
  renderEvents();
}));
$('#ev-metric').addEventListener('change', e => { state.evFilter.metric = e.target.value; renderEvents(); });
$('#ev-sev').addEventListener('change', e => { state.evFilter.sev = e.target.value; renderEvents(); });

async function loadEventsData() {
  const ev = await api('anomalies');
  state.events = ev.events;
  $('#event-badge').textContent = ev.counts.env || '';
  return ev;
}

async function loadEvents() {
  if (!state.health) await refreshCurrent();
  await loadEventsData();
  const h = state.health;
  const tile = (k, v, s = '') => `<article class="card tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></article>`;
  $('#health').innerHTML = [
    tile('총 기록', h.rows.toLocaleString() + '행', `${fmtTime(h.first)} ~ ${fmtTime(h.last)}`),
    tile('데이터 커버리지', h.coverage_pct + '%', `수신 공백 ${h.gaps}건`),
    tile('결측값', h.missing_values.toLocaleString() + '개', '빈 칸으로 기록된 값'),
    tile('AM 센서 고장 비율', h.am_fault_pct + '%', '0.0°C / 99.0% 출력'),
    tile('환경 이상', (state.events.filter(e => e.kind === 'env').length) + '건', `위험 ${state.events.filter(e => e.kind === 'env' && e.severity === 'danger').length}건`),
    tile('센서/데이터 이상', (state.events.filter(e => e.kind === 'sensor').length) + '건', '고정값 · 고장 · 공백'),
  ].join('');
  const sel = $('#ev-metric');
  if (sel.options.length === 1) {
    sel.insertAdjacentHTML('beforeend', state.cfg.metrics.map(m => `<option value="${m.key}">${esc(m.label)}</option>`).join(''));
  }
  renderEvents();
  renderCriteria();
}

function renderEvents() {
  const f = state.evFilter;
  const evs = (state.events || []).filter(e =>
    (f.kind === 'all' || e.kind === f.kind) &&
    (f.metric === 'all' || e.metric === f.metric || (f.metric === 'am_humi_pct' && e.metric === 'am_temp_C' && e.type === 'fault')) &&
    (f.sev === 'all' || (f.sev === 'danger' ? e.severity === 'danger' : e.severity !== 'good')));
  const head = '<tr><th>심각도</th><th>시작</th><th>종료</th><th class="num">지속</th><th>구분</th><th>지표</th><th>유형</th><th>내용</th></tr>';
  const rows = evs.map((e, i) => `<tr tabindex="0" data-i="${i}">
    <td>${badge(e.severity)}</td><td>${fmtTime(e.start)}</td><td>${fmtTime(e.end)}</td><td class="num">${fmtDur((e.end - e.start) / 1000)}</td>
    <td>${e.kind === 'env' ? '환경' : '센서/데이터'}</td><td>${esc(e.label)}</td><td>${TYPE_TXT[e.type] || e.type}</td><td class="desc">${esc(e.desc)}</td></tr>`).join('');
  $('#event-table').innerHTML = `<thead>${head}</thead><tbody>${rows || '<tr><td colspan="8" class="muted">조건에 맞는 이벤트가 없습니다.</td></tr>'}</tbody>`;
  $$('#event-table tbody tr[data-i]').forEach(tr => {
    const go = () => {
      const e = evs[+tr.dataset.i];
      const dur = e.end - e.start;
      const padMs = Math.max(30 * 60000, Math.min(dur * 0.5, 6 * 3600000));
      state.range = { preset: 'custom', from: e.start - padMs, to: e.end + padMs };
      switchTab('history');
    };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', ev => ev.key === 'Enter' && go());
  });
}

function renderCriteria() {
  const th = state.cfg.thresholds;
  $('#criteria').innerHTML = `
    <strong>환경 이상 — 기준 이탈 (1분 평균 기준)</strong>
    <ul>
      <li>온도: 적정 ${th.temp.low_caution}~${th.temp.high_caution}°C, 위험 ${th.temp.low_danger}°C 미만 또는 ${th.temp.high_danger}°C 초과</li>
      <li>습도: 적정 ${th.humi.low_caution}~${th.humi.high_caution}%, 위험 ${th.humi.low_danger}% 미만 또는 ${th.humi.high_danger}% 초과</li>
      <li>CO₂: 주의 ${th.co2.high_caution}ppm 초과 (실내공기질 유지기준), 위험 ${th.co2.high_danger}ppm 초과</li>
      <li>PM2.5: 주의 ${th.pm25.high_caution}µg/m³ 초과 (나쁨), 위험 ${th.pm25.high_danger}µg/m³ 초과 (매우나쁨)</li>
      <li>VOC 등급: 주의 ${th.voc.high_caution} 초과, 위험 ${th.voc.high_danger} 초과</li>
    </ul>
    <strong>환경 이상 — 급변</strong>
    <ul><li>직전 60분 1분 평균의 중앙값·MAD 기반 robust z-score가 5 이상(8 이상은 위험)이면서 일정 변화량 이상일 때</li></ul>
    <strong>센서/데이터 이상</strong>
    <ul>
      <li>AM 센서가 0.0°C / 99.0%를 동시에 출력 (고장 패턴, 차트에서는 제외)</li>
      <li>CO₂ 값이 60분 이상, 온·습도 값이 4시간 이상 완전히 동일 (값 고정)</li>
      <li>기록 간격이 5분 이상 끊김 (수신 공백)</li>
    </ul>
    <p class="muted">기준값은 <code>analysis.py</code>의 <code>THRESHOLDS</code>에서 변경할 수 있습니다.</p>`;
}

/* =========================================================================
 * 시작 & 자동 갱신
 * ========================================================================= */
async function init() {
  chartTheme();
  state.cfg = await api('config');
  state.cfg.metrics.forEach(m => { state.meta[m.key] = m; });
  await refreshCurrent();
  await loadEventsData();
  initLocation();
  const tab = location.hash.slice(1);
  switchTab(['now', 'history', 'trend', 'events'].includes(tab) ? tab : 'now');

  let tick = 0, renderedLast = state.health?.last;
  setInterval(async () => {
    if (!$('#auto-refresh').checked || document.hidden) return;
    tick++;
    await refreshCurrent();
    // 새 데이터가 있으면 30초마다 탭 전체 갱신
    if (tick % 6 === 0 && state.health?.last !== renderedLast) {
      renderedLast = state.health?.last;
      await loadEventsData();
      if (!(state.tab === 'history' && state.range.preset === 'custom')) refreshTab();
    }
  }, 5000);
  setInterval(() => { if ($('#auto-refresh').checked) loadWeather(); }, 10 * 60000);
}
init();
