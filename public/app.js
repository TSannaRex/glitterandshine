// RHINESTONIFY app.js v4
// Gemini gives us threshold + SS recommendation only.
// All pixel sampling and stone placement runs here in the browser.

const SS_TABLE = [
  { n:'SS6',  lo:1.9, hi:2.1, pitch:2.40 },
  { n:'SS10', lo:2.7, hi:2.9, pitch:3.10 },
  { n:'SS12', lo:3.0, hi:3.2, pitch:3.35 },
  { n:'SS16', lo:3.8, hi:4.0, pitch:3.96 },
  { n:'SS20', lo:4.6, hi:4.8, pitch:4.76 },
  { n:'SS30', lo:6.3, hi:6.5, pitch:6.50 },
];
const PALETTES = [
  ['#9b72d4'],
  ['#9b72d4','#f5c842'],
  ['#9b72d4','#f5c842','#5a9fd4'],
];

// ── STATE ─────────────────────────────────────────────────────────────────────
let uploadedImage   = null;
let numColors       = 1;
let sizingMode      = 'auto';
let manualSS        = 'SS12';
let currentThreshold = 180;
let currentSS       = 'SS12';
let lastCircles     = null;
let lastConfig      = null;
let analyzeTimer    = null;
let renderTimer     = null;

function midMm(s) { return (s.lo + s.hi) / 2; }

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function setStatus(msg, isError) {
  const el = document.getElementById('previewStatus');
  el.textContent   = msg;
  el.style.color   = isError ? '#c0392b' : 'var(--text3)';
}
function showSpinner(on) {
  document.getElementById('btnSpinner').style.display = on ? 'block' : 'none';
  document.getElementById('generateBtn').disabled     = on;
  document.getElementById('btnLabel').textContent     = on ? 'Generating…' : 'Generate template';
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function setColors(n, el) {
  numColors = n;
  document.querySelectorAll('#colorChips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  scheduleRender();
}
function setMode(m) {
  sizingMode = m;
  ['Auto','Multi','Manual'].forEach(k =>
    document.getElementById('mode'+k).classList.toggle('active', k.toLowerCase() === m)
  );
  const notes = {
    auto:   'Gemini recommends the best stone size for your design.',
    multi:  'Large stones fill solid areas; thin strokes get a smaller stone.',
    manual: 'Choose your stone size below.'
  };
  document.getElementById('modeNote').textContent = notes[m];
  document.getElementById('manualPicker').style.display = m === 'manual' ? 'block' : 'none';
  scheduleRender();
}
function setSS(n, el) {
  manualSS = n;
  document.querySelectorAll('#ssChips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  scheduleRender();
}

// Re-render immediately when sliders change
function onThrChange() {
  currentThreshold = parseInt(document.getElementById('thrSlider').value);
  document.getElementById('thrVal').textContent = currentThreshold;
  scheduleRender();
}
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderStones, 300);
}
function scheduleUpdate() {
  // Full re-analyze + render when width changes
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => { if (uploadedImage) runAnalyze(); }, 600);
}

// ── IMAGE UPLOAD ──────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (f) loadImage(f);
});
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadImage(f);
});

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    uploadedImage = { img, file, url };
    document.getElementById('thumbImg').src = url;
    document.getElementById('uploadInner').style.display = 'none';
    document.getElementById('thumbWrap').style.display   = 'block';
    runAnalyze();
  };
  img.src = url;
}
function resetImage() {
  uploadedImage = null; lastCircles = null; lastConfig = null;
  document.getElementById('fileInput').value            = '';
  document.getElementById('uploadInner').style.display  = 'block';
  document.getElementById('thumbWrap').style.display    = 'none';
  document.getElementById('analysisBox').style.display  = 'none';
  document.getElementById('previewCanvas').style.display= 'none';
  document.getElementById('canvasEmpty').style.display  = 'flex';
  document.getElementById('legendWrap').style.display   = 'none';
  document.getElementById('statsGrid').style.display    = 'none';
  document.getElementById('downloadBtn').style.display  = 'none';
  document.getElementById('downloadNote').style.display = 'none';
  document.getElementById('ssPreview').textContent      = '';
  setStatus('');
}

