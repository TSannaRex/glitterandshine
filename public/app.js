// ─── SS SIZE TABLE (mirrors server) ──────────────────────────────────────────
const SS_TABLE = [
  { n: 'SS6',  lo: 1.9, hi: 2.1, pitch: 2.40 },
  { n: 'SS10', lo: 2.7, hi: 2.9, pitch: 3.10 },
  { n: 'SS12', lo: 3.0, hi: 3.2, pitch: 3.35 },
  { n: 'SS16', lo: 3.8, hi: 4.0, pitch: 3.96 },
  { n: 'SS20', lo: 4.6, hi: 4.8, pitch: 4.76 },
  { n: 'SS30', lo: 6.3, hi: 6.5, pitch: 6.50 },
];

// Stone colours per colour count (crystal-realistic palette)
const PALETTES = [
  ['#b8a0e0'],
  ['#b8a0e0', '#f5c842'],
  ['#b8a0e0', '#f5c842', '#5a9fd4'],
];

// ─── STATE ────────────────────────────────────────────────────────────────────
let uploadedImage = null;
let numColors = 1;
let sizingMode = 'auto';
let manualSS = 'SS10';
let lastCircles = null;
let lastDims = null;
let lastPrimarySS = null;
let lastSecondarySS = null;
let updateTimer = null;
let geminiConfig = null; // Last config from server

function midMm(s) { return (s.lo + s.hi) / 2; }

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function setColors(n, el) {
  numColors = n;
  document.querySelectorAll('.chip-row .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  scheduleUpdate();
}

function setMode(m) {
  sizingMode = m;
  ['auto', 'multi', 'manual'].forEach(k => {
    document.getElementById('mode' + k.charAt(0).toUpperCase() + k.slice(1))
      .classList.toggle('active', k === m);
  });
  const notes = {
    auto: 'Best stone size selected automatically for your design width.',
    multi: 'Solid fills get a larger stone; thin strokes get a smaller stone automatically.',
    manual: 'Choose your stone size below.'
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
  updateTimer = setTimeout(() => { if (uploadedImage) generate(); }, 500);
}

function updateSSPreview() {
  const w = parseInt(document.getElementById('targetWidth').value) || 100;
  const preview = document.getElementById('ssPreview');
  if (!uploadedImage) { preview.textContent = ''; return; }

  const lines = SS_TABLE.map(s => {
    const across = Math.floor(w / s.pitch);
    return `${s.n}: ${across} stones across`;
  });
  preview.innerHTML = lines.map((l, i) => {
    const isRec = geminiConfig && SS_TABLE[i].n === (geminiConfig.primarySS?.n || '');
    return `<span style="${isRec ? 'font-weight:600;color:var(--purple-dark)' : ''}">${l}${isRec ? ' ✓ recommended' : ''}</span>`;
  }).join('<br>');
}

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  loadImage(file);
});

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImage(file);
});

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    uploadedImage = { img, file, url };
    document.getElementById('thumbImg').src = url;
    document.getElementById('uploadInner').style.display = 'none';
    document.getElementById('thumbWrap').style.display = 'block';
    geminiConfig = null;
    generate();
  };
  img.src = url;
}

function resetImage() {
  uploadedImage = null;
  geminiConfig = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadInner').style.display = 'block';
  document.getElementById('thumbWrap').style.display = 'none';
  document.getElementById('analysisBox').style.display = 'none';
  document.getElementById('previewCanvas').style.display = 'none';
  document.getElementById('canvasEmpty').style.display = 'flex';
  document.getElementById('legendWrap').style.display = 'none';
  document.getElementById('statsGrid').style.display = 'none';
  document.getElementById('downloadBtn').style.display = 'none';
  document.getElementById('downloadNote').style.display = 'none';
  document.getElementById('ssPreview').textContent = '';
}

