// RHINESTONIFY app.js v2 — server does tracing, client renders

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
let uploadedImage = null;   // { img, file, url }
let numColors     = 1;
let sizingMode    = 'auto';
let manualSS      = 'SS12';
let lastCircles   = null;
let lastConfig    = null;
let updateTimer   = null;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function setStatus(msg, isError) {
  const el = document.getElementById('previewStatus');
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '';
}

function showSpinner(on) {
  document.getElementById('btnSpinner').style.display = on ? 'block' : 'none';
  document.getElementById('generateBtn').disabled = on;
  document.getElementById('btnLabel').textContent  = on ? 'Generating…' : 'Generate template';
}

// ── SETTINGS CONTROLS ─────────────────────────────────────────────────────────
function setColors(n, el) {
  numColors = n;
  document.querySelectorAll('#colorChips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  scheduleUpdate();
}

function setMode(m) {
  sizingMode = m;
  ['Auto','Multi','Manual'].forEach(k => {
    document.getElementById('mode' + k).classList.toggle('active', k.toLowerCase() === m);
  });
  const notes = {
    auto:   'Stone size recommended automatically by Gemini based on your design.',
    multi:  'Gemini picks the primary size; thin strokes get a smaller stone.',
    manual: 'You choose the stone size below.'
  };
  document.getElementById('modeNote').textContent = notes[m];
  document.getElementById('manualPicker').style.display = m === 'manual' ? 'block' : 'none';
  scheduleUpdate();
}

function setSS(n, el) {
  manualSS = n;
  document.querySelectorAll('#ssChips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  scheduleUpdate();
}

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => { if (uploadedImage) generate(); }, 600);
}

// ── IMAGE UPLOAD ──────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (f) loadImage(f);
});

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
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
    generate();
  };
  img.src = url;
}

function resetImage() {
  uploadedImage = null; lastCircles = null; lastConfig = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadInner').style.display = 'block';
  document.getElementById('thumbWrap').style.display   = 'none';
  document.getElementById('analysisBox').style.display = 'none';
  document.getElementById('previewCanvas').style.display = 'none';
  document.getElementById('canvasEmpty').style.display   = 'flex';
  document.getElementById('legendWrap').style.display    = 'none';
  document.getElementById('statsGrid').style.display     = 'none';
  document.getElementById('downloadBtn').style.display   = 'none';
  document.getElementById('downloadNote').style.display  = 'none';
  document.getElementById('ssPreview').textContent = '';
  setStatus('');
}

// ── MAIN GENERATE ─────────────────────────────────────────────────────────────
async function generate() {
  if (!uploadedImage) return;

  showSpinner(true);
  setStatus('Tracing shapes with Gemini…');

  try {
    const { img, file } = uploadedImage;
    const targetWidthMm = parseInt(document.getElementById('targetWidth').value) || 100;
    const aspectRatio   = img.naturalHeight / img.naturalWidth;
    const invert        = document.getElementById('invertChk').checked;

    const fd = new FormData();
    fd.append('image',        file);
    fd.append('targetWidthMm', targetWidthMm);
    fd.append('aspectRatio',   aspectRatio.toFixed(6));
    fd.append('numColors',     numColors);
    fd.append('sizingMode',    sizingMode);
    fd.append('manualSS',      manualSS);
    fd.append('invert',        invert);

    const resp = await fetch('/api/generate', { method: 'POST', body: fd });
    const result = await resp.json();

    if (!result.success) throw new Error(result.error || 'Server error');

    lastCircles = result.circles;
    lastConfig  = result.config;

    // Show Gemini notes
    if (result.config.geminiNotes) {
      document.getElementById('analysisBox').style.display = 'block';
      document.getElementById('analysisText').textContent  = result.config.geminiNotes;
    }

    renderCanvas(result.circles, result.config);
    renderLegend(result.circles, result.config);
    renderStats(result.config);
    updateSSPreview(result.config.primarySS.n, targetWidthMm);
    setStatus('');

  } catch(err) {
    console.error(err);
    setStatus('Error: ' + err.message, true);
  }

  showSpinner(false);
}

