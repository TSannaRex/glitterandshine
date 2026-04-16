[README.md](https://github.com/user-attachments/files/26779386/README.md)
# Rhinestonify

Rhinestone SVG cutfile generator powered by Google Gemini Vision.

Upload any image → get a print-ready SVG with precise stone placement, calibrated to CF Rhinestone Sizing Guide specs.

## Features

- Gemini Vision analyzes image structure and recommends optimal settings
- Auto stone size selection based on design width and use case
- Multi-size mode: large stones for solid fills, small stones for thin strokes
- 1–3 color support with per-color stone counts
- Live preview with hex grid layout
- SVG export with mm dimensions, grouped by color/size layer

## Stack

- **Frontend**: Vanilla HTML/CSS/JS
- **Backend**: Node.js + Express
- **AI**: Google Gemini 2.0 Flash Vision
- **Deploy**: Render

---

## Local development

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/rhinestonify.git
cd rhinestonify
npm install

# 2. Add your Gemini API key
cp .env.example .env
# Edit .env and add your key from https://aistudio.google.com/apikey

# 3. Run
npm run dev
# Open http://localhost:3000
```

---

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Deploy**
5. In Render dashboard → Environment → add:
   - `GEMINI_API_KEY` = your key from [AI Studio](https://aistudio.google.com/apikey)
6. Done — your app is live

---

## SS Size reference (from CF Rhinestone Sizing Guide)

| Size  | Diameter    | Pitch  |
|-------|-------------|--------|
| SS6   | 1.9–2.1mm   | 2.40mm |
| SS10  | 2.7–2.9mm   | 3.10mm |
| SS12  | 3.0–3.2mm   | 3.35mm |
| SS16  | 3.8–4.0mm   | 3.96mm |
| SS20  | 4.6–4.8mm   | 4.76mm |
| SS30  | 6.3–6.5mm   | 6.50mm |
