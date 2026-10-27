// ============================================================
// WAF SOC - CHART HELPERS (v11: dark/light theme + anti-lag)
// ============================================================
const CHARTS = {};
const PALETTE = [
  '#a78bfa','#22d3ee','#00e676','#ff9f43','#ff4757',
  '#54a0ff','#f472b6','#26c6da','#66bb6a','#ffca28',
  '#ef5350','#5c6bc0','#29b6f6','#9ccc65','#ff7043',
];
const NUM_FMT = new Intl.NumberFormat('id-ID');

// Saat false, semua chart yang dibuat TANPA animasi
// (dipakai untuk auto-refresh senyap, ganti tema, dan kembali dari tab lain)
let CHART_ANIM = true;

// ---------- THEME: baca warna dari CSS variable ----------
function cssv(name, fb){
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
function TH(){
  return {
    text:     cssv('--c-text',      '#d6dced'),
    mut:      cssv('--c-mut',       '#8b93b3'),
    grid:     cssv('--c-grid',      'rgba(139,147,179,.10)'),
    track:    cssv('--c-track',     'rgba(255,255,255,.045)'),
    cross:    cssv('--c-cross',     'rgba(167,139,250,.45)'),
    label:    cssv('--c-label',     '#ffffff'),
    center:   cssv('--c-center',    '#ffffff'),
    remain:   cssv('--c-remain',    'rgba(255,255,255,.06)'),
    tipBg:    cssv('--c-tip-bg',    'rgba(10,10,18,.96)'),
    tipBd:    cssv('--c-tip-bd',    'rgba(167,139,250,.35)'),
    tipTitle: cssv('--c-tip-title', '#a78bfa'),
    tipBody:  cssv('--c-tip-body',  '#ffffff'),
    hoverPt:  cssv('--c-hover-pt',  '#ffffff'),
  };
}
function syncDefaults(){
  Chart.defaults.font.family = "'Inter',system-ui,sans-serif";
  Chart.defaults.color = TH().mut;
}
syncDefaults();

function anim(d, extra){
  return CHART_ANIM ? Object.assign({duration:d, easing:'easeOutQuart'}, extra || {}) : false;
}
function tooltipStyle(callbacks){
  const t = TH();
  return {
    backgroundColor:t.tipBg, borderColor:t.tipBd, borderWidth:1,
    padding:12, cornerRadius:12, boxPadding:6,
    titleColor:t.tipTitle, bodyColor:t.tipBody,
    titleFont:{size:11, weight:'700'}, bodyFont:{size:12, weight:'600'},
    callbacks,
  };
}


// ============================================================
// UKURAN CHART MANUAL (kebal terhadap CSS `zoom` & pindah tab)
// ------------------------------------------------------------
// Masalah lama: Chart.js (responsive:true) mengukur wadah pakai
// getBoundingClientRect() -> ukuran SETELAH di-zoom (.67). Lalu canvas
// diberi ukuran itu dan di-zoom LAGI oleh CSS => chart hanya ±67% dari
// wadahnya (terlihat "ngambang"), terutama setiap kali ada resize
// (misal saat kembali dari tab lain).
// Solusi: responsive:false + ukuran dihitung sendiri = rect / zoom.
// ============================================================
function uiZoom(){
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return (isFinite(z) && z > 0) ? z : 1;
}
function chartHost(c){
  const cv = c.canvas;
  return cv.dataset.fit === 'self' ? cv : cv.parentElement;
}
function fitChart(id, force){
  const c = CHARTS[id]; if (!c) return;
  const host = chartHost(c);
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;                 // tab/elemen tersembunyi -> abaikan
  const z = uiZoom();
  const w = Math.max(1, Math.round(r.width  / z));
  const h = Math.max(1, Math.round(r.height / z));
  const dpr = (window.devicePixelRatio || 1) * z;
  if (!force && c.__w === w && c.__h === h && c.__dpr === dpr) return;
  c.__w = w; c.__h = h; c.__dpr = dpr;
  c.options.devicePixelRatio = dpr;
  c.resize(w, h);
}
function fitAllCharts(force){ Object.keys(CHARTS).forEach(id => fitChart(id, force)); }

let _roQueued = false;
const RO = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(()=>{
  if (_roQueued) return; _roQueued = true;
  requestAnimationFrame(()=>{ _roQueued = false; fitAllCharts(false); });
}) : null;

function makeChart(id, el, config){
  config.options = config.options || {};
  config.options.responsive = false;
  config.options.maintainAspectRatio = false;
  config.options.devicePixelRatio = (window.devicePixelRatio || 1) * uiZoom();
  const ch = new Chart(el, config);
  CHARTS[id] = ch;
  const host = el.dataset.fit === 'self' ? el : el.parentElement;
  if (RO && host && !host.__ro){ host.__ro = true; RO.observe(host); }
  fitChart(id, true);
  return ch;
}

// ---------- UTIL ----------
function destroyChart(id){ if (CHARTS[id]){ CHARTS[id].destroy(); delete CHARTS[id]; } }
function fmtNum(n){ return (n === null || n === undefined) ? '0' : NUM_FMT.format(n); }
function fmtNumShort(n){ return fmtNum(n); }
function trunc(s, max){ s = String(s ?? ''); return s.length > max ? s.slice(0,max)+'…' : s; }
function hexA(hex, a){
  let h = String(hex).replace('#','');
  if (h.length === 3) h = h.split('').map(c=>c+c).join('');
  const n = parseInt(h,16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function vGrad(ctx, area, color, a0, a1){
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, hexA(color, a0)); g.addColorStop(1, hexA(color, a1));
  return g;
}

// ---------- ANTI-LAG: dipanggil saat kembali dari tab lain ----------
// Saat tab disembunyikan, browser menahan requestAnimationFrame sehingga animasi
// chart "menumpuk" dan terlihat ngambang/lag ketika tab dibuka lagi.
// Solusinya: hentikan animasi yang tertunda, ukur ulang canvas, lalu gambar final.
function settleCharts(){
  requestAnimationFrame(()=> requestAnimationFrame(()=>{
    Object.keys(CHARTS).forEach(id=>{
      const c = CHARTS[id];
      try{ c.stop(); fitChart(id, true); c.update('none'); }catch(e){}
    });
  }));
}

// garis vertikal saat hover (crosshair)
const crosshair = {
  id:'crosshair',
  afterDatasetsDraw(c){
    const a = c.tooltip && c.tooltip.getActiveElements && c.tooltip.getActiveElements();
    if (!a || !a.length) return;
    const x = a[0].element.x, {top,bottom} = c.chartArea, ctx = c.ctx;
    ctx.save(); ctx.strokeStyle = TH().cross; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke(); ctx.restore();
  }
};
// track (latar pill) di belakang bar
function trackPlugin(horizontal){
  return {
    id:'track',
    beforeDatasetsDraw(c){
      const m = c.getDatasetMeta(0), a = c.chartArea, ctx = c.ctx;
      ctx.save(); ctx.fillStyle = TH().track;
      m.data.forEach(b=>{
        ctx.beginPath();
        if (horizontal){ const h = b.height; ctx.roundRect(a.left, b.y-h/2, a.right-a.left, h, h/2); }
        else { const w = b.width; ctx.roundRect(b.x-w/2, a.top, w, a.bottom-a.top, w/2); }
        ctx.fill();
      });
      ctx.restore();
    }
  };
}

// ============================================================
// 1. LINE / AREA CHART (gradient)
// ============================================================
function lineChart(id, labels, datasets){
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const t = TH();
  const ds = datasets.map(d=>{
    const c = d.borderColor;
    return Object.assign({}, d, {
      borderWidth:2.5, tension:.4, pointRadius:0, pointHoverRadius:6,
      pointHoverBackgroundColor:t.hoverPt, pointHoverBorderColor:c, pointHoverBorderWidth:3,
      backgroundColor: d.fill ? (ctx)=>{
        const ch = ctx.chart; if (!ch.chartArea) return hexA(c,.2);
        return vGrad(ch.ctx, ch.chartArea, c, .38, 0);
      } : c,
    });
  });
  makeChart(id, el, {
    type:'line', data:{labels, datasets:ds},
    options:{
      animation:anim(900),
      interaction:{mode:'index', intersect:false},
      plugins:{
        legend:{position:'top', align:'end', labels:{boxWidth:8, boxHeight:8, usePointStyle:true, pointStyle:'circle', padding:14, color:t.text, font:{size:11, weight:'600'}}},
        tooltip:tooltipStyle({label:(c)=>` ${c.dataset.label}: ${fmtNum(c.parsed.y)}`}),
        datalabels:false
      },
      scales:{
        x:{grid:{display:false}, border:{display:false}, ticks:{color:t.mut, font:{size:10, weight:'600'}, maxRotation:0, autoSkip:true, maxTicksLimit:12}},
        y:{beginAtZero:true, border:{display:false}, grid:{color:t.grid}, ticks:{color:t.mut, font:{size:10, weight:'600'}, callback:(v)=>fmtNum(v)}}
      }
    },
    plugins:[crosshair]
  });
}

// ============================================================
// 2. DOUGHNUT (rounded + center total)
// ============================================================
function doughnutChart(id, labels, data, customColors, opts){
  opts = opts || {};
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const t = TH();
  const colors = customColors || PALETTE;
  const total = data.reduce((a,b)=>a+b,0);
  const center = {
    id:'center',
    afterDraw(c){
      const m = c.getDatasetMeta(0).data[0]; if (!m) return;
      const th = TH();
      const ctx = c.ctx; ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
      const txt = fmtNum(total), fs = txt.length > 11 ? 14 : txt.length > 9 ? 17 : txt.length > 7 ? 20 : 24;
      ctx.fillStyle=th.center; ctx.font=`800 ${fs}px Inter,sans-serif`; ctx.fillText(txt, m.x, m.y-8);
      ctx.fillStyle=th.mut; ctx.font="700 10px Inter,sans-serif"; ctx.fillText(opts.centerLabel || 'TOTAL', m.x, m.y+14);
      ctx.restore();
    }
  };
  makeChart(id, el, {
    type:'doughnut',
    data:{labels, datasets:[{data, backgroundColor:colors, borderWidth:0, borderRadius:8, spacing:3, hoverOffset:8}]},
    options:{
      cutout:'74%',
      animation:anim(900, {animateRotate:true, animateScale:true}),
      plugins:{
        legend:{
          position: opts.legend || 'right',
          labels:{
            boxWidth:9, boxHeight:9, usePointStyle:true, pointStyle:'circle', padding:12,
            color:t.text, font:{size:11, weight:'600'},
            generateLabels:(chart)=>{
              const d = chart.data;
              return d.labels.map((label,i)=>{
                const v = d.datasets[0].data[i];
                const pct = total ? ((v/total)*100).toFixed(1) : 0;
                return {
                  text:`${trunc(label,24)}  ${fmtNumShort(v)} (${pct}%)`,
                  fillStyle:d.datasets[0].backgroundColor[i], strokeStyle:'transparent', lineWidth:0,
                  fontColor:t.text, hidden:!chart.getDataVisibility(i), index:i,
                };
              });
            }
          }
        },
        tooltip:tooltipStyle({label:(ctx)=>{
          const pct = total ? ((ctx.parsed/total)*100).toFixed(2) : 0;
          return ` ${ctx.label}: ${fmtNum(ctx.parsed)} (${pct}%)`;
        }}),
        datalabels:false
      }
    },
    plugins:[center]
  });
}

// ============================================================
// 3. HORIZONTAL PILL BAR
// ============================================================
function hBarChart(id, labels, data, options){
  options = options || {};
  const compact = options.compact === true, longLabel = options.longLabel === true;
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const t = TH();
  const colors = options.colors || options.color || '#a78bfa';
  makeChart(id, el, {
    type:'bar',
    data:{labels, datasets:[{data, backgroundColor:colors, borderRadius:99, borderSkipped:false, barThickness: compact ? 12 : 16}]},
    options:{
      indexAxis:'y',
      animation:anim(900),
      layout:{padding:{right:92}},
      plugins:{
        legend:{display:false},
        tooltip:tooltipStyle({title:(i)=>labels[i[0].dataIndex], label:(ctx)=>` ${fmtNum(ctx.parsed.x)} request`}),
        datalabels:{anchor:'end', align:'right', offset:8, color:t.label, font:{size:11, weight:'700'}, formatter:(v)=>fmtNum(v)}
      },
      scales:{
        x:{display:false, beginAtZero:true},
        y:{grid:{display:false}, border:{display:false}, ticks:{autoSkip:false, color:t.text, font:{size:11, weight:'600'},
          callback:function(v){ return trunc(this.getLabelForValue(v), longLabel ? 46 : 20); }}}
      }
    },
    plugins:[trackPlugin(true)]
  });
}

// ============================================================
// 3b. VERTICAL PILL BAR
// ============================================================
function vBarChart(id, labels, data, options){
  options = options || {};
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const t = TH();
  const colors = options.colors || '#a78bfa';
  makeChart(id, el, {
    type:'bar',
    data:{labels, datasets:[{data, backgroundColor:(ctx)=>{
      const c = Array.isArray(colors) ? colors[ctx.dataIndex % colors.length] : colors;
      const ch = ctx.chart; if (!ch.chartArea) return c;
      return vGrad(ch.ctx, ch.chartArea, c, 1, .45);
    }, borderRadius:99, borderSkipped:false, maxBarThickness:26}]},
    options:{
      animation:anim(900),
      layout:{padding:{top:22}},
      plugins:{
        legend:{display:false},
        tooltip:tooltipStyle({title:(i)=>labels[i[0].dataIndex], label:(ctx)=>` ${fmtNum(ctx.parsed.y)}`}),
        datalabels:{anchor:'end', align:'top', offset:2, color:t.label, font:{size:10, weight:'700'}, formatter:(v)=>fmtNumShort(v)}
      },
      scales:{
        x:{grid:{display:false}, border:{display:false}, ticks:{autoSkip:false, maxRotation:40, minRotation:0, font:{size:10, weight:'600'}, color:t.text, callback:function(v){ return trunc(this.getLabelForValue(v), 12); }}},
        y:{display:false, beginAtZero:true}
      }
    },
    plugins:[trackPlugin(false)]
  });
}

// ============================================================
// 4. STACKED BAR (horizontal pill)
// ============================================================
function stackedBarChart(id, labels, datasets){
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const t = TH();
  const ds = datasets.map(d=>Object.assign({}, d, {borderRadius:6, barThickness:16}));
  makeChart(id, el, {
    type:'bar', data:{labels, datasets:ds},
    options:{
      indexAxis:'y',
      animation:anim(900),
      plugins:{
        legend:{position:'bottom', labels:{boxWidth:8, boxHeight:8, usePointStyle:true, pointStyle:'circle', padding:12, color:t.text, font:{size:10, weight:'600'}}},
        tooltip:tooltipStyle({label:(ctx)=>` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.x)}`}),
        datalabels:false
      },
      scales:{
        x:{stacked:true, border:{display:false}, grid:{color:t.grid}, ticks:{color:t.mut, font:{size:10, weight:'600'}, callback:(v)=>fmtNumShort(v)}},
        y:{stacked:true, grid:{display:false}, border:{display:false}, ticks:{color:t.text, font:{size:11, weight:'600'}, callback:function(v){ return trunc(this.getLabelForValue(v), 16); }}}
      }
    }
  });
}

// ============================================================
// 5. GAUGE (semi ring rounded)
// ============================================================
function gaugeChart(id, value, maxValue, label, color){
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  const remaining = Math.max(0, maxValue - value);
  makeChart(id, el, {
    type:'doughnut',
    data:{labels:['score','remain'], datasets:[{
      data:[value, remaining],
      backgroundColor:[color, TH().remain],
      borderWidth:0, borderRadius:[20,0], circumference:180, rotation:270,
    }]},
    options:{
      cutout:'80%',
      animation:anim(1100, {animateRotate:true}),
      plugins:{legend:{display:false}, tooltip:{enabled:false}, datalabels:false}
    }
  });
}

// ============================================================
// 6. SPARKLINE (untuk kartu KPI)
// ============================================================
function sparkline(id, data, color){
  destroyChart(id); syncDefaults();
  const el = document.getElementById(id); if (!el) return;
  el.dataset.fit = 'self';
  makeChart(id, el, {
    type:'line',
    data:{labels:data.map((_,i)=>i), datasets:[{
      data, borderColor:color, borderWidth:2, tension:.45, pointRadius:0, fill:true,
      backgroundColor:(ctx)=>{ const ch = ctx.chart; return ch.chartArea ? vGrad(ch.ctx, ch.chartArea, color, .35, 0) : hexA(color,.2); }
    }]},
    options:{
      animation:anim(900),
      layout:{padding:0},
      plugins:{legend:{display:false}, tooltip:{enabled:false}, datalabels:false},
      scales:{x:{display:false}, y:{display:false, beginAtZero:true}}
    }
  });
}