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
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
  }
});

// ── SS SIZE TABLE (CF Rhinestone Sizing Guide) ────────────────────────────────
const SS_TABLE = [
  { n: 'SS6',  lo: 1.9, hi: 2.1, pitch: 2.40 },
  { n: 'SS10', lo: 2.7, hi: 2.9, pitch: 3.10 },
  { n: 'SS12', lo: 3.0, hi: 3.2, pitch: 3.35 },
  { n: 'SS16', lo: 3.8, hi: 4.0, pitch: 3.96 },
  { n: 'SS20', lo: 4.6, hi: 4.8, pitch: 4.76 },
  { n: 'SS30', lo: 6.3, hi: 6.5, pitch: 6.50 },
];
function midMm(s) { return (s.lo + s.hi) / 2; }

// ── GEMINI: trace foreground shapes as normalised polygons ────────────────────
async function traceShapes(imageBase64, mimeType, numColors, widthMm) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const colorDesc = numColors === 1
    ? 'one region covering the entire foreground design'
    : `exactly ${numColors} regions, ordered darkest (id 0) to lightest (id ${numColors - 1})`;

  const prompt = `You are a precise silhouette-tracing assistant for a rhinestone template generator.

The image shows a design on a plain (white or transparent) background.
Trace the outline of ${colorDesc}.

COORDINATE RULES:
- All x,y values are NORMALISED floats: 0.0 = left/top of image, 1.0 = right/bottom.
- Follow the actual silhouette edge closely.
- For curves and letters use enough points for a smooth outline (20-80 points typical).
- Close each polygon: last point must equal first point.
- If the design has disconnected parts, list each as a separate polygon within the same region.
- Do NOT trace the background.

ALSO RETURN:
- recommended_ss: the best stone size from [SS6, SS10, SS12, SS16, SS20, SS30] for a ${widthMm}mm wide design. Prefer smaller stones (SS6-SS12) for designs with fine detail, curves, or thin strokes. Prefer larger (SS16-SS30) only for very bold chunky designs over 150mm.
- recommended_threshold: grayscale 0-255, pixels below this are foreground.
- has_thin_strokes: true if design contains lines thinner than ~3mm at target size.
- notes: one sentence describing the design structure.

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
{
  "regions": [
    {
      "id": 0,
      "color_description": "dark foreground shape",
      "polygons": [
        { "points": [[0.10,0.05],[0.50,0.02],[0.90,0.05],[0.90,0.95],[0.10,0.95],[0.10,0.05]] }
      ]
    }
  ],
  "recommended_ss": "SS12",
  "recommended_threshold": 140,
  "has_thin_strokes": false,
  "notes": "Solid heart silhouette, smooth curves."
}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt }
        ]}],
        generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
      })
    }
  );

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();

  let parsed;
  try { parsed = JSON.parse(clean); }
  catch(e) {
    console.error('Gemini JSON parse failed. Raw response:\n', raw.slice(0,800));
    throw new Error('Gemini returned invalid JSON: ' + e.message);
  }

  if (!Array.isArray(parsed.regions)) throw new Error('Missing regions array in Gemini response');
  for (const r of parsed.regions) {
    if (!Array.isArray(r.polygons)) throw new Error(`Region ${r.id} missing polygons`);
    for (const p of r.polygons) {
      if (!Array.isArray(p.points) || p.points.length < 3)
        throw new Error(`Polygon in region ${r.id} has fewer than 3 points`);
    }
  }

  return parsed;
}

// ── STONE GRID: place circles inside polygon shapes ───────────────────────────
function raycast(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function buildStoneGrid(traceResult, wMm, hMm, primarySS, invert) {
  const pitch  = primarySS.pitch;
  const stoneR = midMm(primarySS) / 2;
  const cols   = Math.floor(wMm / pitch);
  const rows   = Math.floor(hMm / pitch);

  // Convert normalised polygon points → mm
  const shapes = [];
  for (const region of traceResult.regions) {
    for (const poly of region.polygons) {
      shapes.push({
        regionId: region.id,
        pts: poly.points.map(([nx, ny]) => [nx * wMm, ny * hMm])
      });
    }
  }

  const circles = [];
  for (let row = 0; row < rows; row++) {
    const hex     = row % 2 === 1;
    const colsRow = hex ? cols - 1 : cols;
    for (let col = 0; col < colsRow; col++) {
      const cx = (hex ? pitch * 0.5 : 0) + (col + 0.5) * pitch;
      const cy = (row + 0.5) * pitch;

      let hitRegion = -1;
      for (const s of shapes) {
        if (raycast(cx, cy, s.pts)) { hitRegion = s.regionId; break; }
      }

      const inside = hitRegion >= 0;
      if (invert ? !inside : inside) {
        circles.push({ x: parseFloat(cx.toFixed(3)), y: parseFloat(cy.toFixed(3)),
                       r: parseFloat((stoneR * 0.88).toFixed(3)), ci: Math.max(0, hitRegion) });
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

    // 1. Trace shapes with Gemini
    let trace;
    try {
      trace = await traceShapes(req.file.buffer.toString('base64'), req.file.mimetype, numColors, wMm);
    } catch(e) {
      console.error('Trace error:', e.message);
      return res.status(500).json({ error: e.message, geminiError: true });
    }

    // 2. Pick stone size
    let primarySS;
    if (sizingMode === 'manual') {
      primarySS = SS_TABLE.find(s => s.n === manualSS) || SS_TABLE[2];
    } else {
      primarySS = SS_TABLE.find(s => s.n === trace.recommended_ss) || SS_TABLE[2];
    }

    // 3. Place stones inside traced polygons
    const circles = buildStoneGrid(trace, wMm, hMm, primarySS, invert);

    // Count per region
    const regionCounts = {};
    circles.forEach(c => { regionCounts[c.ci] = (regionCounts[c.ci] || 0) + 1; });

    res.json({
      success: true,
      circles,
      config: {
        primarySS,
        secondarySS: null,
        targetWidthMm:  wMm,
        targetHeightMm: hMm,
        numColors,
        geminiNotes:        trace.notes || '',
        regionDescriptions: trace.regions.map(r => r.color_description || `Region ${r.id}`),
        regionCounts,
        totalStones: circles.length,
        cols: Math.floor(wMm / primarySS.pitch),
        hasThinStrokes: trace.has_thin_strokes || false
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
  console.log(`Rhinestonify v2 on :${PORT} | Gemini: ${GEMINI_API_KEY ? 'ready' : 'MISSING KEY'}`)
);
