# Pronunciation Coach

AI-powered English pronunciation assessment. Upload 30–45 seconds of English speech and get instant feedback with word-level analysis, scores, and IPA guidance.

**Live URL:** [https://pronunciation-coach-pqzc.onrender.com](https://pronunciation-coach-pqzc.onrender.com)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML / CSS / JS |
| Backend | Python 3.12 + FastAPI |
| Speech-to-Text | OpenAI Whisper API |
| Analysis | OpenAI GPT-4o-mini |
| Audio Processing | pydub + ffmpeg |
| Deployment | Render (Docker) |

## Quick Start (Local)

### Prerequisites

- Python 3.10+
- ffmpeg installed and on PATH
- OpenAI API key

### Setup

```bash
# Clone the repo
git clone https://github.com/coder-lovek/pronunciation-coach.git
cd pronunciation-coach

# Create virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Set your API key
set OPENAI_API_KEY=sk-...    # Windows
# export OPENAI_API_KEY=sk-... # macOS/Linux

# Run
uvicorn main:app --reload --port 8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## Project Structure

```
pronunciation-coach/
├── main.py              # FastAPI server (routes, validation, static serving)
├── analyzer.py          # Pronunciation analysis pipeline (Whisper + GPT-4o-mini)
├── models.py            # Pydantic data models
├── requirements.txt     # Python dependencies
├── Dockerfile           # Production container
├── render.yaml          # Render deployment config
├── ARCHITECTURE.md      # System architecture document
├── static/
│   ├── index.html       # Frontend page
│   ├── style.css        # Design system
│   └── app.js           # Client-side application logic
└── README.md
```

## Deployment (Render)

1. Push to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect the GitHub repo
4. Set **Runtime** = Docker
5. Add environment variable: `OPENAI_API_KEY`
6. Deploy

Or use the `render.yaml` Blueprint:  
Dashboard → Blueprints → New Blueprint Instance → connect repo.

## API

### `POST /api/analyze`

Upload an audio file for pronunciation assessment.

**Headers:**
- `x-consent: true` (required, DPDP compliance)

**Body:** `multipart/form-data` with field `audio`

**Response:**
```json
{
  "success": true,
  "result": {
    "overall_score": 78,
    "fluency_score": 82,
    "clarity_score": 75,
    "words": [
      { "word": "hello", "status": "correct", "feedback": "", "expected_ipa": "" },
      { "word": "world", "status": "mispronounced", "feedback": "...", "expected_ipa": "wɜːrld" }
    ],
    "summary": "...",
    "strengths": ["..."],
    "improvements": ["..."]
  }
}
```

### `GET /api/health`

Returns service health and API key configuration status.

## License

MIT
