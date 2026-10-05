// ============================================================
// WAF SOC DASHBOARD - APP LOGIC (v7 - Modern Bento UI)
// ============================================================

const API = location.origin.includes('localhost') ? 'http://localhost:5000' : '';
const STATE = {};

if (typeof ChartDataLabels !== 'undefined'){
  Chart.register(ChartDataLabels);
}

// ============================================================
// DATE RANGE STATE
// ============================================================
const DR = {
  mode: 'quick',
  quickVal: 'last-8M',
  label: 'Last 8 months',
  start: null,
  end: null,
  unit: 'months',
  num: 8,
  rel: null,          // {num, unit} untuk 'Last N unit' (dihitung ulang tiap tarik data)
};
let REFRESHING = false;
const AUTO = { on: true, ms: 5 * 60 * 1000, timer: null };

// Filter state per-chart
const FILTERS = {
  reqRate:  { Clean: true, Alerted: true, Blocked: true },
  resp:     new Set(),   // HTTP Response Trend
  respdist: new Set(),   // Status Code Distribution
  ip:       new Set(),   // Top Attackers
  viol:     new Set(),   // Top Violators
  sig:      new Set(),   // Attack Signatures
  violdist: new Set(),   // Violation Categories
  url:      new Set(),   // Endpoint
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function pad2(n){ return String(n).padStart(2,'0'); }
function fmtNum(n){
  if (n === null || n === undefined) return '0';
  return Number(n).toLocaleString('id-ID');
}
function fmtDT(d){
  return `${pad2(d.getDate())} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDTFull(d){
  return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function toISO(d){
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const offStr = `${sign}${pad2(Math.floor(abs/60))}:${pad2(abs%60)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${offStr}`;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatXLabel(period, hour, unit){
  const [dd, mm, yyyy] = period.split('-');
  const hh = hour.split(':')[0];
  switch(unit){
    case 'seconds': case 'minutes': case 'hours': return `${hh}:00`;
    case 'days': case 'weeks': case 'months': return `${dd}/${mm}`;
    case 'years': return yyyy;
    default: return `${dd}/${mm}`;
  }
}
function periodSortKey(period, hour){
  const [dd, mm, yyyy] = period.split('-');
  const hh = (hour || '00:00').split(':')[0];
  return `${yyyy}${mm}${dd}${hh}`;
}

function computeFromQuick(val){
  const now = new Date();
  const sub = (n, unit) => {
    const d = new Date(now);
    if (unit === 'seconds') d.setSeconds(d.getSeconds() - n);
    if (unit === 'minutes') d.setMinutes(d.getMinutes() - n);
    if (unit === 'hours')   d.setHours(d.getHours() - n);
    if (unit === 'days')    d.setDate(d.getDate() - n);
    if (unit === 'weeks')   d.setDate(d.getDate() - n*7);
    if (unit === 'months')  d.setMonth(d.getMonth() - n);
    if (unit === 'years')   d.setFullYear(d.getFullYear() - n);
    return d;
  };
  let start, label, unit, num;
  switch(val){
    case 'today': start = new Date(now); start.setHours(0,0,0,0); label='Today'; unit='days'; num=1; break;
    case 'last-1h':  start = sub(1,'hours');   label='Last 1 hour';    unit='hours';  num=1; break;
    case 'last-24h': start = sub(24,'hours');  label='Last 24 hours';  unit='hours';  num=24; break;
    case 'last-7d':  start = sub(7,'days');    label='Last 7 days';    unit='days';   num=7; break;
    case 'last-30d': start = sub(30,'days');   label='Last 30 days';   unit='days';   num=30; break;
    case 'last-3M':  start = sub(3,'months');  label='Last 3 months';  unit='months'; num=3; break;
    case 'last-6M':  start = sub(6,'months');  label='Last 6 months';  unit='months'; num=6; break;
    case 'last-8M':  start = sub(8,'months');  label='Last 8 months';  unit='months'; num=8; break;
    case 'last-12M': start = sub(12,'months'); label='Last 12 months'; unit='months'; num=12; break;
    default:         start = sub(8,'months');  label='Last 8 months';  unit='months'; num=8;
  }
  return { start, end: now, label, unit, num };
}

function setQuick(val){
  const r = computeFromQuick(val);
  DR.mode='quick'; DR.quickVal=val; DR.rel=null; DR.start=r.start; DR.end=r.end;
  DR.label=r.label; DR.unit=r.unit; DR.num=r.num;
  updateDRLabel(); updateRangeInfo(); syncCustomInputsFromDR();
}
function setCustom(start, end, label, unit, num){
  if (!start || !end){ alert('Isi tanggal & jam start dan end terlebih dahulu'); return false; }
  if (start >= end){ alert('Tanggal/waktu "Start" harus LEBIH AWAL daripada "End"'); return false; }
  DR.mode='custom'; DR.rel=null; DR.start=start; DR.end=end;
  DR.label = label || `${fmtDT(start)} → ${fmtDT(end)}`;
  DR.unit = unit || 'months';
  DR.num = num || null;
  updateDRLabel(); updateRangeInfo(); return true;
}
function updateDRLabel(){ document.getElementById('drLabel').textContent = DR.label; }
function updateRangeInfo(){
  document.getElementById('rangeInfo').textContent =
    `${fmtDTFull(DR.start)} → ${fmtDTFull(DR.end)}`;
}

// ============================================================
// CUSTOM INPUT DROPDOWNS
// ============================================================
function fillStaticOptions(){
  const yearNow = new Date().getFullYear();
  for (const prefix of ['Start','End']){
    const dayEl = document.getElementById(`dr${prefix}Day`);
    dayEl.innerHTML = '';
    for (let i=1; i<=31; i++){
      const o = document.createElement('option'); o.value = i; o.textContent = pad2(i);
      dayEl.appendChild(o);
    }
    const monthEl = document.getElementById(`dr${prefix}Month`);
    monthEl.innerHTML = '';
    MONTH_NAMES.forEach((name, i)=>{
      const o = document.createElement('option'); o.value = i; o.textContent = name;
      monthEl.appendChild(o);
    });
    const yearEl = document.getElementById(`dr${prefix}Year`);
    yearEl.innerHTML = '';
    for (let y=2020; y<=yearNow+1; y++){
      const o = document.createElement('option'); o.value = y; o.textContent = y;
      yearEl.appendChild(o);
    }
    const hourEl = document.getElementById(`dr${prefix}Hour`);
    hourEl.innerHTML = '';
    for (let h=0; h<=23; h++){
      const o = document.createElement('option'); o.value = h; o.textContent = pad2(h);
      hourEl.appendChild(o);
    }
    const minEl = document.getElementById(`dr${prefix}Minute`);
    minEl.innerHTML = '';
    for (let m=0; m<=59; m++){
      const o = document.createElement('option'); o.value = m; o.textContent = pad2(m);
      minEl.appendChild(o);
    }
  }
}
function setCustomInputs(prefix, d){
  document.getElementById(`dr${prefix}Day`).value = d.getDate();
  document.getElementById(`dr${prefix}Month`).value = d.getMonth();
  document.getElementById(`dr${prefix}Year`).value = d.getFullYear();
  document.getElementById(`dr${prefix}Hour`).value = d.getHours();
  document.getElementById(`dr${prefix}Minute`).value = d.getMinutes();
}
function readCustomInputs(prefix){
  const d = parseInt(document.getElementById(`dr${prefix}Day`).value, 10);
  const mo = parseInt(document.getElementById(`dr${prefix}Month`).value, 10);
  const y = parseInt(document.getElementById(`dr${prefix}Year`).value, 10);
  const h = parseInt(document.getElementById(`dr${prefix}Hour`).value, 10);
  const mi = parseInt(document.getElementById(`dr${prefix}Minute`).value, 10);
  return new Date(y, mo, d, h, mi, 0, 0);
}
function syncCustomInputsFromDR(){
  if (!DR.start || !DR.end) return;
  setCustomInputs('Start', DR.start);
  setCustomInputs('End', DR.end);
}
function updateDayOptions(prefix){
  const mo = parseInt(document.getElementById(`dr${prefix}Month`).value, 10);
  const y = parseInt(document.getElementById(`dr${prefix}Year`).value, 10);
  const daysInMonth = new Date(y, mo+1, 0).getDate();
  const dayEl = document.getElementById(`dr${prefix}Day`);
  const currentVal = parseInt(dayEl.value, 10);
  dayEl.innerHTML = '';
  for (let i=1; i<=daysInMonth; i++){
    const o = document.createElement('option'); o.value = i; o.textContent = pad2(i);
    dayEl.appendChild(o);
  }
  dayEl.value = Math.min(currentVal, daysInMonth);
}

// ============================================================
// LIVE CLOCK
// ============================================================
function startClock(){
  const el = document.getElementById('liveClock');
  const tick = ()=>{
    const d = new Date();
    el.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ============================================================
// FETCH
// ============================================================
function setLoading(on, text='Menarik data dari Kibana…'){
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loading').classList.toggle('hidden', !on);
}

async function fetchData(type){
  const params = new URLSearchParams({
    start_iso: toISO(DR.start),
    end_iso:   toISO(DR.end),
  });
  const url = `${API}/api/refresh/${type}?${params}`;
  const res = await fetch(url, {method:'POST', cache:'no-store'});
  if (!res.ok){
    const err = await res.json().catch(()=>({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const j = await res.json();
  return j.data;
}

// ============================================================
// POSTURE
// ============================================================
function computeThreatLevel(){
  const d = STATE.request_distribution;
  if (!d) return {score:0, status:'TIDAK ADA DATA', color:'#7a8aa3', class:'', blocked:0, alerted:0, clean:0, total:0};
  const total = d.grand_total || 1;
  const t = d.totals_by_category || {};
  const blocked = t.Blocked || 0;
  const alerted = t.Alerted || 0;
  const clean = t.Clean || 0;
  const blockedPct = (blocked / total) * 100;
  const alertedPct = (alerted / total) * 100;
  let score = Math.min(100, Math.round(blockedPct * 10 + alertedPct * 1.5));
  let status, color, cls;
  if (score < 15){ status='AMAN'; color='#00e676'; cls=''; }
  else if (score < 35){ status='WASPADA'; color='#ffd54f'; cls='warning'; }
  else if (score < 60){ status='SIAGA'; color='#ff9f43'; cls='warning'; }
  else { status='KRITIS'; color='#ff4757'; cls='danger'; }
  return {score, status, color, cls, blocked, alerted, clean, total: d.grand_total};
}

function renderPosture(){
  const t = computeThreatLevel();
  const badge = document.getElementById('threatBadge');
  badge.className = 'threat-badge ' + t.cls;
  document.getElementById('threatLabel').textContent = t.status;
  gaugeChart('gaugeThreat', t.score, 100, t.status, t.color);
  const scoreEl = document.getElementById('threatScore');
  scoreEl.textContent = t.score;
  scoreEl.style.color = t.color;
  const statusEl = document.getElementById('threatStatus');
  statusEl.textContent = t.status;
  statusEl.style.color = t.color;
  const d = STATE.request_distribution;
  if (d){
    document.getElementById('statTotal').textContent = fmtNum(d.grand_total);
    const tot = d.totals_by_category || {};
    document.getElementById('statBlocked').textContent = fmtNum(tot.Blocked || 0);
    document.getElementById('statAlerted').textContent = fmtNum(tot.Alerted || 0);
    document.getElementById('statClean').textContent = fmtNum(tot.Clean || 0);
  }
}

// ============================================================
// SEVERITY
// ============================================================
const SEVERITY_MAP = {
  'Attack signature detected': 'Critical',
  'Threat Campaign detected': 'Critical',
  'Illegal file type': 'High',
  'Evasion technique detected': 'High',
  'HTTP protocol compliance failed': 'Medium',
  'Cookie not RFC-compliant': 'Low',
  'Failed to convert character': 'Low',
  'Malformed XML data': 'Medium',
  'Malformed JSON data': 'Medium',
  'Illegal URL length': 'Low',
};

function renderSeverity(){
  const d = STATE.violations;
  if (!d || !d.top) return;
  const buckets = {Critical:0, High:0, Medium:0, Low:0};
  d.top.forEach(v=>{
    const sev = SEVERITY_MAP[v.violation] || 'Medium';
    buckets[sev] += v.violation_count;
  });
  const max = Math.max(...Object.values(buckets), 1);
  document.getElementById('sevCritical').textContent = fmtNum(buckets.Critical);
  document.getElementById('sevHigh').textContent = fmtNum(buckets.High);
  document.getElementById('sevMedium').textContent = fmtNum(buckets.Medium);
  document.getElementById('sevLow').textContent = fmtNum(buckets.Low);
  const bars = {
    Critical: document.querySelector('#severityList .sev-item:nth-child(1) .sev-bar i'),
    High:     document.querySelector('#severityList .sev-item:nth-child(2) .sev-bar i'),
    Medium:   document.querySelector('#severityList .sev-item:nth-child(3) .sev-bar i'),
    Low:      document.querySelector('#severityList .sev-item:nth-child(4) .sev-bar i'),
  };
  Object.keys(bars).forEach(k=>{
    if (bars[k]) bars[k].style.width = ((buckets[k] / max) * 100) + '%';
  });
}

// ============================================================
// ALERT BANNER
// ============================================================
function renderBanner(){
  const v = STATE.violations;
  const s = STATE.top_signatures;
  const ip = STATE.top_violator_ip;
  const t = computeThreatLevel();
  const banner = document.getElementById('alertTicker');
  const badge = document.getElementById('bannerBadge');
  const status = document.getElementById('bannerStatus');
  const title = document.getElementById('bannerTitle');
  const items = document.getElementById('bannerItems');

  if (!v && !s && !ip){
    banner.className = 'alert-banner';
    badge.className = 'banner-badge';
    status.textContent = 'INFO';
    title.textContent = 'Belum ada data';
    items.innerHTML = `<span class="banner-placeholder">Klik "Tarik Data" untuk memuat data terbaru</span>`;
    return;
  }

  if (t.cls === 'danger'){
    banner.className = 'alert-banner danger';
    badge.className = 'banner-badge danger';
    status.textContent = 'KRITIS';
  } else if (t.cls === 'warning'){
    banner.className = 'alert-banner has-alert';
    badge.className = 'banner-badge warn';
    status.textContent = 'WASPADA';
  } else {
    banner.className = 'alert-banner ok';
    badge.className = 'banner-badge ok';
    status.textContent = 'AMAN';
  }

  title.textContent = `Status: ${t.status}`;
  const chips = [];
  if (ip && ip.top_ips && ip.top_ips[0]){
    const top = ip.top_ips[0];
    chips.push(`<span class="banner-chip danger">🎯 Top Attacker <b>${top.ip_client}</b> · <b>${fmtNum(top.total_request_ip)}</b></span>`);
  }
  if (v && v.top && v.top[0]){
    chips.push(`<span class="banner-chip warn">⚠ ${v.top[0].violation} <b>${fmtNum(v.top[0].violation_count)}</b></span>`);
  }
  if (s && s.top && s.top[0]){
    chips.push(`<span class="banner-chip">🛡 Sig ID <b>${s.top[0].sig_id}</b> · <b>${fmtNum(s.top[0].request_count)}</b></span>`);
  }
  if (chips.length === 0){
    items.innerHTML = `<span class="banner-placeholder">Tidak ada ancaman signifikan pada periode ini</span>`;
  } else {
    items.innerHTML = chips.join('');
  }
}

// ============================================================
// HEATMAP
// ============================================================
function renderHeatmap(){
  const d = STATE.top_violator_ip;
  const grid = document.getElementById('heatmapGrid');
  if (!grid) return;
  const bucket = Array.from({length: 7}, ()=> new Array(24).fill(0));
  let maxVal = 0;
  if (d && d.hourly){
    d.hourly.forEach(r=>{
      const [dd, mm, yyyy] = r.period.split('-');
      const dateObj = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));
      let dow = (dateObj.getDay() + 6) % 7;
      const hh = parseInt(r.hour.split(':')[0], 10);
      bucket[dow][hh] += r.violation_count;
      if (bucket[dow][hh] > maxVal) maxVal = bucket[dow][hh];
    });
  }
  if (maxVal === 0) maxVal = 1;
  const DAY_NAMES_LOCAL = ['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
  let html = `<div></div>`;
  for (let h=0; h<24; h++){
    html += `<div class="heatmap-hour">${pad2(h)}</div>`;
  }
  for (let day=0; day<7; day++){
    html += `<div class="heatmap-label">${DAY_NAMES_LOCAL[day]}</div>`;
    for (let h=0; h<24; h++){
      const val = bucket[day][h];
      const ratio = val / maxVal;
      let color = 'rgba(255,255,255,.04)';
      if (ratio > 0){
        const hue = 260 - ratio * 250;   // ungu -> cyan -> kuning -> merah
        color = `hsla(${hue},90%,${48 + ratio*8}%,${0.35 + ratio*0.65})`;
      }
      html += `<div class="heatmap-cell" style="background:${color}" title="${DAY_NAMES_LOCAL[day]} ${pad2(h)}: ${fmtNum(val)} events"></div>`;
    }
  }
  grid.innerHTML = html;
}

// ============================================================
// PALET WARNA
// ============================================================
const COLORS_TOP_IP = [
  '#ff4757','#ff6348','#ff7f50','#ff9f43','#ffa726',
  '#ffd54f','#a8d84a','#66bb6a','#26c6da','#54a0ff',
];
const COLORS_TOP_URL = [
  '#9d7bff','#8b6ef0','#7b61ff','#6c5ce7','#5c6bc0',
  '#54a0ff','#4dd0e1','#26c6da','#00bcd4','#00acc1',
];
const COLORS_VIOLATION = [
  '#ff4757','#ff6348','#ff7f50','#ff9f43','#ffa726',
  '#ffd54f','#a8d84a','#66bb6a','#26c6da','#54a0ff',
  '#9d7bff','#b06eff','#ec407a','#26a69a','#5c6bc0',
];

// ============================================================
// FILTER PANEL HELPERS
// ============================================================
function buildFilterList(panelId, items, activeSet, onChange){
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.innerHTML = items.map(it=>{
    const active = activeSet.has(it.key);
    const color = it.color || '#00d4ff';
    return `
      <label class="fp-item ${active?'active':''}" data-key="${escapeHtml(it.key)}">
        <input type="checkbox" ${active?'checked':''}>
        <span class="fp-check" style="${active?`background:${color};border-color:${color};`:''}"></span>
        <span class="fp-label" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</span>
        <span class="fp-count">${fmtNum(it.count)}</span>
      </label>
    `;
  }).join('');

  panel.querySelectorAll('.fp-item').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.preventDefault();
      const key = el.dataset.key;
      if (activeSet.has(key)) activeSet.delete(key);
      else activeSet.add(key);
      onChange();
    });
  });
}

function bindMiniBtn(btnId, activeSet, allKeys, onChange){
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', ()=>{
    activeSet.clear();
    allKeys.forEach(k => activeSet.add(k));
    onChange();
  });
}
function bindMiniBtnNone(btnId, activeSet, onChange){
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', ()=>{
    activeSet.clear();
    onChange();
  });
}

// ============================================================
// REQUEST RATE
// ============================================================
function renderRequestRate(){
  const d = STATE.request_distribution;
  if (!d) return;
  const grouped = {};
  d.hourly.forEach(r=>{
    const key = periodSortKey(r.period, r.hour);
    if (!grouped[key]){
      grouped[key] = { period: r.period, hour: r.hour, Clean:0, Alerted:0, Blocked:0 };
    }
    grouped[key][r.category] += r.request_count;
  });
  const keys = Object.keys(grouped).sort();
  const labels = keys.map(k => formatXLabel(grouped[k].period, grouped[k].hour, DR.unit));
  const colors = {Clean:'#00e676', Blocked:'#ff4757', Alerted:'#ff9f43'};
  const datasets = ['Clean','Blocked','Alerted']
    .filter(cat => FILTERS.reqRate[cat])
    .map(cat=>({
      label: cat,
      data: keys.map(k=> grouped[k][cat] || 0),
      borderColor: colors[cat],
      backgroundColor: colors[cat] + '15',
      fill: true,
      borderWidth: 2.5,
    }));
  lineChart('chartReqRate', labels, datasets);
}

function renderRequestDist(){
  const d = STATE.request_distribution;
  if (!d) return;
  const t = d.totals_by_category || {};
  const labels = ['Clean','Alerted','Blocked'].filter(k => k in t);
  const data = labels.map(k => t[k]);
  const cmap = {Clean:'#00e676', Alerted:'#ff9f43', Blocked:'#ff4757'};
  const colors = labels.map(l => cmap[l] || '#00d4ff');
  doughnutChart('chartReqDist', labels, data, colors, {legend:'bottom'});
}

// ============================================================
// HTTP RESPONSE TREND — FILTER KODE
// ============================================================
function renderResponseRate(){
  const d = STATE.response_code;
  if (!d) return;

  const allCodes = Object.entries(d.totals_by_code || {})
    .sort((a,b)=>b[1]-a[1])
    .map(([code, count])=>({key: code, label: code, count}));

  if (FILTERS.resp.size === 0 && allCodes.length > 0){
    allCodes.slice(0,6).forEach(c => FILTERS.resp.add(c.key));
  }

  buildFilterList('filterRespList', allCodes, FILTERS.resp, ()=>renderResponseRate());
  bindMiniBtn('fpRespAll', FILTERS.resp, allCodes.map(c=>c.key), ()=>renderResponseRate());
  bindMiniBtnNone('fpRespNone', FILTERS.resp, ()=>renderResponseRate());

  const activeCodes = allCodes.filter(c => FILTERS.resp.has(c.key)).map(c=>c.key);

  const grouped = {};
  d.hourly.forEach(r=>{
    if (!activeCodes.includes(r.response_code)) return;
    const key = periodSortKey(r.period, r.hour);
    if (!grouped[key]) grouped[key] = { period: r.period, hour: r.hour };
    grouped[key][r.response_code] = (grouped[key][r.response_code] || 0) + r.request_count;
  });
  const keys = Object.keys(grouped).sort();
  const labels = keys.map(k => formatXLabel(grouped[k].period, grouped[k].hour, DR.unit));
  const datasets = activeCodes.map((code,i)=>({
    label: code,
    data: keys.map(k => grouped[k][code] || 0),
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length] + '15',
    fill: true,
    borderWidth: 2.5,
  }));
  lineChart('chartRespRate', labels, datasets);
}

// ============================================================
// STATUS CODE DISTRIBUTION — FILTER KODE
// ============================================================
function renderResponseDist(){
  const d = STATE.response_code;
  if (!d) return;

  const allCodes = Object.entries(d.totals_by_code || {})
    .sort((a,b)=>b[1]-a[1])
    .map(([code, count])=>{
      const color = code === '200' ? '#00e676'
                  : code === '404' ? '#ff4757'
                  : code === '400' ? '#ff9f43'
                  : code === '500' ? '#b06eff'
                  : code === '0'   ? '#7a8aa3'
                  : PALETTE[Object.keys(d.totals_by_code).indexOf(code) % PALETTE.length];
      return { key: code, label: code, count, color };
    });

  if (FILTERS.respdist.size === 0 && allCodes.length > 0){
    allCodes.slice(0,5).forEach(c => FILTERS.respdist.add(c.key));
  }

  buildFilterList('filterRespDistList', allCodes, FILTERS.respdist, ()=>{
    renderResponseDist();
  });
  bindMiniBtn('fpRespDistAll', FILTERS.respdist, allCodes.map(c=>c.key), ()=>renderResponseDist());
  bindMiniBtnNone('fpRespDistNone', FILTERS.respdist, ()=>renderResponseDist());

  const active = allCodes.filter(c => FILTERS.respdist.has(c.key));

  vBarChart(
    'chartRespDist',
    active.map(x=>x.label),
    active.map(x=>x.count),
    { colors: active.map(x=>x.color) }
  );
}

// ============================================================
// TOP ATTACKERS — FILTER IP
// ============================================================
function renderTopIP(){
  const d = STATE.top_client_ip;
  if (!d) return;

  const allItems = d.top.slice(0,20).map((x, i)=>({
    key: x.ip_client,
    label: x.ip_client,
    count: x.request_count,
    color: COLORS_TOP_IP[i % COLORS_TOP_IP.length],
  }));

  if (FILTERS.ip.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.ip.add(x.key));
  }

  buildFilterList('filterIPList', allItems, FILTERS.ip, ()=>renderTopIP());
  bindMiniBtn('fpIPAll', FILTERS.ip, allItems.map(c=>c.key), ()=>renderTopIP());
  bindMiniBtnNone('fpIPNone', FILTERS.ip, ()=>renderTopIP());

  const active = allItems.filter(x => FILTERS.ip.has(x.key));
  hBarChart('chartTopIP',
    active.map(x=>x.label),
    active.map(x=>x.count),
    { colors: active.map(x=>x.color), compact: true }
  );
}

// ============================================================
// TOP VIOLATORS — FILTER IP
// ============================================================
function renderViolator(){
  const d = STATE.top_violator_ip;
  if (!d) return;

  const allItems = d.top_ips.slice(0,20).map(x=>({
    key: x.ip_client,
    label: x.ip_client,
    count: x.total_request_ip,
  }));

  if (FILTERS.viol.size === 0 && allItems.length > 0){
    allItems.slice(0,8).forEach(x => FILTERS.viol.add(x.key));
  }

  buildFilterList('filterViolList', allItems, FILTERS.viol, ()=>renderViolator());
  bindMiniBtn('fpViolAll', FILTERS.viol, allItems.map(c=>c.key), ()=>renderViolator());
  bindMiniBtnNone('fpViolNone', FILTERS.viol, ()=>renderViolator());

  const active = allItems.filter(x => FILTERS.viol.has(x.key));
  const activeKeys = active.map(x=>x.key);

  const vByIp = {};
  (d.by_ip || []).forEach(r=>{
    if (!activeKeys.includes(r.ip_client)) return;
    if (!vByIp[r.ip_client]) vByIp[r.ip_client] = {};
    vByIp[r.ip_client][r.violation] = (vByIp[r.ip_client][r.violation]||0) + r.violation_count;
  });
  const allViol = new Set();
  Object.values(vByIp).forEach(m=>Object.keys(m).forEach(v=>allViol.add(v)));
  const violList = Array.from(allViol).slice(0,6);

  const labels = active.map(x=>x.label);
  const datasets = violList.map((v, i)=>({
    label: v.length>18 ? v.slice(0,18)+'…' : v,
    data: labels.map(ip => (vByIp[ip] && vByIp[ip][v]) || 0),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderRadius: 3,
    barThickness: 20,
  }));
  stackedBarChart('chartViolator', labels, datasets);
}

// ============================================================
// ATTACK SIGNATURES — FILTER SIG
// ============================================================
function renderSig(){
  const d = STATE.top_signatures;
  if (!d) return;

  const allItems = d.top.slice(0,30).map((x, i)=>({
    key: x.sig_id,
    label: x.sig_id,
    count: x.request_count,
    color: PALETTE[i % PALETTE.length],
  }));

  if (FILTERS.sig.size === 0 && allItems.length > 0){
    allItems.slice(0,15).forEach(x => FILTERS.sig.add(x.key));
  }

  buildFilterList('filterSigList', allItems, FILTERS.sig, ()=>renderSig());
  bindMiniBtn('fpSigAll', FILTERS.sig, allItems.map(c=>c.key), ()=>renderSig());
  bindMiniBtnNone('fpSigNone', FILTERS.sig, ()=>renderSig());

  const active = allItems.filter(x => FILTERS.sig.has(x.key));

  vBarChart('chartSig',
    active.map(x=>x.label),
    active.map(x=>x.count),
    { colors: active.map(x=>x.color) }
  );
}

// ============================================================
// VIOLATION CATEGORIES — FILTER JENIS
// ============================================================
function renderViol(){
  const d = STATE.violations;
  if (!d || !d.top) return;

  const allItems = d.top.map((x, i)=>({
    key: x.violation,
    label: x.violation,
    count: x.violation_count,
    color: COLORS_VIOLATION[i % COLORS_VIOLATION.length],
  }));

  if (FILTERS.violdist.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.violdist.add(x.key));
  }

  buildFilterList('filterViolDistList', allItems, FILTERS.violdist, ()=>{
    renderViol();
  });
  bindMiniBtn('fpViolDistAll', FILTERS.violdist, allItems.map(c=>c.key), ()=>renderViol());
  bindMiniBtnNone('fpViolDistNone', FILTERS.violdist, ()=>renderViol());

  const active = allItems.filter(x => FILTERS.violdist.has(x.key));

  doughnutChart(
    'chartViol',
    active.map(x=>x.label),
    active.map(x=>x.count),
    active.map(x=>x.color)
  );
}

// ============================================================
// ENDPOINT — FILTER URI
// ============================================================
function renderTopURL(){
  const d = STATE.top_url;
  if (!d) return;

  const allItems = d.top.slice(0,20).map((x, i)=>({
    key: x.uri,
    label: x.uri,
    count: x.request_count,
    color: COLORS_TOP_URL[i % COLORS_TOP_URL.length],
  }));

  if (FILTERS.url.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.url.add(x.key));
  }

  buildFilterList('filterURLList', allItems, FILTERS.url, ()=>renderTopURL());
  bindMiniBtn('fpURLAll', FILTERS.url, allItems.map(c=>c.key), ()=>renderTopURL());
  bindMiniBtnNone('fpURLNone', FILTERS.url, ()=>renderTopURL());

  const active = allItems.filter(x => FILTERS.url.has(x.key));

  hBarChart('chartTopURL',
    active.map(x=>x.label),
    active.map(x=>x.count),
    { colors: active.map(x=>x.color), compact: true, longLabel: true }
  );
}

function renderRawTable(){
  const d = STATE.raw_log_detail;
  const tbody = document.querySelector('#tblRaw tbody');
  if (!d || !d.rows || !d.rows.length){
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Belum ada data.</td></tr>`;
    document.getElementById('reqCount').textContent = '(0 documents)';
    return;
  }
  document.getElementById('reqCount').textContent = `(${fmtNum(d.total_fetched)} documents)`;
  tbody.innerHTML = d.rows.map(r=>`
    <tr>
      <td>${r.log_time ? r.log_time.replace('T',' ').slice(0,19) : '–'}</td>
      <td>${r.ip_client || '–'}</td>
      <td>${r.source_ip || '–'}</td>
      <td>${r.host_ip || '–'}</td>
      <td>${r.method || '–'}</td>
      <td>${r.x_forwarded_for || '–'}</td>
      <td>${r.dest_port || '–'}</td>
      <td title="${r.uri || ''}">${r.uri || '–'}</td>
      <td>${r.response_code || '–'}</td>
      <td>${r.request_status || '–'}</td>
    </tr>
  `).join('');
}

function renderKPI(){
  const d = STATE.request_distribution;
  if (!d) return;
  const t = d.totals_by_category || {}, total = d.grand_total || 1;
  [['Blocked','kpiBlockedPct'],['Alerted','kpiAlertedPct'],['Clean','kpiCleanPct']].forEach(([k,id])=>{
    const el = document.getElementById(id);
    if (el) el.textContent = (((t[k]||0)/total)*100).toFixed(2) + '%';
  });
  const g = {};
  (d.hourly || []).forEach(r=>{
    const key = periodSortKey(r.period, r.hour);
    g[key] = g[key] || {Clean:0, Alerted:0, Blocked:0};
    g[key][r.category] = (g[key][r.category] || 0) + r.request_count;
  });
  const keys = Object.keys(g).sort();
  const series = f => keys.map(k => f(g[k]));
  sparkline('spkTotal',   series(o=>o.Clean+o.Alerted+o.Blocked), '#a78bfa');
  sparkline('spkBlocked', series(o=>o.Blocked), '#ff4757');
  sparkline('spkAlerted', series(o=>o.Alerted), '#ff9f43');
  sparkline('spkClean',   series(o=>o.Clean),   '#00e676');
}

function renderAll(){
  renderPosture();
  renderKPI();
  renderSeverity();
  renderBanner();
  renderHeatmap();
  renderRequestRate();
  renderRequestDist();
  renderResponseRate();
  renderResponseDist();
  renderTopIP();
  renderViolator();
  renderSig();
  renderViol();
  renderTopURL();
  renderRawTable();
}

// ============================================================
// MODAL POPUP SYSTEM
// ============================================================
const MODAL = {};

function initModal(){
  MODAL.el = document.getElementById('modalOverlay');
  MODAL.titleEl = document.getElementById('modalTitle');
  MODAL.subtitleEl = document.getElementById('modalSubtitle');
  MODAL.infoEl = document.getElementById('modalInfo');
  MODAL.theadEl = document.getElementById('modalThead');
  MODAL.tbodyEl = document.getElementById('modalTbody');
  document.getElementById('modalClose').addEventListener('click', closeModal);
  MODAL.el.addEventListener('click', (e)=>{ if (e.target === MODAL.el) closeModal(); });
  document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeModal(); });
}

