// ============================================================
// WAF SOC - CHART HELPERS (v7 modern)
// ============================================================
const CHARTS = {};
const PALETTE = [
  '#a78bfa','#22d3ee','#00e676','#ff9f43','#ff4757',
  '#54a0ff','#f472b6','#26c6da','#66bb6a','#ffca28',
  '#ef5350','#5c6bc0','#29b6f6','#9ccc65','#ff7043',
];
const NUM_FMT = new Intl.NumberFormat('id-ID');
const GRID_COLOR = 'rgba(139,147,179,.10)';
const TEXT_COLOR = '#8b93b3';

Chart.defaults.font.family = "'Inter',system-ui,sans-serif";
Chart.defaults.color = TEXT_COLOR;

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
const TOOLTIP = {
  backgroundColor:'rgba(10,10,18,.96)', borderColor:'rgba(167,139,250,.35)', borderWidth:1,
  padding:12, cornerRadius:12, boxPadding:6,
  titleColor:'#a78bfa', bodyColor:'#ffffff',
  titleFont:{size:11, weight:'700'}, bodyFont:{size:12, weight:'600'},
};

// garis vertikal saat hover (crosshair)
const crosshair = {
  id:'crosshair',
  afterDatasetsDraw(c){
    const a = c.tooltip && c.tooltip.getActiveElements && c.tooltip.getActiveElements();
    if (!a || !a.length) return;
    const x = a[0].element.x, {top,bottom} = c.chartArea, ctx = c.ctx;
    ctx.save(); ctx.strokeStyle = 'rgba(167,139,250,.45)'; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke(); ctx.restore();
  }
};
// track (latar pill) di belakang bar
function trackPlugin(horizontal){
  return {
    id:'track',
    beforeDatasetsDraw(c){
      const m = c.getDatasetMeta(0), a = c.chartArea, ctx = c.ctx;
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.045)';
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
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const ds = datasets.map(d=>{
    const c = d.borderColor;
    return Object.assign({}, d, {
      borderWidth:2.5, tension:.4, pointRadius:0, pointHoverRadius:6,
      pointHoverBackgroundColor:'#fff', pointHoverBorderColor:c, pointHoverBorderWidth:3,
      backgroundColor: d.fill ? (ctx)=>{
        const ch = ctx.chart; if (!ch.chartArea) return hexA(c,.2);
        return vGrad(ch.ctx, ch.chartArea, c, .38, 0);
      } : c,
    });
  });
  CHARTS[id] = new Chart(el, {
    type:'line', data:{labels, datasets:ds},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index', intersect:false},
      plugins:{
        legend:{position:'top', align:'end', labels:{boxWidth:8, boxHeight:8, usePointStyle:true, pointStyle:'circle', padding:14, color:'#d6dced', font:{size:11, weight:'600'}}},
        tooltip:Object.assign({}, TOOLTIP, {callbacks:{label:(c)=>` ${c.dataset.label}: ${fmtNum(c.parsed.y)}`}}),
        datalabels:false
      },
      scales:{
        x:{grid:{display:false}, border:{display:false}, ticks:{font:{size:10, weight:'600'}, maxRotation:0, autoSkip:true, maxTicksLimit:12}},
        y:{beginAtZero:true, border:{display:false}, grid:{color:GRID_COLOR}, ticks:{font:{size:10, weight:'600'}, callback:(v)=>fmtNum(v)}}
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
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const colors = customColors || PALETTE;
  const total = data.reduce((a,b)=>a+b,0);
  const center = {
    id:'center',
    afterDraw(c){
      const m = c.getDatasetMeta(0).data[0]; if (!m) return;
      const ctx = c.ctx; ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
      const txt = fmtNum(total), fs = txt.length > 11 ? 14 : txt.length > 9 ? 17 : txt.length > 7 ? 20 : 24;
      ctx.fillStyle='#fff'; ctx.font=`800 ${fs}px Inter,sans-serif`; ctx.fillText(txt, m.x, m.y-8);
      ctx.fillStyle='#8b93b3'; ctx.font="700 10px Inter,sans-serif"; ctx.fillText(opts.centerLabel || 'TOTAL', m.x, m.y+14);
      ctx.restore();
    }
  };
  CHARTS[id] = new Chart(el, {
    type:'doughnut',
    data:{labels, datasets:[{data, backgroundColor:colors, borderWidth:0, borderRadius:8, spacing:3, hoverOffset:8}]},
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'74%',
      animation:{animateRotate:true, animateScale:true, duration:900},
      plugins:{
        legend:{
          position: opts.legend || 'right',
          labels:{
            boxWidth:9, boxHeight:9, usePointStyle:true, pointStyle:'circle', padding:12,
            color:'#d6dced', font:{size:11, weight:'600'},
            generateLabels:(chart)=>{
              const d = chart.data;
              return d.labels.map((label,i)=>{
                const v = d.datasets[0].data[i];
                const pct = total ? ((v/total)*100).toFixed(1) : 0;
                return {
                  text:`${trunc(label,24)}  ${fmtNumShort(v)} (${pct}%)`,
                  fillStyle:d.datasets[0].backgroundColor[i], strokeStyle:'transparent', lineWidth:0,
                  fontColor:'#d6dced', hidden:!chart.getDataVisibility(i), index:i,
                };
              });
            }
          }
        },
        tooltip:Object.assign({}, TOOLTIP, {callbacks:{label:(ctx)=>{
          const pct = total ? ((ctx.parsed/total)*100).toFixed(2) : 0;
          return ` ${ctx.label}: ${fmtNum(ctx.parsed)} (${pct}%)`;
        }}}),
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
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const colors = options.colors || options.color || '#a78bfa';
  const plugins = [trackPlugin(true)];
  CHARTS[id] = new Chart(el, {
    type:'bar',
    data:{labels, datasets:[{data, backgroundColor:colors, borderRadius:99, borderSkipped:false, barThickness: compact ? 12 : 16}]},
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      animation:{duration:900, easing:'easeOutQuart'},
      layout:{padding:{right:92}},
      plugins:{
        legend:{display:false},
        tooltip:Object.assign({}, TOOLTIP, {callbacks:{title:(i)=>labels[i[0].dataIndex], label:(ctx)=>` ${fmtNum(ctx.parsed.x)} request`}}),
        datalabels:{anchor:'end', align:'right', offset:8, color:'#fff', font:{size:11, weight:'700'}, formatter:(v)=>fmtNum(v)}
      },
      scales:{
        x:{display:false, beginAtZero:true},
        y:{grid:{display:false}, border:{display:false}, ticks:{autoSkip:false, color:'#d6dced', font:{size:11, weight:'600'},
          callback:function(v){ return trunc(this.getLabelForValue(v), longLabel ? 46 : 20); }}}
      }
    },
    plugins
  });
}

// ============================================================
// 3b. VERTICAL PILL BAR
// ============================================================
function vBarChart(id, labels, data, options){
  options = options || {};
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const colors = options.colors || '#a78bfa';
  CHARTS[id] = new Chart(el, {
    type:'bar',
    data:{labels, datasets:[{data, backgroundColor:(ctx)=>{
      const c = Array.isArray(colors) ? colors[ctx.dataIndex % colors.length] : colors;
      const ch = ctx.chart; if (!ch.chartArea) return c;
      return vGrad(ch.ctx, ch.chartArea, c, 1, .45);
    }, borderRadius:99, borderSkipped:false, maxBarThickness:26}]},
    options:{
      responsive:true, maintainAspectRatio:false,
      animation:{duration:900, easing:'easeOutQuart'},
      layout:{padding:{top:22}},
      plugins:{
        legend:{display:false},
        tooltip:Object.assign({}, TOOLTIP, {callbacks:{title:(i)=>labels[i[0].dataIndex], label:(ctx)=>` ${fmtNum(ctx.parsed.y)}`}}),
        datalabels:{anchor:'end', align:'top', offset:2, color:'#fff', font:{size:10, weight:'700'}, formatter:(v)=>fmtNumShort(v)}
      },
      scales:{
        x:{grid:{display:false}, border:{display:false}, ticks:{autoSkip:false, maxRotation:40, minRotation:0, font:{size:10, weight:'600'}, color:'#d6dced', callback:function(v){ return trunc(this.getLabelForValue(v), 12); }}},
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
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const ds = datasets.map(d=>Object.assign({}, d, {borderRadius:6, barThickness:16}));
  CHARTS[id] = new Chart(el, {
    type:'bar', data:{labels, datasets:ds},
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      animation:{duration:900, easing:'easeOutQuart'},
      plugins:{
        legend:{position:'bottom', labels:{boxWidth:8, boxHeight:8, usePointStyle:true, pointStyle:'circle', padding:12, color:'#d6dced', font:{size:10, weight:'600'}}},
        tooltip:Object.assign({}, TOOLTIP, {callbacks:{label:(ctx)=>` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.x)}`}}),
        datalabels:false
      },
      scales:{
        x:{stacked:true, border:{display:false}, grid:{color:GRID_COLOR}, ticks:{font:{size:10, weight:'600'}, callback:(v)=>fmtNumShort(v)}},
        y:{stacked:true, grid:{display:false}, border:{display:false}, ticks:{color:'#d6dced', font:{size:11, weight:'600'}, callback:function(v){ return trunc(this.getLabelForValue(v), 16); }}}
      }
    }
  });
}

// ============================================================
// 5. GAUGE (semi ring rounded)
// ============================================================
function gaugeChart(id, value, maxValue, label, color){
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  const remaining = Math.max(0, maxValue - value);
  CHARTS[id] = new Chart(el, {
    type:'doughnut',
    data:{labels:['score','remain'], datasets:[{
      data:[value, remaining],
      backgroundColor:[color, 'rgba(255,255,255,.06)'],
      borderWidth:0, borderRadius:[20,0], circumference:180, rotation:270,
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'80%',
      animation:{animateRotate:true, duration:1100},
      plugins:{legend:{display:false}, tooltip:{enabled:false}, datalabels:false}
    }
  });
}

// ============================================================
// 6. SPARKLINE (untuk kartu KPI)
// ============================================================
function sparkline(id, data, color){
  destroyChart(id);
  const el = document.getElementById(id); if (!el) return;
  CHARTS[id] = new Chart(el, {
    type:'line',
    data:{labels:data.map((_,i)=>i), datasets:[{
      data, borderColor:color, borderWidth:2, tension:.45, pointRadius:0, fill:true,
      backgroundColor:(ctx)=>{ const ch = ctx.chart; return ch.chartArea ? vGrad(ch.ctx, ch.chartArea, color, .35, 0) : hexA(color,.2); }
    }]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:900},
      layout:{padding:0},
      plugins:{legend:{display:false}, tooltip:{enabled:false}, datalabels:false},
      scales:{x:{display:false}, y:{display:false, beginAtZero:true}}
    }
  });
}