// ============================================================
// WAF SOC DASHBOARD - APP LOGIC (v11: tema gelap/terang + anti-lag)
// ============================================================

const API = '';
const STATE = {};

if (typeof ChartDataLabels !== 'undefined'){
  Chart.register(ChartDataLabels);
}


// ============================================================
// THEME (GELAP / TERANG)
// ============================================================
const THEME_KEY = 'waf-theme';
let LAST_FETCH_TS = Date.now();

function getTheme(){
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function rerenderChartsNoAnim(){
  if (!STATE.request_distribution && !STATE.response_code) return;
  CHART_ANIM = false;
  try { renderAll(); } finally { CHART_ANIM = true; }
}
function applyTheme(t, persist){
  const root = document.documentElement;
  root.classList.add('theme-anim');
  root.setAttribute('data-theme', t);
  if (persist !== false){ try{ localStorage.setItem(THEME_KEY, t); }catch(e){} }
  const btn = document.getElementById('btnTheme');
  if (btn){
    btn.title = t === 'light' ? 'Ganti ke mode gelap' : 'Ganti ke mode terang';
    btn.setAttribute('aria-label', btn.title);
  }
  rerenderChartsNoAnim();
  setTimeout(()=> root.classList.remove('theme-anim'), 400);
}
function initTheme(){
  const btn = document.getElementById('btnTheme');
  applyTheme(getTheme(), false);
  if (btn) btn.addEventListener('click', ()=> applyTheme(getTheme() === 'light' ? 'dark' : 'light'));
}

const DR = {
  mode: 'quick', quickVal: 'last-8M', label: 'Last 8 months',
  start: null, end: null, unit: 'months', num: 8, rel: null,
};
let REFRESHING = false;
const AUTO = { on: true, ms: 5 * 60 * 1000, timer: null, rawMs: 60 * 1000, rawTimer: null };

const FILTERS = {
  reqRate:  { Clean: true, Alerted: true, Blocked: true },
  resp: new Set(), respdist: new Set(), ip: new Set(), viol: new Set(),
  sig: new Set(), violdist: new Set(), url: new Set(), violtype: new Set(),
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
    if (d.getSeconds() % 10 === 0 && typeof updateLogMeta === 'function') updateLogMeta();
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

function liveRange(){
  if (DR.mode === 'quick' && DR.quickVal){
    const r = computeFromQuick(DR.quickVal);
    return { start: r.start, end: r.end };
  }
  if (DR.rel){
    const now = new Date();
    return { start: shiftDate(now, DR.rel.num, DR.rel.unit), end: now };
  }
  return { start: DR.start, end: DR.end };
}

async function fetchData(type, range){
  const r = range || { start: DR.start, end: DR.end };
  const params = new URLSearchParams({
    start_iso: toISO(r.start),
    end_iso:   toISO(r.end),
    _t: Date.now(),
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
// ANALISIS SERANGAN
// ============================================================
const SEV_KEYS = ['Critical','High','Medium','Low','Unclassified'];
const SEV_CLASS = { Critical:'danger', High:'danger', Medium:'warn', Low:'safe', Unclassified:'' };
const SEV_BADGE = { Critical:'badge-danger', High:'badge-danger', Medium:'badge-warn', Low:'badge-safe', Unclassified:'' };

const THREAT_COLORS = {
  'VERY LOW':'#00e676', 'LOW':'#a8d84a', 'MEDIUM':'#ffd54f', 'HIGH':'#ff9f43', 'CRITICAL':'#ff4757'
};
const THREAT_CLASS = {
  'VERY LOW':'', 'LOW':'', 'MEDIUM':'warning', 'HIGH':'warning', 'CRITICAL':'danger'
};
const THREAT_WEIGHT_ALERTED = 0.40;
const THREAT_WEIGHT_BLOCKED = 0.40;
const THREAT_WEIGHT_SPIKE   = 0.20;
const ALERTED_FULL_RATE = 4.0;
const BLOCKED_FULL_RATE = 2.0;
const SPIKE_FULL_RATIO  = 3.0;
const THREAT_TREND_MIN_EVENTS = 50;

function threatKategori(score){
  if (score < 20)  return ['VERY LOW','#00e676'];
  if (score < 40)  return ['LOW','#a8d84a'];
  if (score < 60)  return ['MEDIUM','#ffd54f'];
  if (score < 80)  return ['HIGH','#ff9f43'];
  return ['CRITICAL','#ff4757'];
}

const DAY_SHORT = ['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
const DAY_FULL  = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];

const SEV_RULES_CLIENT = [
  { sev:'Low', keys:['cookie not rfc','failed to convert character','length','illegal url length','n/a'] },
  { sev:'Critical', keys:['attack signature','threat campaign','brute force','csrf','ssrf','malicious','backdoor','shell','sql injection','command execution','remote code','rce','deserialization'] },
  { sev:'High', keys:['evasion technique','illegal file type','illegal meta character','illegal url','illegal parameter','illegal header','illegal method','data guard','information leakage','web scraping','bot','disallowed','access from','path traversal','directory','xss','cross site','ldap','xml external','xxe'] },
  { sev:'Medium', keys:['http protocol compliance','malformed','illegal repeated','mandatory','illegal query string','illegal http status','request content type','cookies'] },
];
const SEV_RANK_CLIENT = { Critical:0, High:1, Medium:2, Low:3, Unclassified:4 };

function classifyViolationClient(name){
  let best = null;
  String(name || '').split(/[,;|]/).forEach(part=>{
    const p = part.trim().toLowerCase();
    if (!p) return;
    for (const r of SEV_RULES_CLIENT){
      if (r.keys.some(k => p.includes(k))){
        if (best === null || SEV_RANK_CLIENT[r.sev] < SEV_RANK_CLIENT[best]) best = r.sev;
        break;
      }
    }
  });
  return best || 'Unclassified';
}

function buildFallbackAttackAnalysis(){
  const rd = STATE.request_distribution;
  const viol = STATE.violations;
  const tvi = STATE.top_violator_ip;

  if (!rd && !viol) return null;

  const grand = rd ? (rd.grand_total || 0) : 0;
  const alerted = rd ? ((rd.totals_by_category||{}).Alerted || 0) : 0;
  const blocked = rd ? ((rd.totals_by_category||{}).Blocked || 0) : 0;
  const attack = alerted + blocked;

  const hourMap = {};
  if (rd && rd.hourly){
    rd.hourly.forEach(r=>{
      if (r.category === 'Clean') return;
      const k = r.period + '|' + r.hour;
      hourMap[k] = (hourMap[k] || 0) + r.request_count;
    });
  }

  const sev = { Critical:0, High:0, Medium:0, Low:0, Unclassified:0 };
  const violList = [];
  if (viol && viol.top){
    viol.top.forEach(v=>{
      const cls = classifyViolationClient(v.violation);
      sev[cls] = (sev[cls] || 0) + v.violation_count;
      violList.push({ violation: v.violation, severity: cls, count: v.violation_count });
    });
  }
  const classified = sev.Critical + sev.High + sev.Medium + sev.Low;
  sev.Unclassified = Math.max(0, attack - classified);

  const total = Math.max(grand, 1);
  const alertedRate = (alerted / total) * 100;
  const blockedRate = (blocked / total) * 100;
  const alertedScore = Math.min(100, (alertedRate / ALERTED_FULL_RATE) * 100);
  const blockedScore = Math.min(100, (blockedRate / BLOCKED_FULL_RATE) * 100);

  let last24 = 0, spikeScore = 0, spikeRatio = 0, detailSpike = '';
  const hourlySusp = [];
  if (tvi && tvi.hourly){
    tvi.hourly.forEach(r=>{
      hourlySusp.push({ period: r.period, hour: r.hour, count: r.violation_count });
    });
  }
  const now = new Date();
  const cutoffMs = now.getTime() - 24*3600*1000;
  let earlierTotal = 0, earlierMinMs = now.getTime();
  hourlySusp.forEach(r=>{
    const [dd,mm,yyyy] = r.period.split('-');
    const hh = parseInt(r.hour.split(':')[0],10);
    const t = new Date(parseInt(yyyy,10), parseInt(mm,10)-1, parseInt(dd,10), hh).getTime();
    if (t >= cutoffMs) last24 += r.count;
    else { earlierTotal += r.count; if (t < earlierMinMs) earlierMinMs = t; }
  });
  const spanDays = Math.max((now.getTime() - earlierMinMs) / 86400000, 1);
  if (last24 >= THREAT_TREND_MIN_EVENTS){
    const baseDaily = earlierTotal / Math.max(spanDays - 1, 1);
    spikeRatio = baseDaily > 0 ? last24 / baseDaily : SPIKE_FULL_RATIO;
    spikeScore = Math.min(100, (spikeRatio / SPIKE_FULL_RATIO) * 100);
    detailSpike = `24 jam terakhir: ${fmtNum(last24)} aktivitas vs baseline harian ${Math.round(baseDaily)} (${spikeRatio.toFixed(2)}x)`;
  } else {
    detailSpike = `24 jam terakhir: ${fmtNum(last24)} aktivitas (di bawah ambang ${THREAT_TREND_MIN_EVENTS}, dianggap normal)`;
  }

  const score = Math.round(
    alertedScore * THREAT_WEIGHT_ALERTED +
    blockedScore * THREAT_WEIGHT_BLOCKED +
    spikeScore   * THREAT_WEIGHT_SPIKE
  );
  const [status, color] = threatKategori(score);

  return {
    _fallback: true,
    range: rd ? rd.range : {start:null,end:null},
    grand_total: grand,
    attack_total: attack,
    attack_alerted: alerted,
    attack_blocked: blocked,
    hourly: Object.keys(hourMap).map(k=>{
      const [period, hour] = k.split('|');
      return { period, hour, count: hourMap[k] };
    }),
    severity: sev,
    violations: violList,
    unclassified: violList.filter(v => v.severity === 'Unclassified').slice(0,10),
    threat: {
      score, status, color,
      alerted_rate_pct: alertedRate,
      blocked_rate_pct: blockedRate,
      spike_ratio: spikeRatio,
      last24_events: last24,
      components: [
        { key:'alerted', label:`Alerted Rate (bobot ${Math.round(THREAT_WEIGHT_ALERTED*100)}%)`,
          points: Math.round(alertedScore * THREAT_WEIGHT_ALERTED * 10)/10,
          max: Math.round(THREAT_WEIGHT_ALERTED*100),
          detail: `${fmtNum(alerted)} dari ${fmtNum(total)} request ditandai Alerted (${alertedRate.toFixed(2)}%) · skor komponen ${alertedScore.toFixed(1)}/100 (poin penuh di ${ALERTED_FULL_RATE}%)` },
        { key:'blocked', label:`Blocked Rate (bobot ${Math.round(THREAT_WEIGHT_BLOCKED*100)}%)`,
          points: Math.round(blockedScore * THREAT_WEIGHT_BLOCKED * 10)/10,
          max: Math.round(THREAT_WEIGHT_BLOCKED*100),
          detail: `${fmtNum(blocked)} dari ${fmtNum(total)} request diblokir WAF (${blockedRate.toFixed(2)}%) · skor komponen ${blockedScore.toFixed(1)}/100 (poin penuh di ${BLOCKED_FULL_RATE}%)` },
        { key:'spike', label:`Lonjakan 24 Jam (bobot ${Math.round(THREAT_WEIGHT_SPIKE*100)}%)`,
          points: Math.round(spikeScore * THREAT_WEIGHT_SPIKE * 10)/10,
          max: Math.round(THREAT_WEIGHT_SPIKE*100),
          detail: detailSpike },
      ],
    },
    warnings: ['Data dihitung di frontend (fallback). Ganti backend ke v10-threat-weighted untuk hasil paling akurat.'],
  };
}

function ensureAttackAnalysis(){
  if (STATE.attack_analysis) return;
  const fb = buildFallbackAttackAnalysis();
  if (fb) STATE.attack_analysis = fb;
}

function fmtPct(v, total, dec){
  if (!total) return '0%';
  return ((v / total) * 100).toFixed(dec === undefined ? 1 : dec).replace('.', ',') + '%';
}

// ============================================================
// THREAT LEVEL (Poin 3: Diringkas)
// ============================================================
function computeThreatLevel(){
  const a = STATE.attack_analysis;
  if (!a || !a.threat){
    return {available:false, score:0, status:'TIDAK ADA DATA', color:'#7a8aa3', cls:'',
            components:[], total:0, attack:0, alerted:0, blocked:0,
            alertedRate:0, blockedRate:0, last24:0};
  }
  const th = a.threat;
  return {
    available:true, score: th.score, status: th.status,
    color: th.color || THREAT_COLORS[th.status] || '#7a8aa3',
    cls: THREAT_CLASS[th.status] || '',
    components: th.components || [],
    total: a.grand_total || 0, attack: a.attack_total || 0,
    alerted: a.attack_alerted || 0,
    blocked: a.attack_blocked || 0,
    alertedRate: th.alerted_rate_pct || 0,
    blockedRate: th.blocked_rate_pct || 0,
    last24: th.last24_events || 0,
  };
}

function renderPosture(){
  ensureAttackAnalysis();
  const t = computeThreatLevel();
  gaugeChart('gaugeThreat', t.score, 100, t.status, t.color);
  const scoreEl = document.getElementById('threatScore');
  scoreEl.textContent = t.available ? t.score : '--';
  scoreEl.style.color = t.color;
  const statusEl = document.getElementById('threatStatus');
  statusEl.textContent = t.status;
  statusEl.style.color = t.color;

  const parts = document.getElementById('threatParts');
  if (parts && !t.available){
    parts.innerHTML = '<div class="pending-note">Menunggu data analisis serangan dari backend.</div>';
  } else if (parts){
    const info = `<div class="tp-info">
      <b>${fmtNum(t.alerted)} Alerted</b> · <b>${fmtNum(t.blocked)} Blocked</b><br>
      <span class="tp-muted">24 jam terakhir: ${t.last24 > 0
        ? fmtNum(t.last24) + ' aktivitas mencurigakan'
        : 'tidak terdapat lonjakan aktivitas serangan'}</span>
    </div>`;
    
    // Menghilangkan teks detail panjang di bawah bar, diganti tooltip (title)
    parts.innerHTML = info + t.components.map(c=>{
      const w = c.max ? Math.min(100, (c.points / c.max) * 100) : 0;
      return `<div class="tp-row" title="${escapeHtml(c.detail)}">
        <div class="tp-top"><span class="tp-name">${escapeHtml(c.label)}</span>
          <span class="tp-pts">${String(c.points).replace('.', ',')} <small>/ ${c.max}</small></span></div>
        <span class="tp-bar"><i style="width:${w}%;background:${t.color}"></i></span>
      </div>`;
    }).join('');
  }

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
// ATTACK HEATMAP
// ============================================================
function buildHeatBuckets(){
  const a = STATE.attack_analysis;
  const bucket = Array.from({length: 7}, () => new Array(24).fill(0));
  let total = 0;
  if (a && a.hourly){
    a.hourly.forEach(r=>{
      const [dd, mm, yyyy] = r.period.split('-');
      const dow = (new Date(parseInt(yyyy,10), parseInt(mm,10)-1, parseInt(dd,10)).getDay() + 6) % 7;
      const hh = parseInt(r.hour.split(':')[0], 10);
      bucket[dow][hh] += r.count;
      total += r.count;
    });
  }
  return {bucket, total};
}

function renderHeatmap(){
  ensureAttackAnalysis();
  const grid = document.getElementById('heatmapGrid');
  if (!grid) return;
  if (!STATE.attack_analysis){
    grid.innerHTML = '';
    const i0 = document.getElementById('heatInsights');
    if (i0) i0.innerHTML = '<div class="pending-note">Menunggu data analisis serangan.</div>';
    return;
  }
  const {bucket, total} = buildHeatBuckets();

  let maxVal = 0, peak = {d:0, h:0};
  const dayTot = new Array(7).fill(0), hourTot = new Array(24).fill(0);
  for (let d=0; d<7; d++) for (let h=0; h<24; h++){
    const v = bucket[d][h];
    dayTot[d] += v; hourTot[h] += v;
    if (v > maxVal){ maxVal = v; peak = {d, h}; }
  }

  let html = `<div></div>`;
  for (let h=0; h<24; h++) html += `<div class="heatmap-hour">${pad2(h)}</div>`;
  
  for (let d=0; d<7; d++){
    html += `<div class="heatmap-label">${DAY_SHORT[d]}</div>`;
    for (let h=0; h<24; h++){
      const val = bucket[d][h];
      const ratio = maxVal ? (val / maxVal) : 0; 
      
      let color = 'var(--cell-empty)';
      if (val > 0){
        if (ratio <= 0.25) {
          const op = 0.4 + (ratio/0.25)*0.6;
          color = `rgba(0, 230, 118, ${op})`; // Low: Hijau
        } else if (ratio <= 0.5) {
          color = `rgba(255, 213, 79, 0.9)`; // Medium: Kuning
        } else if (ratio <= 0.75) {
          color = `rgba(255, 159, 67, 0.9)`; // High: Oranye
        } else {
          color = `rgba(255, 71, 87, 1)`; // Critical: Merah
        }
      }
      html += `<div class="heatmap-cell" style="background:${color}" title="${DAY_FULL[d]} ${pad2(h)}:00–${pad2(h)}:59 WIB · ${fmtNum(val)} serangan"></div>`;
    }
  }
  grid.innerHTML = html;

  const minEl = document.getElementById('heatMin'), maxEl = document.getElementById('heatMax');
  if (minEl) minEl.textContent = '0';
  if (maxEl) maxEl.textContent = fmtNum(maxVal);

  const ins = document.getElementById('heatInsights');
  if (!ins) return;
  if (!total){
    ins.innerHTML = `<div class="heat-ins"><span>Info</span><b>Tidak ada serangan</b><em>pada periode ini</em></div>`;
    return;
  }
  const topDay  = dayTot.indexOf(Math.max(...dayTot));
  const topHour = hourTot.indexOf(Math.max(...hourTot));
  let off = 0; for (let h=0; h<24; h++) if (h >= 18 || h < 6) off += hourTot[h];
  ins.innerHTML = `
    <div class="heat-ins"><span>Total</span><b>${fmtNum(total)}</b><em>request</em></div>
    <div class="heat-ins"><span>Puncak</span><b>${DAY_SHORT[peak.d]} ${pad2(peak.h)}:00</b><em>${fmtNum(maxVal)} serangan</em></div>
    <div class="heat-ins"><span>Hari</span><b>${DAY_FULL[topDay]}</b><em>${fmtPct(dayTot[topDay], total)}</em></div>
    <div class="heat-ins"><span>Jam</span><b>${pad2(topHour)}:00</b><em>${fmtPct(hourTot[topHour], total)}</em></div>
    <div class="heat-ins"><span>Off-Hours</span><b>${fmtPct(off, total)}</b><em>18:00–05:59</em></div>`;
}

// ============================================================
// PALET WARNA
// ============================================================
const COLORS_TOP_IP = ['#ff4757','#ff6348','#ff7f50','#ff9f43','#ffa726','#ffd54f','#a8d84a','#66bb6a','#26c6da','#54a0ff'];
const COLORS_TOP_URL = ['#9d7bff','#8b6ef0','#7b61ff','#6c5ce7','#5c6bc0','#54a0ff','#4dd0e1','#26c6da','#00bcd4','#00acc1'];
const COLORS_VIOLATION = ['#ff4757','#ff6348','#ff7f50','#ff9f43','#ffa726','#ffd54f','#a8d84a','#66bb6a','#26c6da','#54a0ff','#9d7bff','#b06eff','#ec407a','#26a69a','#5c6bc0'];

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
  const btn = document.getElementById(btnId); if (!btn) return;
  btn.addEventListener('click', ()=>{ activeSet.clear(); allKeys.forEach(k => activeSet.add(k)); onChange(); });
}
function bindMiniBtnNone(btnId, activeSet, onChange){
  const btn = document.getElementById(btnId); if (!btn) return;
  btn.addEventListener('click', ()=>{ activeSet.clear(); onChange(); });
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
    if (!grouped[key]) grouped[key] = { period: r.period, hour: r.hour, Clean:0, Alerted:0, Blocked:0 };
    grouped[key][r.category] += r.request_count;
  });
  const keys = Object.keys(grouped).sort();
  const labels = keys.map(k => formatXLabel(grouped[k].period, grouped[k].hour, DR.unit));
  const colors = {Clean:'#00e676', Blocked:'#ff4757', Alerted:'#ff9f43'};
  const datasets = ['Clean','Blocked','Alerted'].map(cat=>({
    label: cat, data: keys.map(k=> grouped[k][cat] || 0),
    borderColor: colors[cat], backgroundColor: colors[cat] + '15', fill: true, borderWidth: 2.5,
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
  doughnutChart('chartReqDist', labels, data, labels.map(l => cmap[l] || '#00d4ff'), {legend:'bottom'});
}

// ============================================================
// HTTP RESPONSE TREND
// ============================================================
function renderResponseRate(){
  const d = STATE.response_code; if (!d) return;
  const allCodes = Object.entries(d.totals_by_code || {}).sort((a,b)=>b[1]-a[1])
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
    label: code, data: keys.map(k => grouped[k][code] || 0),
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length] + '15', fill: true, borderWidth: 2.5,
  }));
  lineChart('chartRespRate', labels, datasets);
}

// ============================================================
// STATUS CODE DIST
// ============================================================
function renderResponseDist(){
  const d = STATE.response_code; if (!d) return;
  const allCodes = Object.entries(d.totals_by_code || {}).sort((a,b)=>b[1]-a[1]).map(([code, count])=>{
    const color = code === '200' ? '#00e676' : code === '404' ? '#ff4757' : code === '400' ? '#ff9f43'
                : code === '500' ? '#b06eff' : code === '0' ? '#7a8aa3'
                : PALETTE[Object.keys(d.totals_by_code).indexOf(code) % PALETTE.length];
    return { key: code, label: code, count, color };
  });
  if (FILTERS.respdist.size === 0 && allCodes.length > 0){
    allCodes.slice(0,5).forEach(c => FILTERS.respdist.add(c.key));
  }
  buildFilterList('filterRespDistList', allCodes, FILTERS.respdist, ()=>renderResponseDist());
  bindMiniBtn('fpRespDistAll', FILTERS.respdist, allCodes.map(c=>c.key), ()=>renderResponseDist());
  bindMiniBtnNone('fpRespDistNone', FILTERS.respdist, ()=>renderResponseDist());
  const active = allCodes.filter(c => FILTERS.respdist.has(c.key));
  vBarChart('chartRespDist', active.map(x=>x.label), active.map(x=>x.count), { colors: active.map(x=>x.color) });
}

// ============================================================
// TOP ATTACKERS
// ============================================================
function renderTopIP(){
  const d = STATE.top_client_ip; if (!d) return;
  const allItems = d.top.slice(0,20).map((x, i)=>({
    key: x.ip_client, label: x.ip_client, count: x.request_count,
    color: COLORS_TOP_IP[i % COLORS_TOP_IP.length],
  }));
  if (FILTERS.ip.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.ip.add(x.key));
  }
  buildFilterList('filterIPList', allItems, FILTERS.ip, ()=>renderTopIP());
  bindMiniBtn('fpIPAll', FILTERS.ip, allItems.map(c=>c.key), ()=>renderTopIP());
  bindMiniBtnNone('fpIPNone', FILTERS.ip, ()=>renderTopIP());
  const active = allItems.filter(x => FILTERS.ip.has(x.key));
  hBarChart('chartTopIP', active.map(x=>x.label), active.map(x=>x.count), { colors: active.map(x=>x.color), compact: true });
}

// ============================================================
// TOP VIOLATORS
// ============================================================
function renderViolator(){
  const d = STATE.top_violator_ip; if (!d) return;
  const allItems = d.top_ips.slice(0,20).map(x=>({ key: x.ip_client, label: x.ip_client, count: x.total_request_ip }));
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
  
  const typeItems = violList.map((v,i)=>({key: v, label: v, count: 0, color: PALETTE[i % PALETTE.length]}));
  if (FILTERS.violtype.size === 0 && typeItems.length > 0) {
      typeItems.forEach(t => FILTERS.violtype.add(t.key));
  }
  buildFilterList('filterViolTypeList', typeItems, FILTERS.violtype, ()=>renderViolator());
  bindMiniBtn('fpViolTypeAll', FILTERS.violtype, typeItems.map(t=>t.key), ()=>renderViolator());
  bindMiniBtnNone('fpViolTypeNone', FILTERS.violtype, ()=>renderViolator());

  const activeViolTypes = violList.filter(v => FILTERS.violtype.has(v));

  const labels = active.map(x=>x.label);
  const datasets = activeViolTypes.map((v, i)=>({
    label: v.length>18 ? v.slice(0,18)+'…' : v,
    data: labels.map(ip => (vByIp[ip] && vByIp[ip][v]) || 0),
    backgroundColor: PALETTE[i % PALETTE.length], borderRadius: 3, barThickness: 20,
  }));
  stackedBarChart('chartViolator', labels, datasets);
}

// ============================================================
// ATTACK SIGNATURES
// ============================================================
function renderSig(){
  const d = STATE.top_signatures; if (!d) return;
  const allItems = d.top.slice(0,30).map((x, i)=>({
    key: x.sig_id, label: x.sig_id, count: x.request_count,
    color: PALETTE[i % PALETTE.length],
  }));
  if (FILTERS.sig.size === 0 && allItems.length > 0){
    allItems.slice(0,15).forEach(x => FILTERS.sig.add(x.key));
  }
  buildFilterList('filterSigList', allItems, FILTERS.sig, ()=>renderSig());
  bindMiniBtn('fpSigAll', FILTERS.sig, allItems.map(c=>c.key), ()=>renderSig());
  bindMiniBtnNone('fpSigNone', FILTERS.sig, ()=>renderSig());
  const active = allItems.filter(x => FILTERS.sig.has(x.key));
  vBarChart('chartSig', active.map(x=>x.label), active.map(x=>x.count), { colors: active.map(x=>x.color) });
}

// ============================================================
// VIOLATION CATEGORIES
// ============================================================
function renderViol(){
  const d = STATE.violations; if (!d || !d.top) return;
  const allItems = d.top.map((x, i)=>({
    key: x.violation, label: x.violation, count: x.violation_count,
    color: COLORS_VIOLATION[i % COLORS_VIOLATION.length],
  }));
  if (FILTERS.violdist.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.violdist.add(x.key));
  }
  buildFilterList('filterViolDistList', allItems, FILTERS.violdist, ()=>{ renderViol(); });
  bindMiniBtn('fpViolDistAll', FILTERS.violdist, allItems.map(c=>c.key), ()=>renderViol());
  bindMiniBtnNone('fpViolDistNone', FILTERS.violdist, ()=>renderViol());
  const active = allItems.filter(x => FILTERS.violdist.has(x.key));
  doughnutChart('chartViol', active.map(x=>x.label), active.map(x=>x.count), active.map(x=>x.color), { legend: 'right' });
}