function openModal(config){
  MODAL.titleEl.textContent = config.title || 'Data Detail';
  MODAL.subtitleEl.textContent = config.subtitle || '—';
  if (config.info && config.info.length){
    MODAL.infoEl.innerHTML = config.info.map(it=>`
      <div class="modal-info-item ${it.class || ''}">
        <span class="mii-label">${it.label}</span>
        <span class="mii-value">${it.value}</span>
      </div>
    `).join('');
    MODAL.infoEl.style.display = 'flex';
  } else {
    MODAL.infoEl.style.display = 'none';
  }
  MODAL.theadEl.innerHTML = `<tr>${config.columns.map(c=>`<th>${c.label}</th>`).join('')}</tr>`;
  if (!config.rows || !config.rows.length){
    MODAL.tbodyEl.innerHTML = `<tr><td colspan="${config.columns.length}" class="empty">Tidak ada data</td></tr>`;
  } else {
    MODAL.tbodyEl.innerHTML = config.rows.map(row=>`
      <tr>
        ${config.columns.map(c=>{
          let val = row[c.key];
          if (c.format) val = c.format(val, row);
          return `<td>${val ?? '–'}</td>`;
        }).join('')}
      </tr>
    `).join('');
  }
  MODAL.el.classList.remove('hidden');
}
function closeModal(){ if (MODAL.el) MODAL.el.classList.add('hidden'); }

