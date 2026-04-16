require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// ── SS SIZE TABLE ─────────────────────────────────────────────────────────────
const SS_TABLE = [
  { n: 'SS6',  lo: 1.9, hi: 2.1, pitch: 2.40 },
  { n: 'SS10', lo: 2.7, hi: 2.9, pitch: 3.10 },
  { n: 'SS12', lo: 3.0, hi: 3.2, pitch: 3.35 },
  { n: 'SS16', lo: 3.8, hi: 4.0, pitch: 3.96 },
  { n: 'SS20', lo: 4.6, hi: 4.8, pitch: 4.76 },
  { n: 'SS30', lo: 6.3, hi: 6.5, pitch: 6.50 },
];
function midMm(s) { return (s.lo + s.hi) / 2; }

// ── GEMINI: get a compact grid mask + metadata only ───────────────────────────
// Instead of asking for polygon coordinates (long output), we ask Gemini for:
//   1. A small ASCII grid (e.g. 40x40) of 0/1 per cell — very compact
//   2. Recommended SS size and threshold
// The grid tells us which stone positions are inside the design.
async function getGridMask(imageBase64, mimeType, numColors, widthMm, gridCols, gridRows) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const prompt = `You are analyzing an image for rhinestone template generation.

The image contains a design on a plain background.

YOUR TASK: Output a ${gridCols}x${gridRows} binary grid representing which cells contain the FOREGROUND design (not background).

Grid rules:
- Output exactly ${gridRows} rows, each with exactly ${gridCols} characters
- Use '1' for cells that are part of the foreground design
- Use '0' for cells that are background/empty
- Row 0 is the TOP of the image, row ${gridRows-1} is the BOTTOM
- Col 0 is the LEFT, col ${gridCols-1} is the RIGHT
- Be precise — follow the actual shape outline carefully
- For the CF logo: fill the C letter shape solidly, and mark the circuit board elements

${numColors > 1 ? `Also output a COLOR grid using digits 1-${numColors} instead of just 0/1, where 0=background, 1=darkest region, ${numColors}=lightest region.` : ''}

Also provide:
- recommended_ss: best stone size from [SS6,SS10,SS12,SS16,SS20,SS30] for ${widthMm}mm wide design
- recommended_threshold: grayscale 0-255
- has_thin_strokes: true/false
- notes: brief description

Respond with ONLY this JSON (no markdown):
{
  "grid": "0000011111100000\\n0001111111110000\\n...",
  "recommended_ss": "SS12",
  "recommended_threshold": 140,
  "has_thin_strokes": false,
  "notes": "solid C shape with circuit elements"
}

The grid field is a single string with rows separated by \\n characters.
Each row must be exactly ${gridCols} characters of 0s and 1s.`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: 0.05, maxOutputTokens: 4096 }
      })
    }
  );

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  console.log('Gemini raw length:', raw.length);
  console.log('Gemini preview:', raw.slice(0, 200));

  // Strip markdown fences
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch(e) {
    // Try to extract just the fields we need with regex
    console.error('JSON parse failed, attempting field extraction. Raw:', raw.slice(0, 500));

    const gridMatch    = raw.match(/"grid"\s*:\s*"([^"]+)"/);
    const ssMatch      = raw.match(/"recommended_ss"\s*:\s*"([^"]+)"/);
    const thrMatch     = raw.match(/"recommended_threshold"\s*:\s*(\d+)/);
    const thinMatch    = raw.match(/"has_thin_strokes"\s*:\s*(true|false)/);
    const notesMatch   = raw.match(/"notes"\s*:\s*"([^"]+)"/);

    if (!gridMatch) throw new Error('Could not extract grid from Gemini response');

    parsed = {
      grid: gridMatch[1].replace(/\\n/g, '\n'),
      recommended_ss: ssMatch?.[1] || 'SS12',
      recommended_threshold: thrMatch ? parseInt(thrMatch[1]) : 140,
      has_thin_strokes: thinMatch?.[1] === 'true',
      notes: notesMatch?.[1] || ''
    };
  }

  // Normalise grid string
  if (typeof parsed.grid === 'string') {
    parsed.grid = parsed.grid.replace(/\\n/g, '\n');
  }

  // Parse grid into 2D boolean array
  const rows = parsed.grid.split('\n').map(r => r.trim()).filter(r => r.length > 0);
  if (rows.length === 0) throw new Error('Gemini returned empty grid');

  // Build mask array [row][col] = regionId (0=background, 1+= foreground)
  const mask = [];
  for (let r = 0; r < gridRows; r++) {
    mask.push([]);
    const rowStr = rows[r] || '';
    for (let c = 0; c < gridCols; c++) {
      const ch = rowStr[c] || '0';
      mask[r].push(ch === '0' ? 0 : parseInt(ch) || 1);
    }
  }

  return {
    mask,
    recommended_ss: parsed.recommended_ss || 'SS12',
    recommended_threshold: parsed.recommended_threshold || 140,
    has_thin_strokes: parsed.has_thin_strokes || false,
    notes: parsed.notes || ''
  };
}