// ============================================================
// ENDPOINT
// ============================================================
function renderTopURL(){
  const d = STATE.top_url; if (!d) return;
  const allItems = d.top.slice(0,20).map((x, i)=>({
    key: x.uri, label: x.uri, count: x.request_count,
    color: COLORS_TOP_URL[i % COLORS_TOP_URL.length],
  }));
  if (FILTERS.url.size === 0 && allItems.length > 0){
    allItems.slice(0,10).forEach(x => FILTERS.url.add(x.key));
  }
  buildFilterList('filterURLList', allItems, FILTERS.url, ()=>renderTopURL());
  bindMiniBtn('fpURLAll', FILTERS.url, allItems.map(c=>c.key), ()=>renderTopURL());
  bindMiniBtnNone('fpURLNone', FILTERS.url, ()=>renderTopURL());
  const active = allItems.filter(x => FILTERS.url.has(x.key));
  hBarChart('chartTopURL', active.map(x=>x.label), active.map(x=>x.count), { colors: active.map(x=>x.color), compact: true, longLabel: true });
}

// ============================================================
// LIVE LOG STREAM
// ============================================================
const KMON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function kibanaTimestamp(iso){
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const w = new Date(d.getTime() + 7 * 3600 * 1000);
  return {
    label: `${KMON[w.getUTCMonth()]} ${w.getUTCDate()}, ${w.getUTCFullYear()} @ ` +
           `${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}:${pad2(w.getUTCSeconds())}.` +
           String(w.getUTCMilliseconds()).padStart(3, '0'),
    epoch: d.getTime() / 1000,
  };
}
function normalizeRaw(d){
  if (!d || !d.rows || !d.rows.length) return d;
  const isoRe = /^\d{4}-\d{2}-\d{2}T/;
  if (isoRe.test(String(d.rows[0].log_time || ''))){
    d.rows.forEach(r=>{
      const k = kibanaTimestamp(r.log_time);
      if (k){ r.log_time = k.label; r.log_epoch = k.epoch; } else { r.log_epoch = 0; }
    });
  }
  d.rows.sort((a,b)=> (b.log_epoch || 0) - (a.log_epoch || 0));
  if (!d.latest_epoch){
    d.latest_epoch = d.rows[0].log_epoch || 0;
    d.latest_log_time = d.rows[0].log_time;
  }
  if (!d.fetched_at){
    const n = new Date(Date.now() + 7 * 3600 * 1000);
    d.fetched_at = `${n.getUTCFullYear()}-${pad2(n.getUTCMonth()+1)}-${pad2(n.getUTCDate())} ${pad2(n.getUTCHours())}:${pad2(n.getUTCMinutes())}:${pad2(n.getUTCSeconds())}`;
  }
  return d;
}
function fmtAge(sec){
  if (sec < 0) sec = 0;
  if (sec < 60) return `${Math.floor(sec)} dtk lalu`;
  if (sec < 3600) return `${Math.floor(sec/60)} mnt lalu`;
  if (sec < 86400) return `${Math.floor(sec/3600)} jam ${Math.floor((sec%3600)/60)} mnt lalu`;
  return `${Math.floor(sec/86400)} hari lalu`;
}
function updateLogMeta(){
  const el = document.getElementById('logMeta'); if (!el) return;
  const d = STATE.raw_log_detail;
  if (!d || !d.latest_log_time){ el.textContent = 'Belum ada data log.'; return; }
  const age = Date.now()/1000 - d.latest_epoch;
  const cls = age < 300 ? 'fresh' : (age < 1800 ? 'aging' : 'stale');
  el.innerHTML = `Log terbaru: <b>${escapeHtml(d.latest_log_time)}</b> ` +
    `(<span class="log-age ${cls}">${fmtAge(age)}</span>) · ditarik ${escapeHtml((d.fetched_at || '').slice(11))} WIB · baris teratas = log terbaru`;
}
function renderRawTable(){
  const d = normalizeRaw(STATE.raw_log_detail);
  const tbody = document.querySelector('#tblRaw tbody');
  if (!d || !d.rows || !d.rows.length){
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Belum ada data.</td></tr>`;
    document.getElementById('reqCount').textContent = '(0 documents)';
    updateLogMeta(); return;
  }
  document.getElementById('reqCount').textContent = `(${fmtNum(d.total_fetched)} documents)`;
  const e = v => (v === null || v === undefined || v === '') ? '–' : escapeHtml(v);
  tbody.innerHTML = d.rows.map(r=>`
    <tr>
      <td>${e(r.log_time)}</td><td>${e(r.ip_client)}</td><td>${e(r.source_ip)}</td>
      <td>${e(r.host_ip)}</td><td>${e(r.method)}</td><td>${e(r.x_forwarded_for)}</td>
      <td>${e(r.dest_port)}</td><td title="${escapeHtml(r.uri || '')}">${e(r.uri)}</td>
      <td>${e(r.response_code)}</td><td>${e(r.request_status)}</td>
    </tr>
  `).join('');
  const sc = document.querySelector('#tblRaw').closest('.table-scroll');
  if (sc) sc.scrollTop = 0;
  updateLogMeta();
}
let RAW_BUSY = false;
async function refreshRaw(opts){
  const silent = !!(opts && opts.silent);
  if (RAW_BUSY) return;
  RAW_BUSY = true;
  if (!silent) setLoading(true, 'Menarik raw log…');
  try{
    STATE.raw_log_detail = await fetchData('raw_log_detail', liveRange());
    renderRawTable();
  }catch(err){
    console.error('Gagal raw log:', err);
    if (!silent) alert('Gagal: ' + err.message);
  }finally{
    RAW_BUSY = false;
    if (!silent) setLoading(false);
  }
}

// ============================================================
// KPI SPARKLINES
// ============================================================
function renderKPI(){
  const d = STATE.request_distribution; if (!d) return;
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
// MODAL
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
        <span class="mii-label">${it.label}</span><span class="mii-value">${it.value}</span>
      </div>`).join('');
    MODAL.infoEl.style.display = 'flex';
  } else { MODAL.infoEl.style.display = 'none'; }
  MODAL.theadEl.innerHTML = `<tr>${config.columns.map(c=>`<th>${c.label}</th>`).join('')}</tr>`;
  if (!config.rows || !config.rows.length){
    MODAL.tbodyEl.innerHTML = `<tr><td colspan="${config.columns.length}" class="empty">Tidak ada data</td></tr>`;
  } else {
    MODAL.tbodyEl.innerHTML = config.rows.map(row=>`
      <tr>${config.columns.map(c=>{
        let val = row[c.key]; if (c.format) val = c.format(val, row);
        return `<td>${val ?? '–'}</td>`;
      }).join('')}</tr>`).join('');
  }
  MODAL.el.classList.remove('hidden');
}
function closeModal(){ if (MODAL.el) MODAL.el.classList.add('hidden'); }