// ─── MAIN GENERATE ────────────────────────────────────────────────────────────
async function generate() {
  if (!uploadedImage) return;

  const btn = document.getElementById('generateBtn');
  const spinner = document.getElementById('btnSpinner');
  btn.disabled = true;
  spinner.style.display = 'block';
  document.getElementById('btnLabel').textContent = 'Analyzing...';
  document.getElementById('previewStatus').textContent = 'Calling Gemini...';

  try {
    // Call server API to get Gemini analysis + SS recommendation
    const formData = new FormData();
    formData.append('image', uploadedImage.file);
    formData.append('targetWidthMm', document.getElementById('targetWidth').value);
    formData.append('numColors', numColors);
    formData.append('sizingMode', sizingMode);
    formData.append('manualSS', manualSS);
    formData.append('threshold', document.getElementById('thrSlider').value);
    formData.append('minFillPct', parseInt(document.getElementById('minFill').value) / 100);
    formData.append('invert', document.getElementById('invertChk').checked);

    const response = await fetch('/api/generate', { method: 'POST', body: formData });
    const result = await response.json();

    if (!result.success) throw new Error(result.error || 'Server error');

    geminiConfig = result.config;

    // Show Gemini notes
    if (geminiConfig.geminiNotes) {
      document.getElementById('analysisBox').style.display = 'block';
      document.getElementById('analysisText').textContent = geminiConfig.geminiNotes;
    }

    document.getElementById('btnLabel').textContent = 'Rendering...';
    document.getElementById('previewStatus').textContent = 'Placing stones...';

    // Now do client-side stone placement using canvas pixel data
    await renderStones(geminiConfig);
    updateSSPreview();

  } catch (err) {
    console.error('Generate error:', err);
    // Fallback: run fully client-side without Gemini
    document.getElementById('previewStatus').textContent = 'Running locally...';
    await renderStonesFallback();
  }

  btn.disabled = false;
  spinner.style.display = 'none';
  document.getElementById('btnLabel').textContent = 'Generate template';
  document.getElementById('previewStatus').textContent = '';
}

// ─── STONE PLACEMENT ENGINE ───────────────────────────────────────────────────
async function renderStones(config) {
  const {
    primarySS,
    secondarySS,
    threshold,
    targetWidthMm,
    numColors: nc,
  } = config;

  const thr = parseInt(document.getElementById('thrSlider').value) || threshold;
  const minPct = parseInt(document.getElementById('minFill').value) / 100;
  const invert = document.getElementById('invertChk').checked;

  placeStones(primarySS, secondarySS, thr, minPct, invert, targetWidthMm, nc);
}

async function renderStonesFallback() {
  const w = parseInt(document.getElementById('targetWidth').value) || 100;
  const thr = parseInt(document.getElementById('thrSlider').value);
  const minPct = parseInt(document.getElementById('minFill').value) / 100;
  const invert = document.getElementById('invertChk').checked;

  // Simple auto-pick
  const targetAcross = 30;
  let primarySS = SS_TABLE[1];
  let bestDiff = Infinity;
  for (const s of SS_TABLE) {
    const diff = Math.abs(w / s.pitch - targetAcross);
    if (diff < bestDiff) { bestDiff = diff; primarySS = s; }
  }

  const primaryIdx = SS_TABLE.indexOf(primarySS);
  const secondarySS = (sizingMode === 'multi' && primaryIdx > 0) ? SS_TABLE[primaryIdx - 1] : null;

  placeStones(primarySS, secondarySS, thr, minPct, invert, w, numColors);
}

