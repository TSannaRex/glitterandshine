require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Memory storage — no disk writes needed
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ─── SS SIZE TABLE (from CF Rhinestone Sizing Guide) ──────────────────────────
const SS_TABLE = [
  { n: 'SS6',  lo: 1.9, hi: 2.1, pitch: 2.40 },
  { n: 'SS10', lo: 2.7, hi: 2.9, pitch: 3.10 },
  { n: 'SS12', lo: 3.0, hi: 3.2, pitch: 3.35 },
  { n: 'SS16', lo: 3.8, hi: 4.0, pitch: 3.96 },
  { n: 'SS20', lo: 4.6, hi: 4.8, pitch: 4.76 },
  { n: 'SS30', lo: 6.3, hi: 6.5, pitch: 6.50 },
];

function midMm(s) { return (s.lo + s.hi) / 2; }

function pickAutoSS(widthMm, darkRatio) {
  // Target 28–35 stones across depending on image complexity
  const targetAcross = darkRatio > 0.4 ? 35 : 28;
  let best = SS_TABLE[1], bestDiff = Infinity;
  for (const s of SS_TABLE) {
    const diff = Math.abs(widthMm / s.pitch - targetAcross);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// ─── GEMINI VISION: analyze image regions ─────────────────────────────────────
async function analyzeWithGemini(imageBase64, mimeType, numColors) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const colorInstruction = numColors === 1
    ? 'Identify the single dark foreground shape region.'
    : `Identify ${numColors} distinct color/tone regions in order from darkest to lightest. Label them region_0 (darkest) through region_${numColors - 1} (lightest).`;

  const prompt = `You are analyzing an image for rhinestone template generation.

${colorInstruction}

Respond ONLY with a valid JSON object in this exact format (no markdown, no explanation):
{
  "regions": [
    {
      "id": 0,
      "description": "brief description of this region",
      "approximate_coverage": 0.0
    }
  ],
  "has_thin_strokes": true,
  "has_solid_fills": true,
  "recommended_threshold": 128,
  "notes": "any important notes about the design structure"
}

approximate_coverage is a float 0.0-1.0 of what fraction of the image this region covers.
recommended_threshold is a grayscale value 0-255 where pixels darker than this are foreground.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBase64
              }
            },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024
        }
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Strip markdown fences if present
  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Gemini JSON parse failed:', rawText);
    // Return safe defaults
    return {
      regions: [{ id: 0, description: 'foreground', approximate_coverage: 0.3 }],
      has_thin_strokes: false,
      has_solid_fills: true,
      recommended_threshold: 128,
      notes: 'Fallback defaults used'
    };
  }
}

// ─── STONE GRID COMPUTATION ───────────────────────────────────────────────────
function computeStoneGrid(imageBase64, mimeType, settings, geminiAnalysis) {
  // We compute the stone grid based on settings + gemini's recommended threshold
  const {
    targetWidthMm,
    numColors,
    sizingMode,
    manualSS,
    threshold: clientThreshold,
    minFillPct,
    invert
  } = settings;

  // Use Gemini's threshold recommendation if available, otherwise client value
  const threshold = geminiAnalysis?.recommended_threshold || clientThreshold || 160;
  const hasThinStrokes = geminiAnalysis?.has_thin_strokes || false;

  // Pick primary SS
  let primarySS;
  if (sizingMode === 'manual') {
    primarySS = SS_TABLE.find(s => s.n === manualSS) || SS_TABLE[1];
  } else {
    const darkRatio = (geminiAnalysis?.regions?.[0]?.approximate_coverage) || 0.25;
    primarySS = pickAutoSS(targetWidthMm, darkRatio);
  }

  // In multi-size mode, secondary is one step smaller
  const primaryIdx = SS_TABLE.indexOf(primarySS);
  const secondarySS = (sizingMode === 'multi' && primaryIdx > 0 && hasThinStrokes)
    ? SS_TABLE[primaryIdx - 1]
    : null;

  return {
    primarySS,
    secondarySS,
    threshold,
    geminiNotes: geminiAnalysis?.notes || '',
    geminiRegions: geminiAnalysis?.regions || []
  };
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Analyze image — returns Gemini analysis + recommended settings
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const numColors = parseInt(req.body.numColors) || 1;

    const analysis = await analyzeWithGemini(imageBase64, mimeType, numColors);

    // Determine SS recommendation
    const darkRatio = analysis.regions?.[0]?.approximate_coverage || 0.25;
    const targetWidthMm = parseFloat(req.body.targetWidthMm) || 100;
    const recommendedSS = pickAutoSS(targetWidthMm, darkRatio);

    res.json({
      success: true,
      analysis,
      recommendation: {
        primarySS: recommendedSS,
        secondarySS: analysis.has_thin_strokes && SS_TABLE.indexOf(recommendedSS) > 0
          ? SS_TABLE[SS_TABLE.indexOf(recommendedSS) - 1]
          : null,
        threshold: analysis.recommended_threshold,
        notes: analysis.notes
      }
    });
  } catch (err) {
    console.error('/api/analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate stone grid — returns circle positions as JSON
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const settings = {
      targetWidthMm: parseFloat(req.body.targetWidthMm) || 100,
      numColors: parseInt(req.body.numColors) || 1,
      sizingMode: req.body.sizingMode || 'auto',
      manualSS: req.body.manualSS || 'SS10',
      threshold: parseInt(req.body.threshold) || 160,
      minFillPct: parseFloat(req.body.minFillPct) || 0.2,
      invert: req.body.invert === 'true'
    };

    // Get Gemini analysis
    let geminiAnalysis = null;
    try {
      geminiAnalysis = await analyzeWithGemini(
        req.file.buffer.toString('base64'),
        req.file.mimetype,
        settings.numColors
      );
    } catch (e) {
      console.warn('Gemini analysis failed, using defaults:', e.message);
    }

    const gridConfig = computeStoneGrid(
      req.file.buffer.toString('base64'),
      req.file.mimetype,
      settings,
      geminiAnalysis
    );

    // Return config — actual pixel sampling happens client-side with canvas
    // (we send back the SS sizes and threshold; client does the heavy pixel work)
    const { targetWidthMm, numColors } = settings;
    const aspect = 1; // client knows actual image dimensions
    const cols = Math.floor(targetWidthMm / gridConfig.primarySS.pitch);

    res.json({
      success: true,
      config: {
        primarySS: gridConfig.primarySS,
        secondarySS: gridConfig.secondarySS,
        threshold: gridConfig.threshold,
        targetWidthMm,
        numColors,
        geminiNotes: gridConfig.geminiNotes,
        geminiRegions: gridConfig.geminiRegions,
        estimatedCols: cols
      }
    });
  } catch (err) {
    console.error('/api/generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: !!GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Rhinestonify running on port ${PORT}`);
  console.log(`Gemini API: ${GEMINI_API_KEY ? 'configured' : 'NOT configured — set GEMINI_API_KEY'}`);
});