// ── STONE GRID from mask ──────────────────────────────────────────────────────
function buildStoneGrid(maskResult, wMm, hMm, primarySS, invert) {
  const { mask } = maskResult;
  const gridRows = mask.length;
  const gridCols = mask[0]?.length || 0;
  if (gridCols === 0) throw new Error('Empty mask');

  const pitch  = primarySS.pitch;
  const stoneR = midMm(primarySS) / 2;
  const cols   = Math.floor(wMm / pitch);
  const rows   = Math.floor(hMm / pitch);

  const circles = [];

  for (let row = 0; row < rows; row++) {
    const hex     = row % 2 === 1;
    const colsRow = hex ? cols - 1 : cols;

    for (let col = 0; col < colsRow; col++) {
      const cx = (hex ? pitch * 0.5 : 0) + (col + 0.5) * pitch;
      const cy = (row + 0.5) * pitch;

      // Map stone position to mask cell
      const mx = Math.min(gridCols - 1, Math.floor((cx / wMm) * gridCols));
      const my = Math.min(gridRows - 1, Math.floor((cy / hMm) * gridRows));
      const cellVal = mask[my][mx];

      const inside = cellVal > 0;
      if (invert ? !inside : inside) {
        circles.push({
          x:  parseFloat(cx.toFixed(3)),
          y:  parseFloat(cy.toFixed(3)),
          r:  parseFloat((stoneR * 0.88).toFixed(3)),
          ci: Math.max(0, cellVal - 1)  // 0-indexed colour
        });
      }
    }
  }

  return circles;
}

// ── API ───────────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const wMm        = parseFloat(req.body.targetWidthMm) || 100;
    const numColors  = parseInt(req.body.numColors)       || 1;
    const sizingMode = req.body.sizingMode                || 'auto';
    const manualSS   = req.body.manualSS                  || 'SS12';
    const invert     = req.body.invert === 'true';
    const aspect     = parseFloat(req.body.aspectRatio)   || 1;
    const hMm        = Math.round(wMm * aspect);

    // Grid resolution: ~1 cell per 2.5mm gives good detail without huge output
    const gridCols = Math.min(60, Math.max(20, Math.floor(wMm / 2.5)));
    const gridRows = Math.min(60, Math.max(20, Math.floor(hMm / 2.5)));

    // Get Gemini grid mask
    let maskResult;
    try {
      maskResult = await getGridMask(
        req.file.buffer.toString('base64'),
        req.file.mimetype,
        numColors, wMm, gridCols, gridRows
      );
    } catch(e) {
      console.error('Mask error:', e.message);
      return res.status(500).json({ error: e.message, geminiError: true });
    }

    // Pick stone size
    let primarySS;
    if (sizingMode === 'manual') {
      primarySS = SS_TABLE.find(s => s.n === manualSS) || SS_TABLE[2];
    } else {
      primarySS = SS_TABLE.find(s => s.n === maskResult.recommended_ss) || SS_TABLE[2];
    }

    // Place stones
    const circles = buildStoneGrid(maskResult, wMm, hMm, primarySS, invert);

    const regionCounts = {};
    circles.forEach(c => { regionCounts[c.ci] = (regionCounts[c.ci] || 0) + 1; });

    res.json({
      success: true,
      circles,
      config: {
        primarySS,
        secondarySS:        null,
        targetWidthMm:      wMm,
        targetHeightMm:     hMm,
        numColors,
        geminiNotes:        maskResult.notes,
        regionDescriptions: Array.from({ length: numColors }, (_, i) => `Color ${i + 1}`),
        regionCounts,
        totalStones:        circles.length,
        cols:               Math.floor(wMm / primarySS.pitch),
        hasThinStrokes:     maskResult.has_thin_strokes
      }
    });

  } catch(err) {
    console.error('/api/generate:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', geminiConfigured: !!GEMINI_API_KEY, ts: new Date().toISOString() })
);

app.listen(PORT, () =>
  console.log(`Rhinestonify v3 on :${PORT} | Gemini: ${GEMINI_API_KEY ? 'ready' : 'MISSING KEY'}`)
);