// ============================================================
// POPUP HANDLERS
// ============================================================
function showThreatModal(){
  const t = computeThreatLevel();
  const statusRow = (label, value, kind) => ({
    klasifikasi: label,
    jumlah: fmtNum(value),
    status: kind === 'danger' ? 'TIDAK AMAN' : (kind === 'warn' ? 'WASPADA' : 'AMAN'),
    keterangan: kind === 'danger' ? 'Ada request diblokir' : (kind === 'warn' ? 'Ada request di-alert' : 'Semua request lolos tanpa ancaman'),
  });
  const rows = [
    statusRow('Total Request', t.total, 'safe'),
    statusRow('Clean', t.clean, 'safe'),
    statusRow('Alerted', t.alerted, 'warn'),
    statusRow('Blocked', t.blocked, t.blocked > 0 ? 'danger' : 'safe'),
  ];
  openModal({
    title: 'THREAT LEVEL - Detail Perhitungan',
    subtitle: `Skor ${t.score}/100 · Status: ${t.status}`,
    info: [
      { label: 'Threat Score', value: t.score, class: t.class },
      { label: 'Status', value: t.status, class: t.class },
      { label: 'Blocked', value: fmtNum(t.blocked), class: 'danger' },
      { label: 'Alerted', value: fmtNum(t.alerted), class: 'warn' },
      { label: 'Clean', value: fmtNum(t.clean), class: 'safe' },
      { label: 'Total', value: fmtNum(t.total) },
    ],
    columns: [
      { key: 'klasifikasi', label: 'Klasifikasi' },
      { key: 'jumlah', label: 'Jumlah' },
      { key: 'status', label: 'Status Sistem', format: (v)=>
        `<span class="badge ${v === 'TIDAK AMAN' ? 'badge-danger' : (v === 'WASPADA' ? 'badge-warn' : 'badge-safe')}">${v}</span>`
      },
      { key: 'keterangan', label: 'Keterangan' },
    ],
    rows,
  });
}