// ============================================================
// POPUP HANDLERS
// ============================================================
function showThreatModal(){
  ensureAttackAnalysis();
  const t = computeThreatLevel();
  if (!t.available){ alert('Data analisis serangan belum ditarik'); return; }
  const rows = t.components.map(c=>({
    komponen: c.label, poin: String(c.points).replace('.', ','), maks: c.max, detail: c.detail,
  }));
  rows.push({ komponen: '<b>TOTAL SKOR</b>', poin: `<b>${t.score}</b>`, maks: 100, detail: `Status: ${t.status}` });
  openModal({
    title: 'THREAT LEVEL - Weighted Scoring (v10)',
    subtitle: `(Alerted×40%) + (Blocked×40%) + (Lonjakan×20%) · Skor ${t.score}/100 · ${t.status}`,
    info: [
      { label: 'Threat Score', value: t.score, class: t.cls },
      { label: 'Status', value: t.status, class: t.cls },
      { label: 'Total Request', value: fmtNum(t.total) },
      { label: 'Alerted', value: `${fmtNum(t.alerted)} <small style="color:var(--dim);font-size:11px">${t.alertedRate.toFixed(2)}%</small>`, class: 'warn' },
      { label: 'Blocked', value: `${fmtNum(t.blocked)} <small style="color:var(--dim);font-size:11px">${t.blockedRate.toFixed(2)}%</small>`, class: 'safe' },
      { label: '24 Jam Terakhir', value: fmtNum(t.last24) },
    ],
    columns: [
      { key: 'komponen', label: 'Komponen' }, { key: 'poin', label: 'Poin' },
      { key: 'maks', label: 'Maks' }, { key: 'detail', label: 'Perhitungan' },
    ],
    rows,
  });
}
function showLiveStatsModal(){
  const d = STATE.request_distribution; if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_category || {}, total = d.grand_total || 0;
  const rows = [
    { kategori: 'Total Request', jumlah: fmtNum(total), persen: '100%' },
    { kategori: 'Clean', jumlah: fmtNum(t.Clean || 0), persen: ((t.Clean/total)*100).toFixed(2)+'%' },
    { kategori: 'Alerted', jumlah: fmtNum(t.Alerted || 0), persen: ((t.Alerted/total)*100).toFixed(2)+'%' },
    { kategori: 'Blocked', jumlah: fmtNum(t.Blocked || 0), persen: ((t.Blocked/total)*100).toFixed(2)+'%' },
  ];
  openModal({
    title: 'LIVE STATS', subtitle: `Periode: ${fmtDTFull(DR.start)} → ${fmtDTFull(DR.end)}`,
    info: [
      { label: 'Total', value: fmtNum(total) },
      { label: 'Clean', value: fmtNum(t.Clean || 0), class: 'safe' },
      { label: 'Alerted', value: fmtNum(t.Alerted || 0), class: 'warn' },
      { label: 'Blocked', value: fmtNum(t.Blocked || 0), class: 'danger' },
    ],
    columns: [
      { key: 'kategori', label: 'Kategori' }, { key: 'jumlah', label: 'Jumlah Request' },
      { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}
function showReqRateModal(){
  const d = STATE.request_distribution; if (!d || !d.hourly) { alert('Data belum ditarik'); return; }
  const rows = [...d.hourly].sort((a,b)=>periodSortKey(b.period, b.hour).localeCompare(periodSortKey(a.period, a.hour)))
    .map(r=>({ period: r.period, hour: r.hour, category: r.category, count: fmtNum(r.request_count) }));
  openModal({
    title: 'REQUEST RATE - Data per Jam', subtitle: `Total ${rows.length} baris · X-axis: ${DR.unit}`,
    info: [{ label: 'Total Baris', value: fmtNum(rows.length) }, { label: 'Unit', value: DR.unit.toUpperCase() }],
    columns: [
      { key: 'period', label: 'Tanggal' }, { key: 'hour', label: 'Jam' },
      { key: 'category', label: 'Kategori', format: (v)=>
        `<span class="badge ${v==='Clean'?'badge-safe':(v==='Alerted'?'badge-warn':'badge-danger')}">${v}</span>` },
      { key: 'count', label: 'Jumlah Request' },
    ],
    rows,
  });
}
function showReqDistModal(){
  const d = STATE.request_distribution; if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_category || {};
  const total = Object.values(t).reduce((a,b)=>a+b,0) || 1;
  const rows = Object.entries(t).map(([k,v])=>({ kategori: k, jumlah: fmtNum(v), persen: ((v/total)*100).toFixed(2)+'%' }));
  openModal({
    title: 'TRAFFIC COMPOSITION', subtitle: 'Distribusi Clean vs Alerted vs Blocked',
    info: [{ label: 'Total', value: fmtNum(total) }],
    columns: [
      { key: 'kategori', label: 'Kategori', format: (v)=>
        `<span class="badge ${v==='Clean'?'badge-safe':(v==='Alerted'?'badge-warn':'badge-danger')}">${v}</span>` },
      { key: 'jumlah', label: 'Jumlah' }, { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}
function showHeatmapModal(){
  ensureAttackAnalysis();
  const a = STATE.attack_analysis; if (!a || !a.hourly) { alert('Data analisis serangan belum ditarik'); return; }
  const {bucket, total} = buildHeatBuckets();
  let maxVal = 0, peak = {d:0, h:0};
  for (let d=0; d<7; d++) for (let h=0; h<24; h++) if (bucket[d][h] > maxVal){ maxVal = bucket[d][h]; peak = {d, h}; }
  const rows = [...a.hourly].sort((x,y)=>periodSortKey(y.period, y.hour).localeCompare(periodSortKey(x.period, x.hour)))
    .map(r=>({ period: r.period, hour: r.hour, count: r.count }));
  openModal({
    title: 'ATTACK HEATMAP',
    subtitle: `${fmtNum(rows.length)} jam dengan serangan · WIB`,
    info: [
      { label: 'Total Serangan', value: fmtNum(total), class: 'warn' },
      { label: 'Jam Aktif', value: fmtNum(rows.length) },
      { label: 'Puncak', value: maxVal ? `${DAY_SHORT[peak.d]} ${pad2(peak.h)}:00` : '–' },
      { label: 'Serangan di Puncak', value: fmtNum(maxVal), class: 'danger' },
    ],
    columns: [
      { key: 'period', label: 'Tanggal' }, { key: 'hour', label: 'Jam' },
      { key: 'count', label: 'Jumlah Serangan', format: v => fmtNum(v) },
    ],
    rows,
  });
}
function showRespRateModal(){
  const d = STATE.response_code; if (!d || !d.hourly) { alert('Data belum ditarik'); return; }
  const rows = [...d.hourly].sort((a,b)=>periodSortKey(b.period, b.hour).localeCompare(periodSortKey(a.period, a.hour)))
    .map(r=>({ period: r.period, hour: r.hour, code: r.response_code, count: fmtNum(r.request_count) }));
  openModal({
    title: 'HTTP RESPONSE TREND', subtitle: `${rows.length} baris respons HTTP`,
    info: [{ label: 'Total Baris', value: fmtNum(rows.length) }, { label: 'Grand Total', value: fmtNum(d.grand_total) }],
    columns: [
      { key: 'period', label: 'Tanggal' }, { key: 'hour', label: 'Jam' },
      { key: 'code', label: 'Response Code' }, { key: 'count', label: 'Jumlah' },
    ],
    rows,
  });
}
function showRespDistModal(){
  const d = STATE.response_code; if (!d) { alert('Data belum ditarik'); return; }
  const t = d.totals_by_code || {};
  const sorted = Object.entries(t).sort((a,b)=>b[1]-a[1]);
  const total = sorted.reduce((s, [,v])=>s+v, 0) || 1;
  const rows = sorted.map(([code, count])=>({ code, count: fmtNum(count), persen: ((count/total)*100).toFixed(2)+'%' }));
  openModal({
    title: 'STATUS CODE DISTRIBUTION', subtitle: `${sorted.length} kode respons`,
    info: [{ label: 'Total', value: fmtNum(total) }, { label: 'Kode Unik', value: sorted.length }],
    columns: [
      { key: 'code', label: 'Response Code' }, { key: 'count', label: 'Jumlah' },
      { key: 'persen', label: 'Persentase' },
    ],
    rows,
  });
}
function showTopIPModal(){
  const d = STATE.top_client_ip; if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ ip_client: x.ip_client, count: fmtNum(x.request_count) }));
  openModal({
    title: 'TOP ATTACKERS', subtitle: `Top ${rows.length} IP`,
    info: [{ label: 'Grand Total', value: fmtNum(d.grand_total) }, { label: 'IP Ditampilkan', value: rows.length }],
    columns: [{ key: 'ip_client', label: 'IP Client' }, { key: 'count', label: 'Jumlah Request' }],
    rows,
  });
}
function showViolatorModal(){
  const d = STATE.top_violator_ip; if (!d || !d.by_ip) { alert('Data belum ditarik'); return; }
  const rows = [...d.by_ip].sort((a,b)=>b.violation_count - a.violation_count).map(r=>({
    ip_client: r.ip_client, violation: r.violation, count: fmtNum(r.violation_count), total_ip: fmtNum(r.total_request_ip),
  }));
  openModal({
    title: 'TOP VIOLATORS', subtitle: `${rows.length} baris data violator`,
    info: [{ label: 'Grand Total', value: fmtNum(d.grand_total) }, { label: 'Total Baris', value: fmtNum(rows.length) }],
    columns: [
      { key: 'ip_client', label: 'IP Client' }, { key: 'violation', label: 'Violation' },
      { key: 'count', label: 'Jumlah Violation' }, { key: 'total_ip', label: 'Total Request IP' },
    ],
    rows,
  });
}
function showSigModal(){
  const d = STATE.top_signatures; if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ sig_id: x.sig_id, count: fmtNum(x.request_count) }));
  openModal({
    title: 'TOP ATTACK SIGNATURES', subtitle: `Top ${rows.length} signature IDs`,
    info: [{ label: 'Grand Total', value: fmtNum(d.grand_total) }, { label: 'Total Sig', value: rows.length }],
    columns: [{ key: 'sig_id', label: 'Signature ID' }, { key: 'count', label: 'Jumlah Event' }],
    rows,
  });
}
function showViolModal(){
  const d = STATE.violations; if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ violation: x.violation, count: fmtNum(x.violation_count) }));
  openModal({
    title: 'VIOLATION CATEGORIES', subtitle: `${rows.length} jenis pelanggaran`,
    info: [{ label: 'Grand Total', value: fmtNum(d.grand_total) }, { label: 'Jenis Violation', value: rows.length }],
    columns: [{ key: 'violation', label: 'Jenis Pelanggaran' }, { key: 'count', label: 'Jumlah Event' }],
    rows,
  });
}
function showTopURLModal(){
  const d = STATE.top_url; if (!d || !d.top) { alert('Data belum ditarik'); return; }
  const rows = d.top.map(x=>({ uri: x.uri, count: fmtNum(x.request_count) }));
  openModal({
    title: 'ENDPOINT PALING SERING DISERANG', subtitle: `Top ${rows.length} URI`,
    info: [{ label: 'Grand Total', value: fmtNum(d.grand_total) }, { label: 'URI Ditampilkan', value: rows.length }],
    columns: [{ key: 'uri', label: 'URI' }, { key: 'count', label: 'Jumlah Request' }],
    rows,
  });
}