// ── STEP 1: ASK GEMINI FOR SETTINGS ──────────────────────────────────────────
async function runAnalyze() {
  if (!uploadedImage) return;
  setStatus('Asking Gemini for settings…');
  showSpinner(true);

  try {
    const wMm = parseInt(document.getElementById('targetWidth').value) || 100;
    const fd  = new FormData();
    fd.append('image', uploadedImage.file);
    fd.append('targetWidthMm', wMm);

    const resp   = await fetch('/api/analyze', { method:'POST', body:fd });
    const result = await resp.json();

    if (!result.success) throw new Error(result.error);

    // Apply Gemini's recommendations
    currentThreshold = result.analysis.threshold;
    currentSS        = result.analysis.recommended_ss;
    document.getElementById('thrSlider').value       = currentThreshold;
    document.getElementById('thrVal').textContent    = currentThreshold;

    // Show analysis note
    if (result.analysis.notes) {
      document.getElementById('analysisBox').style.display = 'block';
      document.getElementById('analysisText').textContent  = result.analysis.notes;
    }

    // Update SS preview table
    if (result.ssTable) {
      const el = document.getElementById('ssPreview');
      el.innerHTML = result.ssTable.map(s =>
        `<span style="${s.recommended ? 'font-weight:600;color:var(--purple-dark)' : ''}">${s.n}: ${s.stonesAcross} stones across${s.recommended ? ' ✓ recommended' : ''}</span>`
      ).join('<br>');
    }

    setStatus('');
  } catch(e) {
    console.warn('Analyze failed, using current settings:', e.message);
    setStatus('');
  }

  showSpinner(false);
  renderStones();
}

// ── STEP 2: PLACE STONES CLIENT-SIDE ─────────────────────────────────────────
async function generate() {
  if (!uploadedImage) return;
  await runAnalyze();
}

function renderStones() {
  if (!uploadedImage) return;
  showSpinner(true);
  setStatus('Placing stones…');

  // Use rAF so spinner renders before heavy canvas work
  requestAnimationFrame(() => {
    try {
      _doRenderStones();
    } catch(e) {
      setStatus('Error: ' + e.message, true);
    }
    showSpinner(false);
    setStatus('');
  });
}