function showSeverityModal(){
  const d = STATE.violations;
  if (!d || !d.top) { alert('Data violations belum ditarik'); return; }
  const rows = d.top.map(v=>{
    const sev = SEVERITY_MAP[v.violation] || 'Medium';
    return { violation: v.violation, severity: sev, count: fmtNum(v.violation_count) };
  });
  const buckets = {Critical:0, High:0, Medium:0, Low:0};
  d.top.forEach(v=>{
    const sev = SEVERITY_MAP[v.violation] || 'Medium';
    buckets[sev] += v.violation_count;
  });
  openModal({
    title: 'SEVERITY BREAKDOWN',
    subtitle: `${rows.length} jenis pelanggaran terdeteksi`,
    info: [
      { label: 'Critical', value: fmtNum(buckets.Critical), class: 'danger' },
      { label: 'High', value: fmtNum(buckets.High), class: 'danger' },
      { label: 'Medium', value: fmtNum(buckets.Medium), class: 'warn' },
      { label: 'Low', value: fmtNum(buckets.Low), class: 'safe' },
    ],
    columns: [
      { key: 'violation', label: 'Jenis Pelanggaran' },
      { key: 'severity', label: 'Severity', format: (v)=>
        `<span class="badge ${v==='Critical'||v==='High'?'badge-danger':(v==='Medium'?'badge-warn':'badge-safe')}">${v}</span>`
      },
      { key: 'count', label: 'Jumlah Event' },
    ],
    rows,
  });
}

