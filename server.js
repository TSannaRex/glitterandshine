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

// ── GEMINI: just get settings — tiny response, very reliable ──────────────────
async function analyzeImage(imageBase64, mimeType, widthMm) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const prompt = `Analyze this image for rhinestone template generation. Respond with ONLY a JSON object, no markdown:
{"threshold":140,"recommended_ss":"SS12","has_thin_strokes":false,"notes":"brief description"}

Rules:
- threshold: integer 0-255. Pixels with grayscale value BELOW this are foreground. For dark designs on white background use 180-200. For light designs use 50-100.
- recommended_ss: one of SS6 SS10 SS12 SS16 SS20 SS30. The design will be ${widthMm}mm wide. Use SS6-SS10 for small/detailed designs under 80mm or designs with fine curves. Use SS12 for 80-150mm. Use SS16+ only for bold simple designs over 150mm.
- has_thin_strokes: true if any part of the design is a thin line or stroke
- notes: one short sentence describing the design`;

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
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
      })
    }
  );

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();

  try {
    const parsed = JSON.parse(clean);
    // Validate and clamp
    return {
      threshold:         Math.min(254, Math.max(1, parseInt(parsed.threshold) || 180)),
      recommended_ss:    SS_TABLE.find(s => s.n === parsed.recommended_ss) ? parsed.recommended_ss : 'SS12',
      has_thin_strokes:  !!parsed.has_thin_strokes,
      notes:             parsed.notes || ''
    };
  } catch(e) {
    // Try regex extraction as fallback
    const thr  = raw.match(/"threshold"\s*:\s*(\d+)/)?.[1];
    const ss   = raw.match(/"recommended_ss"\s*:\s*"([^"]+)"/)?.[1];
    const thin = raw.match(/"has_thin_strokes"\s*:\s*(true|false)/)?.[1];
    const note = raw.match(/"notes"\s*:\s*"([^"]+)"/)?.[1];
    return {
      threshold:        thr  ? Math.min(254, parseInt(thr)) : 180,
      recommended_ss:   ss && SS_TABLE.find(s => s.n === ss) ? ss : 'SS12',
      has_thin_strokes: thin === 'true',
      notes:            note || ''
    };
  }
}

// ── API ───────────────────────────────────────────────────────────────────────
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const wMm = parseFloat(req.body.targetWidthMm) || 100;
    let analysis;
    try {
      analysis = await analyzeImage(req.file.buffer.toString('base64'), req.file.mimetype, wMm);
    } catch(e) {
      console.warn('Gemini failed, using defaults:', e.message);
      analysis = { threshold: 180, recommended_ss: 'SS12', has_thin_strokes: false, notes: '' };
    }

    // Build SS preview table for all sizes
    const ssTable = SS_TABLE.map(s => ({
      ...s,
      stonesAcross: Math.floor(wMm / s.pitch),
      recommended: s.n === analysis.recommended_ss
    }));

    res.json({ success: true, analysis, ssTable });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', geminiConfigured: !!GEMINI_API_KEY, ts: new Date().toISOString() })
);

app.listen(PORT, () =>
  console.log(`Rhinestonify v4 on :${PORT} | Gemini: ${GEMINI_API_KEY ? 'ready' : 'MISSING KEY'}`)
);