// ── CANVAS RENDER ─────────────────────────────────────────────────────────────
function renderCanvas(circles, config) {
  const DISP = 3;
  const w = config.targetWidthMm * DISP;
  const h = config.targetHeightMm * DISP;
  const canvas = document.getElementById('previewCanvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Light neutral background
  ctx.fillStyle = '#f0edf8';
  ctx.fillRect(0, 0, w, h);

  const pal = PALETTES[Math.min(config.numColors - 1, PALETTES.length - 1)];
  for (const c of circles) {
    ctx.beginPath();
    ctx.arc(c.x * DISP, c.y * DISP, c.r * DISP, 0, Math.PI * 2);
    ctx.fillStyle = pal[c.ci] || pal[0];
    ctx.fill();
  }

  canvas.style.display = 'block';
  document.getElementById('canvasEmpty').style.display = 'none';
}

// ── LEGEND ────────────────────────────────────────────────────────────────────
function renderLegend(circles, config) {
  const pal  = PALETTES[Math.min(config.numColors - 1, PALETTES.length - 1)];
  const descs = config.regionDescriptions || [];
  const counts = config.regionCounts || {};
  const container = document.getElementById('colorRows');
  container.innerHTML = '';

  for (let i = 0; i < config.numColors; i++) {
    const row = document.createElement('div');
    row.className = 'color-row';
    const label = descs[i] || `Color ${i + 1}`;
    const count = counts[i] || 0;
    row.innerHTML = `
      <div class="color-swatch" style="background:${pal[i]}"></div>
      <span>${label}</span>
      <span class="color-count">${count.toLocaleString()}</span>`;
    container.appendChild(row);
  }

  document.getElementById('totalCount').textContent = config.totalStones.toLocaleString();
  document.getElementById('legendWrap').style.display = 'block';
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function renderStats(config) {
  const sqIn = (config.targetWidthMm / 25.4) * (config.targetHeightMm / 25.4);
  document.getElementById('statAcross').textContent  = config.cols;
  document.getElementById('statDensity').textContent = sqIn > 0 ? Math.round(config.totalStones / sqIn) : 0;
  document.getElementById('statSS').textContent      = config.primarySS.n;
  document.getElementById('statsGrid').style.display  = 'grid';
  document.getElementById('downloadBtn').style.display  = 'flex';
  document.getElementById('downloadNote').style.display = 'block';
}

// ── SS PREVIEW TABLE ──────────────────────────────────────────────────────────
function updateSSPreview(recommendedName, widthMm) {
  const el = document.getElementById('ssPreview');
  el.innerHTML = SS_TABLE.map(s => {
    const across = Math.floor(widthMm / s.pitch);
    const isRec  = s.n === recommendedName;
    return `<span style="${isRec ? 'font-weight:600;color:var(--purple-dark)' : ''}">${s.n}: ${across} stones across${isRec ? ' ✓ recommended' : ''}</span>`;
  }).join('<br>');
}

// ── SVG DOWNLOAD ──────────────────────────────────────────────────────────────
function downloadSVG() {
  if (!lastCircles?.length || !lastConfig) return;
  const { targetWidthMm: w, targetHeightMm: h, primarySS } = lastConfig;
  const pal = PALETTES[Math.min(lastConfig.numColors - 1, PALETTES.length - 1)];

  // Group by color index
  const groups = {};
  lastCircles.forEach(c => {
    if (!groups[c.ci]) groups[c.ci] = [];
    groups[c.ci].push(c);
  });

  const gSVG = Object.entries(groups).map(([ci, circs]) => {
    const col  = pal[ci] || pal[0];
    const dots = circs.map(c =>
      `<circle cx="${c.x}" cy="${c.y}" r="${c.r}"/>`
    ).join('');
    return `  <g fill="${col}" data-color="${parseInt(ci)+1}" data-ss="${primarySS.n}">\n  ${dots}\n  </g>`;
  }).join('\n');

  const svg = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!-- Rhinestonify v2 | ${primarySS.n} ${primarySS.lo}-${primarySS.hi}mm | ${lastConfig.totalStones} stones | ${w}x${h}mm -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">`,
    gSVG,
    `</svg>`
  ].join('\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = `rhinestone-${primarySS.n}-${w}mm.svg`;
  a.click();
}