function showLiveStatsModal(){
  const d = STATE.request_distribution;
  if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_category || {};
  const total = d.grand_total || 0;
  const rows = [
    { kategori: 'Total Request', jumlah: fmtNum(total), persen: '100%' },
    { kategori: 'Clean', jumlah: fmtNum(t.Clean || 0), persen: ((t.Clean/total)*100).toFixed(2)+'%' },
    { kategori: 'Alerted', jumlah: fmtNum(t.Alerted || 0), persen: ((t.Alerted/total)*100).toFixed(2)+'%' },
    { kategori: 'Blocked', jumlah: fmtNum(t.Blocked || 0), persen: ((t.Blocked/total)*100).toFixed(2)+'%' },
  ];
  openModal({
    title: 'LIVE STATS',
    subtitle: `Periode: ${fmtDTFull(DR.start)} → ${fmtDTFull(DR.end)}`,
    info: [
      { label: 'Total', value: fmtNum(total) },
      { label: 'Clean', value: fmtNum(t.Clean || 0), class: 'safe' },
      { label: 'Alerted', value: fmtNum(t.Alerted || 0), class: 'warn' },
      { label: 'Blocked', value: fmtNum(t.Blocked || 0), class: 'danger' },
    ],
    columns: [
      { key: 'kategori', label: 'Kategori' },
      { key: 'jumlah', label: 'Jumlah Request' },
      { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}

function showReqRateModal(){
  const d = STATE.request_distribution;
  if (!d || !d.hourly) { alert('Data belum ditarik'); return; }
  const rows = [...d.hourly].sort((a,b)=>{
    return periodSortKey(b.period, b.hour).localeCompare(periodSortKey(a.period, a.hour));
  }).map(r=>({ period: r.period, hour: r.hour, category: r.category, count: fmtNum(r.request_count) }));
  openModal({
    title: 'REQUEST RATE - Data per Jam',
    subtitle: `Total ${rows.length} baris · X-axis: ${DR.unit}`,
    info: [
      { label: 'Total Baris', value: fmtNum(rows.length) },
      { label: 'Unit', value: DR.unit.toUpperCase() },
    ],
    columns: [
      { key: 'period', label: 'Tanggal' },
      { key: 'hour', label: 'Jam' },
      { key: 'category', label: 'Kategori', format: (v)=>
        `<span class="badge ${v==='Clean'?'badge-safe':(v==='Alerted'?'badge-warn':'badge-danger')}">${v}</span>`
      },
      { key: 'count', label: 'Jumlah Request' },
    ],
    rows,
  });
}

function showReqDistModal(){
  const d = STATE.request_distribution;
  if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_category || {};
  const total = Object.values(t).reduce((a,b)=>a+b,0) || 1;
  const rows = Object.entries(t).map(([k,v])=>({
    kategori: k, jumlah: fmtNum(v), persen: ((v/total)*100).toFixed(2)+'%',
  }));
  openModal({
    title: 'TRAFFIC COMPOSITION',
    subtitle: 'Distribusi Clean vs Alerted vs Blocked',
    info: [{ label: 'Total', value: fmtNum(total) }],
    columns: [
      { key: 'kategori', label: 'Kategori', format: (v)=>
        `<span class="badge ${v==='Clean'?'badge-safe':(v==='Alerted'?'badge-warn':'badge-danger')}">${v}</span>`
      },
      { key: 'jumlah', label: 'Jumlah' },
      { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}

function showHeatmapModal(){
  const d = STATE.top_violator_ip;
  if (!d || !d.hourly) { alert('Data belum ditarik'); return; }
  const rows = [...d.hourly].sort((a,b)=>{
    return periodSortKey(b.period, b.hour).localeCompare(periodSortKey(a.period, a.hour));
  }).map(r=>({
    period: r.period, hour: r.hour, ip_client: r.ip_client,
    violation: r.violation, count: fmtNum(r.violation_count),
  }));
  openModal({
    title: 'ATTACK HEATMAP',
    subtitle: `${rows.length} baris pelanggaran`,
    info: [
      { label: 'Total Baris', value: fmtNum(rows.length) },
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
    ],
    columns: [
      { key: 'period', label: 'Tanggal' },
      { key: 'hour', label: 'Jam' },
      { key: 'violation', label: 'Jenis Violation' },
      { key: 'count', label: 'Jumlah' },
    ],
    rows,
  });
}

function showRespRateModal(){
  const d = STATE.response_code;
  if (!d || !d.hourly) { alert('Data belum ditarik'); return; }
  const rows = [...d.hourly].sort((a,b)=>{
    return periodSortKey(b.period, b.hour).localeCompare(periodSortKey(a.period, a.hour));
  }).map(r=>({ period: r.period, hour: r.hour, code: r.response_code, count: fmtNum(r.request_count) }));
  openModal({
    title: 'HTTP RESPONSE TREND',
    subtitle: `${rows.length} baris respons HTTP`,
    info: [
      { label: 'Total Baris', value: fmtNum(rows.length) },
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
    ],
    columns: [
      { key: 'period', label: 'Tanggal' },
      { key: 'hour', label: 'Jam' },
      { key: 'code', label: 'Response Code' },
      { key: 'count', label: 'Jumlah' },
    ],
    rows,
  });
}

function showRespDistModal(){
  const d = STATE.response_code;
  if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_code || {};
  const sorted = Object.entries(t).sort((a,b)=>b[1]-a[1]);
  const total = sorted.reduce((s, [,v])=>s+v, 0) || 1;
  const rows = sorted.map(([code, count])=>({
    code, count: fmtNum(count), persen: ((count/total)*100).toFixed(2)+'%',
  }));
  openModal({
    title: 'STATUS CODE DISTRIBUTION',
    subtitle: `${sorted.length} kode respons`,
    info: [
      { label: 'Total', value: fmtNum(total) },
      { label: 'Kode Unik', value: sorted.length },
    ],
    columns: [
      { key: 'code', label: 'Response Code' },
      { key: 'count', label: 'Jumlah' },
      { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}

function showTopIPModal(){
  const d = STATE.top_client_ip;
  if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ ip_client: x.ip_client, count: fmtNum(x.request_count) }));
  openModal({
    title: 'TOP ATTACKERS',
    subtitle: `Top ${rows.length} IP`,
    info: [
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
      { label: 'IP Ditampilkan', value: rows.length },
    ],
    columns: [
      { key: 'ip_client', label: 'IP Client' },
      { key: 'count', label: 'Jumlah Request' },
    ],
    rows,
  });
}

function showViolatorModal(){
  const d = STATE.top_violator_ip;
  if (!d || !d.by_ip) { alert('Data belum ditarik'); return; }
  const rows = [...d.by_ip].sort((a,b)=> b.violation_count - a.violation_count).map(r=>({
    ip_client: r.ip_client,
    violation: r.violation, count: fmtNum(r.violation_count),
    total_ip: fmtNum(r.total_request_ip),
  }));
  openModal({
    title: 'TOP VIOLATORS',
    subtitle: `${rows.length} baris data violator`,
    info: [
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
      { label: 'Total Baris', value: fmtNum(rows.length) },
    ],
    columns: [
      { key: 'ip_client', label: 'IP Client' },
      { key: 'violation', label: 'Violation' },
      { key: 'count', label: 'Jumlah Violation' },
      { key: 'total_ip', label: 'Total Request IP' },
    ],
    rows,
  });
}

function showSigModal(){
  const d = STATE.top_signatures;
  if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ sig_id: x.sig_id, count: fmtNum(x.request_count) }));
  openModal({
    title: 'TOP ATTACK SIGNATURES',
    subtitle: `Top ${rows.length} signature IDs`,
    info: [
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
      { label: 'Total Sig', value: rows.length },
    ],
    columns: [
      { key: 'sig_id', label: 'Signature ID' },
      { key: 'count', label: 'Jumlah Event' },
    ],
    rows,
  });
}

function showViolModal(){
  const d = STATE.violations;
  if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ violation: x.violation, count: fmtNum(x.violation_count) }));
  openModal({
    title: 'VIOLATION CATEGORIES',
    subtitle: `${rows.length} jenis pelanggaran`,
    info: [
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
      { label: 'Jenis Violation', value: rows.length },
    ],
    columns: [
      { key: 'violation', label: 'Jenis Pelanggaran' },
      { key: 'count', label: 'Jumlah Event' },
    ],
    rows,
  });
}

function showTopURLModal(){
  const d = STATE.top_url;
  if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ uri: x.uri, count: fmtNum(x.request_count) }));
  openModal({
    title: 'ENDPOINT PALING SERING DISERANG',
    subtitle: `Top ${rows.length} URI`,
    info: [
      { label: 'Grand Total', value: fmtNum(d.grand_total) },
      { label: 'URI Ditampilkan', value: rows.length },
    ],
    columns: [
      { key: 'uri', label: 'URI' },
      { key: 'count', label: 'Jumlah Request' },
    ],
    rows,
  });
}

