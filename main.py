"""
Pronunciation Coach — FastAPI application.

Serves both the REST API and the static frontend.
Audio is processed entirely in memory and never written to disk (DPDP compliance).
"""

import io
import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydub import AudioSegment

from analyzer import score_pronunciation
from models import AnalysisResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("pronunciation-coach")

MIN_DURATION = 30  # seconds
MAX_DURATION = 45  # seconds
MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB (Whisper API limit)

ALLOWED_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".flac", ".ogg",
    ".webm", ".mp4", ".mpeg", ".mpga", ".oga",
}

STATIC_DIR = Path(__file__).parent / "static"


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown hooks
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("⚠  OPENAI_API_KEY is not set — /api/analyze will fail.")
    else:
        logger.info("✓  OpenAI API key configured")
    yield
    logger.info("Shutting down.")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Pronunciation Coach",
    description="AI-powered English pronunciation assessment",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {
        "status": "healthy",
        "api_configured": bool(os.environ.get("OPENAI_API_KEY")),
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze_audio(
    audio: UploadFile = File(...),
    x_consent: str | None = Header(None, alias="x-consent"),
):
    """
    Accept an audio upload, validate it, run pronunciation analysis,
    and return scored results. Audio is never persisted.
    """

    # ── DPDP: require explicit consent ──────────────────────────────
    if not x_consent or x_consent.lower() != "true":
        raise HTTPException(
            status_code=400,
            detail="Consent required. Please accept the data processing terms.",
        )

    # ── Guard: API key must be present ──────────────────────────────
    if not os.environ.get("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Service not configured. OPENAI_API_KEY is missing.",
        )

    # ── Read file into memory ───────────────────────────────────────
    audio_bytes = await audio.read()

    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")

    if len(audio_bytes) > MAX_FILE_SIZE:
        mb = len(audio_bytes) / (1024 * 1024)
        raise HTTPException(
            status_code=400, detail=f"File too large ({mb:.1f} MB). Max is 25 MB."
        )

    # ── Validate extension ──────────────────────────────────────────
    filename = audio.filename or "audio.wav"
    ext = os.path.splitext(filename)[1].lower()
    if ext and ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{ext}'. Use WAV, MP3, M4A, FLAC, OGG, or WebM.",
        )

    # ── Validate duration (server-side) ─────────────────────────────
    # pydub requires ffmpeg. If ffmpeg is absent (local dev), we skip
    # server-side duration validation and rely on the client-side check
    # plus Whisper's own duration field. In Docker, ffmpeg is installed.
    duration = None
    try:
        segment = AudioSegment.from_file(io.BytesIO(audio_bytes))
        duration = len(segment) / 1000.0
    except Exception as exc:
        logger.warning("pydub/ffmpeg unavailable — skipping server duration check: %s", exc)

    if duration is not None:
        if duration < MIN_DURATION:
            raise HTTPException(
                status_code=400,
                detail=f"Audio too short ({duration:.1f}s). Minimum is {MIN_DURATION}s.",
            )

        if duration > MAX_DURATION:
            raise HTTPException(
                status_code=400,
                detail=f"Audio too long ({duration:.1f}s). Maximum is {MAX_DURATION}s.",
            )

    # ── Run analysis ────────────────────────────────────────────────
    try:
        logger.info("Analyzing %s (%.1fs)…", filename, duration)
        result = await score_pronunciation(audio_bytes, filename)
        return AnalysisResponse(success=True, result=result)

    except Exception as exc:
        logger.error("Analysis failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Analysis failed: {exc}. Try again with a clearer recording.",
        )

    finally:
        # DPDP: eagerly drop the reference so GC can reclaim audio
        del audio_bytes


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def serve_index():
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return JSONResponse({"error": "Frontend not found"}, status_code=404)