function _doRenderStones() {
  const { img } = uploadedImage;
  const wMm     = parseInt(document.getElementById('targetWidth').value) || 100;
  const aspect  = img.naturalHeight / img.naturalWidth;
  const hMm     = Math.round(wMm * aspect);
  const thr     = currentThreshold;
  const invert  = document.getElementById('invertChk').checked;

  // Pick primary SS
  let primarySS;
  if (sizingMode === 'manual') {
    primarySS = SS_TABLE.find(s => s.n === manualSS) || SS_TABLE[2];
  } else {
    primarySS = SS_TABLE.find(s => s.n === currentSS) || SS_TABLE[2];
  }

  const pitch  = primarySS.pitch;
  const stoneR = midMm(primarySS) / 2;
  const cols   = Math.floor(wMm  / pitch);
  const rows   = Math.floor(hMm  / pitch);

  // ── Build high-res pixel mask (8px per stone cell) ──
  const OVER = 8;
  const MW = cols * OVER, MH = rows * OVER;
  const offscreen = document.createElement('canvas');
  offscreen.width = MW; offscreen.height = MH;
  const octx = offscreen.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, MW, MH);
  octx.drawImage(img, 0, 0, MW, MH);
  const pixels = octx.getImageData(0, 0, MW, MH).data;

  const luma = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++)
    luma[i] = Math.round(pixels[i*4]*0.299 + pixels[i*4+1]*0.587 + pixels[i*4+2]*0.114);

  // Binary mask: 1 = foreground
  const bin = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++)
    bin[i] = invert ? (luma[i] >= thr ? 1 : 0) : (luma[i] < thr ? 1 : 0);

  // ── For each stone, sample its circular footprint ──
  // Then apply neighbour vote to eliminate isolated stray stones on edges

  // First pass: raw coverage
  const coverage = new Float32Array(rows * cols);
  const colorIdx = new Uint8Array(rows * cols);

  for (let row = 0; row < rows; row++) {
    const hex     = row % 2 === 1;
    const colsRow = hex ? cols - 1 : cols;
    for (let col = 0; col < colsRow; col++) {
      const cx_px = ((hex ? pitch*0.5 : 0) + (col+0.5)*pitch) / wMm * MW;
      const cy_px = ((row+0.5)*pitch) / hMm * MH;
      const pr    = (stoneR / wMm) * MW;
      const r2    = pr * pr;

      let inside = 0, dark = 0, lumSum = 0;
      const r0 = Math.max(0, Math.floor(cy_px-pr)), r1 = Math.min(MH-1, Math.ceil(cy_px+pr));
      const c0 = Math.max(0, Math.floor(cx_px-pr)), c1 = Math.min(MW-1, Math.ceil(cx_px+pr));

      for (let py = r0; py <= r1; py++) {
        for (let px = c0; px <= c1; px++) {
          const dx = px-cx_px, dy = py-cy_px;
          if (dx*dx + dy*dy <= r2) {
            inside++;
            if (bin[py*MW+px]) { dark++; lumSum += luma[py*MW+px]; }
          }
        }
      }
      coverage[row*cols+col] = inside > 0 ? dark/inside : 0;

      // Colour: quantise by average luma
      if (numColors > 1 && dark > 0) {
        const avg = lumSum / dark;
        colorIdx[row*cols+col] = Math.min(numColors-1, Math.floor(avg / (256/numColors)));
      }
    }
  }

  // ── Second pass: neighbour vote to clean jagged edges ──
  // A stone is placed only if:
  //   coverage >= minCov AND at least `minNeighbours` of its 6 hex neighbours also have coverage >= minCov
  // This removes single stray stones hanging off edges.
  const MIN_COV       = 0.15;  // at least 15% of stone footprint must be dark
  const MIN_NEIGHBOURS = 2;    // at least 2 of 6 neighbours must also be dark

  function coverageAt(r, c) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return 0;
    return coverage[r*cols+c];
  }

  // Hex grid neighbours (offset depends on row parity)
  function hexNeighbours(row, col) {
    const odd = row % 2 === 1;
    return [
      [row-1, odd ? col : col-1],
      [row-1, odd ? col+1 : col],
      [row,   col-1],
      [row,   col+1],
      [row+1, odd ? col : col-1],
      [row+1, odd ? col+1 : col],
    ];
  }

  const circles = [];
  for (let row = 0; row < rows; row++) {
    const hex     = row % 2 === 1;
    const colsRow = hex ? cols - 1 : cols;
    for (let col = 0; col < colsRow; col++) {
      const cov = coverage[row*cols+col];
      if (cov < MIN_COV) continue;

      // Count neighbours that are also dark
      const nCount = hexNeighbours(row, col)
        .filter(([nr, nc]) => coverageAt(nr, nc) >= MIN_COV).length;

      if (nCount < MIN_NEIGHBOURS) continue; // stray stone — skip

      const cx_mm = (hex ? pitch*0.5 : 0) + (col+0.5)*pitch;
      const cy_mm = (row+0.5)*pitch;
      circles.push({
        x:  parseFloat(cx_mm.toFixed(3)),
        y:  parseFloat(cy_mm.toFixed(3)),
        r:  parseFloat((stoneR*0.88).toFixed(3)),
        ci: colorIdx[row*cols+col]
      });
    }
  }

  lastCircles = circles;
  lastConfig  = {
    primarySS, secondarySS: null,
    targetWidthMm: wMm, targetHeightMm: hMm,
    numColors,
    geminiNotes: document.getElementById('analysisText').textContent,
    regionDescriptions: Array.from({length:numColors},(_,i)=>`Color ${i+1}`),
    regionCounts: circles.reduce((a,c)=>{ a[c.ci]=(a[c.ci]||0)+1; return a; }, {}),
    totalStones: circles.length,
    cols
  };

  drawCanvas(circles, wMm, hMm, primarySS);
  drawLegend(lastConfig);
  drawStats(lastConfig);
}