const SEE_DATA_HANDLERS = {
  threat: showThreatModal,
  severity: showSeverityModal,
  livestats: showLiveStatsModal,
  reqrate: showReqRateModal,
  reqdist: showReqDistModal,
  heatmap: showHeatmapModal,
  resprate: showRespRateModal,
  respdist: showRespDistModal,
  topip: showTopIPModal,
  violator: showViolatorModal,
  sig: showSigModal,
  viol: showViolModal,
  topurl: showTopURLModal,
};

function bindSeeDataButtons(){
  document.querySelectorAll('.btn-see-data').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      const key = btn.dataset.see;
      const handler = SEE_DATA_HANDLERS[key];
      if (handler) handler();
    });
  });
}

// ============================================================
// FILTER TOGGLE & PANEL
// ============================================================
function bindFilterToggles(){
  document.querySelectorAll('#filterReqRate .toggle-chip').forEach(chip=>{
    const cat = chip.dataset.cat;
    chip.addEventListener('click', (e)=>{
      e.preventDefault();
      const cb = chip.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      FILTERS.reqRate[cat] = cb.checked;
      chip.classList.toggle('active', cb.checked);
      renderRequestRate();
    });
  });

  document.querySelectorAll('.btn-filter').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      const target = btn.dataset.filterTarget;
      const panelMap = {
        resp:     'filterRespPanel',
        respdist: 'filterRespDistPanel',
        ip:       'filterIPPanel',
        viol:     'filterViolPanel',
        sig:      'filterSigPanel',
        violdist: 'filterViolDistPanel',
        url:      'filterURLPanel',
      };
      const panelId = panelMap[target];
      if (!panelId) return;
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const willOpen = panel.classList.contains('hidden');

      Object.values(panelMap).forEach(id=>{
        const p = document.getElementById(id);
        if (p) p.classList.add('hidden');
      });
      document.querySelectorAll('.btn-filter').forEach(b=>b.classList.remove('active'));

      if (willOpen){
        panel.classList.remove('hidden');
        btn.classList.add('active');
      }
    });
  });
}

