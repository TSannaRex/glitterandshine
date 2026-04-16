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

// ── ATTEMPT TO REPAIR TRUNCATED JSON ─────────────────────────────────────────
// If Gemini cuts off mid-stream we get incomplete JSON.
// Strategy: truncate to last complete region object we can find.
function repairJSON(raw) {
  // First try straight parse
  try { return JSON.parse(raw); } catch(_) {}

  // Strip markdown fences
  let s = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  try { return JSON.parse(s); } catch(_) {}

  // Find last complete closing brace for a region polygon block
  // Walk backwards looking for a valid cut-point
  const attempts = [
    // Try closing the polygons array and region, then wrap up
    s + ']}]}',
    s + ']}]},"recommended_ss":"SS12","recommended_threshold":140,"has_thin_strokes":false,"notes":"Auto-completed"}',
    // Maybe we're inside a points array
    s + ']]}}]}]},"recommended_ss":"SS12","recommended_threshold":140,"has_thin_strokes":false,"notes":"Auto-completed"}',
  ];

  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch(_) {}
  }

  // Last resort: find last complete region block by regex
  const regionMatches = [...s.matchAll(/"id"\s*:\s*\d+[\s\S]*?"polygons"\s*:\s*\[[\s\S]*?\]\s*\}/g)];
  if (regionMatches.length > 0) {
    const lastGoodIdx = regionMatches[regionMatches.length - 1].index + regionMatches[regionMatches.length - 1][0].length;
    const trimmed = s.slice(0, lastGoodIdx);
    const wrapped = `{"regions":[${trimmed}],"recommended_ss":"SS12","recommended_threshold":140,"has_thin_strokes":false,"notes":"Partial trace"}`;
    try { return JSON.parse(wrapped); } catch(_) {}
  }

  throw new Error('Could not repair truncated JSON from Gemini');
}

// ── GEMINI: trace shapes as normalised polygons ───────────────────────────────
async function traceShapes(imageBase64, mimeType, numColors, widthMm) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const colorDesc = numColors === 1
    ? 'one region for the entire foreground design'
    : `${numColors} regions, darkest first (id 0) to lightest (id ${numColors - 1})`;

  // Key change: ask for MAX 32 points per polygon to avoid token overflow
  const prompt = `You are a silhouette-tracing assistant for a rhinestone template generator.

Trace the outline of ${colorDesc} in this image.

STRICT RULES:
- Coordinates are NORMALISED: 0.0=top-left, 1.0=bottom-right of the image.
- Use MAXIMUM 32 points per polygon. Fewer is better. Capture the overall shape, not every pixel.
- Close each polygon: last point must equal first point.
- Separate disconnected parts into separate polygon objects.
- Do NOT trace the background or white space.
- recommended_ss: best stone size from [SS6,SS10,SS12,SS16,SS20,SS30] for a ${widthMm}mm wide design. Use SS6-SS12 for detailed/curved designs, SS16-SS30 only for bold designs over 150mm.
- recommended_threshold: grayscale 0-255 where pixels below = foreground.

RESPOND WITH ONLY THIS JSON (no markdown, no extra text):
{"regions":[{"id":0,"color_description":"dark shape","polygons":[{"points":[[0.1,0.1],[0.5,0.05],[0.9,0.1],[0.9,0.9],[0.1,0.9],[0.1,0.1]]}]}],"recommended_ss":"SS12","recommended_threshold":140,"has_thin_strokes":false,"notes":"one sentence description"}`;

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
        generationConfig: {
          temperature: 0.05,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json'  // force JSON mode
        }
      })
    }
  );

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  console.log('Gemini raw response length:', raw.length);
  console.log('Gemini raw preview:', raw.slice(0, 300));

  let parsed;
  try {
    parsed = repairJSON(raw);
  } catch(e) {
    console.error('Full raw response:\n', raw);
    throw new Error('Gemini returned unparseable JSON: ' + e.message);
  }

  // Validate
  if (!Array.isArray(parsed.regions) || parsed.regions.length === 0) {
    throw new Error('Gemini returned no regions');
  }
  for (const r of parsed.regions) {
    if (!Array.isArray(r.polygons)) r.polygons = [];
    r.polygons = r.polygons.filter(p => Array.isArray(p.points) && p.points.length >= 3);
  }
  // Remove regions with no valid polygons
  parsed.regions = parsed.regions.filter(r => r.polygons.length > 0);
  if (parsed.regions.length === 0) throw new Error('No valid polygons after validation');

  return parsed;
}

// ── RAY-CAST POINT-IN-POLYGON ─────────────────────────────────────────────────
function raycast(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// ── STONE GRID ────────────────────────────────────────────────────────────────
function buildStoneGrid(traceResult, wMm, hMm, primarySS, invert) {
  const pitch  = primarySS.pitch;
  const stoneR = midMm(primarySS) / 2;
  const cols   = Math.floor(wMm / pitch);
  const rows   = Math.floor(hMm / pitch);

  // Convert normalised coords → mm
  const shapes = [];
  for (const region of traceResult.regions) {
    for (const poly of region.polygons) {
      shapes.push({
        regionId: region.id,
        pts: poly.points.map(([nx, ny]) => [
          Math.max(0, Math.min(1, nx)) * wMm,
          Math.max(0, Math.min(1, ny)) * hMm
        ])
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
        circles.push({
          x:  parseFloat(cx.toFixed(3)),
          y:  parseFloat(cy.toFixed(3)),
          r:  parseFloat((stoneR * 0.88).toFixed(3)),
          ci: Math.max(0, hitRegion)
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

    // Trace
    let trace;
    try {
      trace = await traceShapes(req.file.buffer.toString('base64'), req.file.mimetype, numColors, wMm);
    } catch(e) {
      console.error('Trace error:', e.message);
      return res.status(500).json({ error: e.message, geminiError: true });
    }

    // Pick stone size
    let primarySS;
    if (sizingMode === 'manual') {
      primarySS = SS_TABLE.find(s => s.n === manualSS) || SS_TABLE[2];
    } else {
      primarySS = SS_TABLE.find(s => s.n === trace.recommended_ss) || SS_TABLE[2];
    }

    // Place stones
    const circles = buildStoneGrid(trace, wMm, hMm, primarySS, invert);

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
        geminiNotes:        trace.notes || '',
        regionDescriptions: trace.regions.map(r => r.color_description || `Region ${r.id}`),
        regionCounts,
        totalStones:        circles.length,
        cols:               Math.floor(wMm / primarySS.pitch),
        hasThinStrokes:     trace.has_thin_strokes || false
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
  console.log(`Rhinestonify v2.1 on :${PORT} | Gemini: ${GEMINI_API_KEY ? 'ready' : 'MISSING KEY'}`)
);