function placeStones(primarySS, secondarySS, thr, minPct, invert, targetWidthMm, nc) {
  const { img } = uploadedImage;
  const aspect = img.naturalHeight / img.naturalWidth;
  const targetH = Math.round(targetWidthMm * aspect);

  const pitch = primarySS.pitch;
  const cols = Math.floor(targetWidthMm / pitch);
  const rows = Math.floor(targetH / pitch);

  // Build high-res pixel mask (8px per stone cell)
  const OVER = 8;
  const MW = cols * OVER, MH = rows * OVER;

  const offscreen = document.createElement('canvas');
  offscreen.width = MW; offscreen.height = MH;
  const octx = offscreen.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, MW, MH);
  octx.drawImage(img, 0, 0, MW, MH);
  const imgData = octx.getImageData(0, 0, MW, MH).data;

  // Luma array
  const luma = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++) {
    luma[i] = Math.round(imgData[i * 4] * 0.299 + imgData[i * 4 + 1] * 0.587 + imgData[i * 4 + 2] * 0.114);
  }

  // Binary mask
  const binMask = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++) {
    binMask[i] = invert ? (luma[i] >= thr ? 1 : 0) : (luma[i] < thr ? 1 : 0);
  }

  // Distance field for multi-size mode
  let distField = null;
  if (sizingMode === 'multi' && secondarySS) {
    distField = new Float32Array(MW * MH);
    for (let i = 0; i < MW * MH; i++) distField[i] = binMask[i] ? 999 : 0;
    // Forward pass
    for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) {
      if (!binMask[y * MW + x]) { distField[y * MW + x] = 0; continue; }
      distField[y * MW + x] = Math.min(distField[y * MW + x], distField[(y - 1) * MW + x] + 1, distField[y * MW + (x - 1)] + 1);
    }
    // Backward pass
    for (let y = MH - 2; y > 0; y--) for (let x = MW - 2; x > 0; x--) {
      if (!binMask[y * MW + x]) { distField[y * MW + x] = 0; continue; }
      distField[y * MW + x] = Math.min(distField[y * MW + x], distField[(y + 1) * MW + x] + 1, distField[y * MW + (x + 1)] + 1);
    }
  }

  // Color quantization
  const palette = PALETTES[nc - 1] || PALETTES[0];
  const circles = [];

  for (let row = 0; row < rows; row++) {
    const hex = row % 2 === 1;
    const colsRow = hex ? cols - 1 : cols;
    for (let col = 0; col < colsRow; col++) {
      const cx_mm = (hex ? pitch * 0.5 : 0) + (col + 0.5) * pitch;
      const cy_mm = (row + 0.5) * pitch;

      // Decide which SS to use
      let useSS = primarySS;
      if (sizingMode === 'multi' && secondarySS && distField) {
        const pi = Math.min(MH - 1, Math.max(0, Math.round((cy_mm / targetH) * MH))) * MW
          + Math.min(MW - 1, Math.max(0, Math.round((cx_mm / targetWidthMm) * MW)));
        const localDist = distField[pi];
        const primaryPitchPx = (primarySS.pitch / targetWidthMm) * MW;
        if (localDist * 2 < primaryPitchPx * 1.2) useSS = secondarySS;
      }

      const pcx = (cx_mm / targetWidthMm) * MW;
      const pcy = (cy_mm / targetH) * MH;
      const pr = (midMm(useSS) / 2 / targetWidthMm) * MW;
      const r2 = pr * pr;

      let inside = 0, dark = 0, lumaSum = 0;
      const r0 = Math.max(0, Math.floor(pcy - pr));
      const r1 = Math.min(MH - 1, Math.ceil(pcy + pr));
      const c0 = Math.max(0, Math.floor(pcx - pr));
      const c1 = Math.min(MW - 1, Math.ceil(pcx + pr));

      for (let py = r0; py <= r1; py++) {
        for (let px = c0; px <= c1; px++) {
          const dx = px - pcx, dy = py - pcy;
          if (dx * dx + dy * dy <= r2) {
            inside++;
            if (binMask[py * MW + px]) { dark++; lumaSum += luma[py * MW + px]; }
          }
        }
      }

      const cov = inside > 0 ? dark / inside : 0;
      if (cov >= minPct) {
        // Assign color bucket by average luma of dark pixels
        const avgLuma = dark > 0 ? lumaSum / dark : 128;
        const colorIdx = nc > 1 ? Math.min(nc - 1, Math.floor(avgLuma / (256 / nc))) : 0;
        circles.push({ x: cx_mm, y: cy_mm, r: midMm(useSS) / 2 * 0.88, ss: useSS.n, ci: colorIdx });
      }
    }
  }

  lastCircles = circles;
  lastDims = { w: targetWidthMm, h: targetH };
  lastPrimarySS = primarySS;
  lastSecondarySS = secondarySS;

  renderCanvas(circles, targetWidthMm, targetH, palette);
  renderLegend(circles, palette, nc, primarySS, secondarySS);
  renderStats(circles, cols, targetWidthMm, targetH, primarySS);
}