// ============================================================
// REFRESH
// ============================================================
function shiftDate(d, n, u){
  const x = new Date(d);
  if (u === 'seconds') x.setSeconds(x.getSeconds() - n);
  if (u === 'minutes') x.setMinutes(x.getMinutes() - n);
  if (u === 'hours')   x.setHours(x.getHours() - n);
  if (u === 'days')    x.setDate(x.getDate() - n);
  if (u === 'weeks')   x.setDate(x.getDate() - n*7);
  if (u === 'months')  x.setMonth(x.getMonth() - n);
  if (u === 'years')   x.setFullYear(x.getFullYear() - n);
  return x;
}

// Rentang relatif ("Last 8 months", "Last 3 hours", Today, ...) selalu dihitung ulang
// dari waktu SEKARANG saat data ditarik. Rentang custom (tanggal tetap) tidak diubah.
function refreshRange(){
  if (DR.mode === 'quick' && DR.quickVal){
    const r = computeFromQuick(DR.quickVal);
    DR.start = r.start; DR.end = r.end;
  } else if (DR.rel){
    const now = new Date();
    DR.start = shiftDate(now, DR.rel.num, DR.rel.unit); DR.end = now;
  }
  updateRangeInfo();
}

function setLastUpdate(ok){
  const el = document.getElementById('lastUpdate');
  if (!el) return;
  const d = new Date();
  el.textContent = (ok ? '● Diperbarui ' : '⚠ Sebagian gagal · ') + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  el.classList.toggle('stale', !ok);
}