// ── CANVAS ────────────────────────────────────────────────────────────────────
function drawCanvas(circles, wMm, hMm, primarySS) {
  const DISP = 3;
  const canvas = document.getElementById('previewCanvas');
  canvas.width  = Math.round(wMm * DISP);
  canvas.height = Math.round(hMm * DISP);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f0edf8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pal = PALETTES[Math.min(numColors-1, PALETTES.length-1)];
  for (const c of circles) {
    ctx.beginPath();
    ctx.arc(c.x*DISP, c.y*DISP, c.r*DISP, 0, Math.PI*2);
    ctx.fillStyle = pal[c.ci] || pal[0];
    ctx.fill();
  }
  canvas.style.display = 'block';
  document.getElementById('canvasEmpty').style.display = 'none';
}

// ── LEGEND ────────────────────────────────────────────────────────────────────
function drawLegend(cfg) {
  const pal = PALETTES[Math.min(cfg.numColors-1, PALETTES.length-1)];
  const container = document.getElementById('colorRows');
  container.innerHTML = '';
  for (let i = 0; i < cfg.numColors; i++) {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `<div class="color-swatch" style="background:${pal[i]}"></div>
      <span>${cfg.regionDescriptions[i] || 'Color '+(i+1)}</span>
      <span class="color-count">${(cfg.regionCounts[i]||0).toLocaleString()}</span>`;
    container.appendChild(row);
  }
  document.getElementById('totalCount').textContent    = cfg.totalStones.toLocaleString();
  document.getElementById('legendWrap').style.display  = 'block';
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function drawStats(cfg) {
  const sqIn = (cfg.targetWidthMm/25.4) * (cfg.targetHeightMm/25.4);
  document.getElementById('statAcross').textContent   = cfg.cols;
  document.getElementById('statDensity').textContent  = sqIn > 0 ? Math.round(cfg.totalStones/sqIn) : 0;
  document.getElementById('statSS').textContent       = cfg.primarySS.n;
  document.getElementById('statsGrid').style.display  = 'grid';
  document.getElementById('downloadBtn').style.display  = 'flex';
  document.getElementById('downloadNote').style.display = 'block';
}

// ── SVG DOWNLOAD ──────────────────────────────────────────────────────────────
function downloadSVG() {
  if (!lastCircles?.length || !lastConfig) return;
  const { targetWidthMm:w, targetHeightMm:h, primarySS } = lastConfig;
  const pal = PALETTES[Math.min(lastConfig.numColors-1, PALETTES.length-1)];

  const groups = {};
  lastCircles.forEach(c => { (groups[c.ci] = groups[c.ci]||[]).push(c); });

  const gSVG = Object.entries(groups).map(([ci, cs]) =>
    `  <g fill="${pal[ci]||pal[0]}" data-ss="${primarySS.n}">\n  ` +
    cs.map(c=>`<circle cx="${c.x}" cy="${c.y}" r="${c.r}"/>`).join('') +
    `\n  </g>`
  ).join('\n');

  const svg = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!-- Rhinestonify | ${primarySS.n} ${primarySS.lo}-${primarySS.hi}mm | ${lastConfig.totalStones} stones | ${w}x${h}mm -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">`,
    gSVG,
    `</svg>`
  ].join('\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
  a.download = `rhinestone-${primarySS.n}-${w}mm.svg`;
  a.click();
}