const SEE_DATA_HANDLERS = {
  threat: showThreatModal, livestats: showLiveStatsModal,
  reqrate: showReqRateModal, reqdist: showReqDistModal, heatmap: showHeatmapModal,
  resprate: showRespRateModal, respdist: showRespDistModal, topip: showTopIPModal,
  violator: showViolatorModal, sig: showSigModal, viol: showViolModal, topurl: showTopURLModal,
};
function bindSeeDataButtons(){
  document.querySelectorAll('.btn-see-data').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      const handler = SEE_DATA_HANDLERS[btn.dataset.see];
      if (handler) handler();
    });
  });
}

// ============================================================
// FILTER TOGGLE
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
        resp:'filterRespPanel', respdist:'filterRespDistPanel', ip:'filterIPPanel',
        viol:'filterViolPanel', violtype:'filterViolTypePanel', sig:'filterSigPanel', violdist:'filterViolDistPanel', url:'filterURLPanel',
      };
      const panelId = panelMap[target]; if (!panelId) return;
      const panel = document.getElementById(panelId); if (!panel) return;
      const willOpen = panel.classList.contains('hidden');
      Object.values(panelMap).forEach(id=>{
        const p = document.getElementById(id); if (p) p.classList.add('hidden');
      });
      document.querySelectorAll('.btn-filter').forEach(b=>b.classList.remove('active'));
      if (willOpen){ panel.classList.remove('hidden'); btn.classList.add('active'); }
    });
  });
}