async function refreshAll(opts){
  const silent = !!(opts && opts.silent === true);   // auto-refresh: tanpa overlay & filter tidak di-reset
  if (REFRESHING) return;
  REFRESHING = true;
  refreshRange();
  if (!silent) setLoading(true, 'Menarik semua data dari Kibana… (mohon tunggu)');

  if (!silent){
  FILTERS.resp.clear();
  FILTERS.respdist.clear();
  FILTERS.ip.clear();
  FILTERS.viol.clear();
  FILTERS.sig.clear();
  FILTERS.violdist.clear();
  FILTERS.url.clear();
  }

  const types = ['request_distribution','response_code','top_client_ip','top_url',
                 'top_signatures','violations','top_violator_ip'];
  try{
    const results = await Promise.allSettled(types.map(t=>fetchData(t)));
    types.forEach((t,i)=>{
      if (results[i].status==='fulfilled') STATE[t] = results[i].value;
      else console.error(`Gagal ${t}:`, results[i].reason);
    });
    renderAll();
    const failed = types.map((t,i)=> results[i].status==='rejected'
      ? `${t}: ${(results[i].reason && results[i].reason.message) || 'error'}` : null).filter(Boolean);
    setLastUpdate(!failed.length);
    if (failed.length){
      if (silent) console.warn('Auto-refresh sebagian gagal:', failed);
      else alert('Sebagian data gagal:\n- ' + failed.join('\n- '));
    }
  }catch(e){
    setLastUpdate(false);
    if (!silent) alert('Gagal refresh: '+e.message);
  }finally{
    REFRESHING = false;
    if (!silent) setLoading(false);
  }
}

// ============================================================
// EVENTS
// ============================================================
const drBtn = document.getElementById('drBtn');
const drPanel = document.getElementById('drPanel');
drBtn.addEventListener('click', (e)=>{ e.stopPropagation(); drPanel.classList.toggle('hidden'); });
document.addEventListener('click', (e)=>{
  if (!document.getElementById('dateRangePicker').contains(e.target)){
    drPanel.classList.add('hidden');
  }
});

document.getElementById('drQuickApply').addEventListener('click', ()=>{
  const num = parseInt(document.getElementById('drQuickNum').value, 10);
  const unit = document.getElementById('drQuickUnit').value;
  const mode = document.getElementById('drQuickMode').value;
  if (!num || num < 1){ alert('Masukkan angka minimal 1'); return; }
  const now = new Date();
  const delta = (d, n, u, sign) => {
    const x = new Date(d);
    if (u === 'seconds') x.setSeconds(x.getSeconds() + sign*n);
    if (u === 'minutes') x.setMinutes(x.getMinutes() + sign*n);
    if (u === 'hours')   x.setHours(x.getHours() + sign*n);
    if (u === 'days')    x.setDate(x.getDate() + sign*n);
    if (u === 'weeks')   x.setDate(x.getDate() + sign*n*7);
    if (u === 'months')  x.setMonth(x.getMonth() + sign*n);
    if (u === 'years')   x.setFullYear(x.getFullYear() + sign*n);
    return x;
  };
  let start, end, label;
  if (mode === 'last'){ start = delta(now, num, unit, -1); end = now; label = `Last ${num} ${unit}`; }
  else { start = now; end = delta(now, num, unit, +1); label = `Next ${num} ${unit}`; }
  DR.mode='custom'; DR.start=start; DR.end=end; DR.label=label;
  DR.unit=unit; DR.num=num;
  DR.rel = (mode === 'last') ? { num, unit } : null;
  updateDRLabel(); updateRangeInfo(); syncCustomInputsFromDR();
  drPanel.classList.add('hidden');
  refreshAll();
});

document.getElementById('drCustomApply').addEventListener('click', ()=>{
  const start = readCustomInputs('Start');
  const end = readCustomInputs('End');
  const diffMs = end - start;
  const diffDays = diffMs / (1000*60*60*24);
  let unit = 'days';
  if (diffDays <= 1) unit = 'hours';
  else if (diffDays <= 60) unit = 'days';
  else if (diffDays <= 730) unit = 'months';
  else unit = 'years';
  if (!setCustom(start, end, null, unit)) return;
  drPanel.classList.add('hidden');
  refreshAll();
});

['Start','End'].forEach(prefix=>{
  document.getElementById(`dr${prefix}Month`).addEventListener('change', ()=> updateDayOptions(prefix));
  document.getElementById(`dr${prefix}Year`).addEventListener('change', ()=> updateDayOptions(prefix));
});

document.getElementById('btnRefreshAll').addEventListener('click', refreshAll);
document.getElementById('btnLoadRaw').addEventListener('click', async ()=>{
  setLoading(true, 'Menarik raw log…');
  try{
    const data = await fetchData('raw_log_detail');
    STATE.raw_log_detail = data;
    renderRawTable();
  }catch(e){ alert('Gagal: '+e.message); }
  finally{ setLoading(false); }
});

// ============================================================
// AUTO REFRESH (realtime tiap 5 menit, tanpa overlay)
// ============================================================
function initAutoRefresh(){
  const btn = document.getElementById('btnAuto');
  const paint = ()=>{
    if (!btn) return;
    btn.textContent = AUTO.on ? 'Auto 5m: ON' : 'Auto 5m: OFF';
    btn.classList.toggle('on', AUTO.on);
  };
  const start = ()=>{
    clearInterval(AUTO.timer);
    if (AUTO.on) AUTO.timer = setInterval(()=>{
      const modalOpen = !document.getElementById('modalOverlay').classList.contains('hidden');
      if (!document.hidden && !modalOpen) refreshAll({silent:true});
    }, AUTO.ms);
  };
  if (btn) btn.addEventListener('click', ()=>{ AUTO.on = !AUTO.on; paint(); start(); });
  // kembali ke tab setelah lama -> segarkan
  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden && AUTO.on) refreshAll({silent:true});
  });
  paint(); start();
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', ()=>{
  fillStaticOptions();
  setQuick('last-8M');
  startClock();
  initModal();
  bindSeeDataButtons();
  bindFilterToggles();

  initAutoRefresh();
  refreshAll();      // selalu tarik langsung dari Kibana saat halaman dibuka

});