// ─── CANVAS RENDER ────────────────────────────────────────────────────────────
function renderCanvas(circles, w, h, palette) {
  const DISP = 3;
  const canvas = document.getElementById('previewCanvas');
  const canvW = Math.round(w * DISP);
  const canvH = Math.round(h * DISP);
  canvas.width = canvW;
  canvas.height = canvH;
  const ctx = canvas.getContext('2d');

  // Light neutral background — NOT black
  ctx.fillStyle = '#f0edf8';
  ctx.fillRect(0, 0, canvW, canvH);

  for (const c of circles) {
    ctx.beginPath();
    ctx.arc(c.x * DISP, c.y * DISP, c.r * DISP, 0, Math.PI * 2);
    ctx.fillStyle = palette[c.ci] || palette[0];
    ctx.fill();
  }

  canvas.style.display = 'block';
  document.getElementById('canvasEmpty').style.display = 'none';
}

// ─── LEGEND ───────────────────────────────────────────────────────────────────
function renderLegend(circles, palette, nc, primarySS, secondarySS) {
  const counts = Array(nc).fill(0);
  circles.forEach(c => counts[c.ci] = (counts[c.ci] || 0) + 1);

  const container = document.getElementById('colorRows');
  container.innerHTML = '';

  const colorNames = ['Color 1', 'Color 2', 'Color 3'];
  for (let i = 0; i < nc; i++) {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `
      <div class="color-swatch" style="background:${palette[i]}"></div>
      <span>${colorNames[i]}</span>
      <span class="color-count">${(counts[i] || 0).toLocaleString()}</span>`;
    container.appendChild(row);
  }

  if (sizingMode === 'multi' && secondarySS) {
    const large = circles.filter(c => c.ss === primarySS.n).length;
    const small = circles.filter(c => c.ss === secondarySS.n).length;
    const sub = document.createElement('div');
    sub.className = 'color-sub';
    sub.textContent = `${primarySS.n} fills: ${large.toLocaleString()} · ${secondarySS.n} detail: ${small.toLocaleString()}`;
    container.appendChild(sub);
  }

  document.getElementById('totalCount').textContent = circles.length.toLocaleString();
  document.getElementById('legendWrap').style.display = 'block';
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function renderStats(circles, cols, w, h, primarySS) {
  const sqIn = (w / 25.4) * (h / 25.4);
  document.getElementById('statAcross').textContent = cols;
  document.getElementById('statDensity').textContent = sqIn > 0 ? Math.round(circles.length / sqIn) : 0;
  document.getElementById('statSS').textContent = primarySS.n;
  document.getElementById('statsGrid').style.display = 'grid';
  document.getElementById('downloadBtn').style.display = 'flex';
  document.getElementById('downloadNote').style.display = 'block';
}

// ─── SVG DOWNLOAD ─────────────────────────────────────────────────────────────
function downloadSVG() {
  if (!lastCircles || !lastCircles.length) return;
  const { w, h } = lastDims;
  const palette = PALETTES[numColors - 1] || PALETTES[0];

  // Group by color + ss
  const groups = {};
  for (const c of lastCircles) {
    const key = `${c.ci}_${c.ss}`;
    if (!groups[key]) groups[key] = { ci: c.ci, ss: c.ss, circles: [] };
    groups[key].circles.push(c);
  }

  const gSVG = Object.values(groups).map(g => {
    const col = palette[g.ci] || palette[0];
    const circ = g.circles.map(c =>
      `<circle cx="${c.x.toFixed(3)}" cy="${c.y.toFixed(3)}" r="${c.r.toFixed(3)}"/>`
    ).join('');
    return `  <g fill="${col}" data-ss="${g.ss}" data-color="${g.ci + 1}">\n  ${circ}\n  </g>`;
  }).join('\n');

  const ssInfo = `${lastPrimarySS.n} ${lastPrimarySS.lo}-${lastPrimarySS.hi}mm`
    + (lastSecondarySS ? ` + ${lastSecondarySS.n} ${lastSecondarySS.lo}-${lastSecondarySS.hi}mm` : '');

  const svg = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!-- Rhinestonify cutfile | ${ssInfo} | ${lastCircles.length} stones -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">`,
    gSVG,
    `</svg>`
  ].join('\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = `rhinestone-${lastPrimarySS.n}.svg`;
  a.click();
}