// ============================================================
// STATUS NOTICE
// ============================================================
function showNotice(failed){
  const el = document.getElementById('statusNotice'); if (!el) return;
  if (!failed || !failed.length){ el.classList.add('hidden'); el.innerHTML = ''; return; }
  const others = failed.filter(f => !String(f).includes('tidak dikenal'));
  if (!others.length){ el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.innerHTML = `<b>⚠ Sebagian data gagal ditarik:</b><ul>${others.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`;
  el.classList.remove('hidden');
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
function refreshRange(){
  if ((DR.mode === 'quick' && DR.quickVal) || DR.rel){
    const r = liveRange(); DR.start = r.start; DR.end = r.end;
  }
  updateRangeInfo();
}
function setLastUpdate(ok){
  const el = document.getElementById('lastUpdate'); 
  const card = document.getElementById('lastUpdateCard');
  if (!el) return;
  const d = new Date();
  el.textContent = (ok ? 'Diperbarui ' : 'Sebagian gagal · ') + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if(card) card.classList.toggle('stale', !ok);
}

async function refreshAll(opts){
  const silent = !!(opts && opts.silent === true);
  if (REFRESHING) return;
  REFRESHING = true;
  refreshRange();
  if (!silent) setLoading(true, 'Menarik semua data dari Kibana… (mohon tunggu)');

  if (!silent){
    FILTERS.resp.clear(); FILTERS.respdist.clear(); FILTERS.ip.clear();
    FILTERS.viol.clear(); FILTERS.violtype.clear(); FILTERS.sig.clear(); FILTERS.violdist.clear(); FILTERS.url.clear();
  }

  const types = ['request_distribution','response_code','top_client_ip','top_url',
                 'top_signatures','violations','top_violator_ip','attack_analysis','raw_log_detail'];
  try{
    const results = await Promise.allSettled(types.map(t=>fetchData(t)));
    types.forEach((t,i)=>{
      if (results[i].status==='fulfilled') STATE[t] = results[i].value;
      else console.error(`Gagal ${t}:`, results[i].reason);
    });
    if (!STATE.attack_analysis){
      ensureAttackAnalysis();
    }
    CHART_ANIM = !silent;           // refresh senyap: tanpa animasi (tidak berkedip/lag)
    try { renderAll(); } finally { CHART_ANIM = true; }
    LAST_FETCH_TS = Date.now();
    const failed = types.map((t,i)=> results[i].status==='rejected'
      ? `${t}: ${(results[i].reason && results[i].reason.message) || 'error'}` : null).filter(Boolean);
    const critical = failed.filter(f => !String(f).startsWith('attack_analysis:'));
    setLastUpdate(!critical.length);
    showNotice(critical);
    if (failed.length) console.warn('Sebagian data gagal:', failed);
  }catch(e){
    setLastUpdate(false);
    showNotice(['refresh: ' + e.message]);
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
  if (!document.getElementById('dateRangePicker').contains(e.target)) drPanel.classList.add('hidden');
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
  drPanel.classList.add('hidden'); refreshAll();
});
document.getElementById('drCustomApply').addEventListener('click', ()=>{
  const start = readCustomInputs('Start'), end = readCustomInputs('End');
  const diffDays = (end - start) / (1000*60*60*24);
  let unit = 'days';
  if (diffDays <= 1) unit = 'hours';
  else if (diffDays <= 60) unit = 'days';
  else if (diffDays <= 730) unit = 'months';
  else unit = 'years';
  if (!setCustom(start, end, null, unit)) return;
  drPanel.classList.add('hidden'); refreshAll();
});
['Start','End'].forEach(prefix=>{
  document.getElementById(`dr${prefix}Month`).addEventListener('change', ()=> updateDayOptions(prefix));
  document.getElementById(`dr${prefix}Year`).addEventListener('change', ()=> updateDayOptions(prefix));
});
document.getElementById('btnRefreshAll').addEventListener('click', refreshAll);
document.getElementById('btnLoadRaw').addEventListener('click', ()=> refreshRaw());

// ============================================================
// AUTO REFRESH
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
    clearInterval(AUTO.rawTimer);
    if (AUTO.on){
      AUTO.timer = setInterval(()=>{
        const modalOpen = !document.getElementById('modalOverlay').classList.contains('hidden');
        if (!document.hidden && !modalOpen) refreshAll({silent:true});
      }, AUTO.ms);
      AUTO.rawTimer = setInterval(()=>{
        if (!document.hidden && !REFRESHING) refreshRaw({silent:true});
      }, AUTO.rawMs);
    }
  };
  if (btn) btn.addEventListener('click', ()=>{ AUTO.on = !AUTO.on; paint(); start(); });
  document.addEventListener('visibilitychange', ()=>{
    if (document.hidden) return;
    // 1) Rapikan chart yang animasinya tertahan saat tab disembunyikan
    settleCharts();
    // 2) Tarik data ulang HANYA bila data sudah basi (> interval auto-refresh)
    if (AUTO.on && !REFRESHING && (Date.now() - LAST_FETCH_TS) > AUTO.ms){
      setTimeout(()=> refreshAll({silent:true}), 250);
    }
  });
  // Ukuran window berubah / zoom berubah -> gambar ulang rapi tanpa animasi
  let _rz; window.addEventListener('resize', ()=>{ clearTimeout(_rz); _rz = setTimeout(settleCharts, 150); });
  // Kembali fokus ke jendela / halaman dipulihkan dari cache browser
  window.addEventListener('focus', settleCharts);
  window.addEventListener('pageshow', settleCharts);
  paint(); start();
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', ()=>{
  initTheme();
  fillStaticOptions();
  setQuick('last-8M');
  startClock();
  initModal();
  bindSeeDataButtons();
  bindFilterToggles();
  initAutoRefresh();
  refreshAll();
});