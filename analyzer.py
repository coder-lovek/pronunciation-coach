"""
Pronunciation analysis pipeline.

Flow: Audio → Whisper transcription → Metric computation → GPT-4o-mini analysis → Scored result

Whisper provides word-level timestamps and segment-level confidence (avg_logprob).
GPT-4o-mini analyzes the transcription to identify pronunciation issues,
considering common ESL patterns and Whisper's confidence signals.
"""

import io
import json
import logging
import os

from openai import AsyncOpenAI

from models import WordAssessment, PronunciationResult

logger = logging.getLogger(__name__)

_client = None


def _get_client() -> AsyncOpenAI:
    """Lazy-init the OpenAI client to point to Groq's API."""
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=os.environ.get("GROQ_API_KEY"),
        )
    return _client

# ---------------------------------------------------------------------------
# System prompt for the pronunciation assessor
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are an expert English pronunciation coach who analyzes speech "
    "transcriptions to assess pronunciation quality. You are encouraging "
    "but honest. For each flagged word you provide specific, actionable "
    "guidance with IPA pronunciation. You respond ONLY with valid JSON."
)


# ---------------------------------------------------------------------------
# Step 1: Transcribe with Whisper
# ---------------------------------------------------------------------------
async def transcribe_audio(audio_bytes: bytes, filename: str) -> dict:
    """Send audio to Whisper and return verbose transcription with timestamps."""
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = filename or "audio.wav"

    response = await _get_client().audio.transcriptions.create(
        model="whisper-large-v3",
        file=audio_file,
        response_format="verbose_json",
        timestamp_granularities=["word", "segment"],
        language="en",
    )

    # Normalize segment/word objects to plain dicts
    def _to_dict(obj):
        if hasattr(obj, "model_dump"):
            return obj.model_dump()
        if isinstance(obj, dict):
            return obj
        return dict(obj)

    segments = [_to_dict(s) for s in (response.segments or [])]
    words = [_to_dict(w) for w in (response.words or [])]

    return {
        "text": response.text,
        "segments": segments,
        "words": words,
        "duration": response.duration,
    }


# ---------------------------------------------------------------------------
# Step 2: Compute speech metrics
# ---------------------------------------------------------------------------
def compute_metrics(transcription: dict) -> dict:
    """Derive speech-rate, pause ratio, and confidence from transcription data."""
    words = transcription.get("words", [])
    segments = transcription.get("segments", [])
    duration = transcription.get("duration", 0) or 1  # avoid division by zero

    # Word count (skip empty/whitespace tokens)
    word_count = len([w for w in words if w.get("word", "").strip()])

    # Words per minute
    speech_rate = (word_count / duration) * 60

    # Average segment log-probability (closer to 0 = higher confidence)
    avg_confidence = 0.0
    if segments:
        logprobs = [
            s["avg_logprob"]
            for s in segments
            if s.get("avg_logprob") is not None
        ]
        if logprobs:
            avg_confidence = sum(logprobs) / len(logprobs)

    # Pause analysis: sum of inter-word gaps > 300 ms
    total_pause = 0.0
    if len(words) > 1:
        for i in range(1, len(words)):
            gap = words[i].get("start", 0) - words[i - 1].get("end", 0)
            if gap > 0.3:
                total_pause += gap

    pause_ratio = total_pause / duration

    return {
        "word_count": word_count,
        "duration": round(duration, 1),
        "speech_rate": round(speech_rate, 1),
        "avg_confidence": round(avg_confidence, 3),
        "pause_ratio": round(pause_ratio, 3),
    }


# ---------------------------------------------------------------------------
# Step 3: LLM pronunciation analysis
# ---------------------------------------------------------------------------
async def analyze_pronunciation(
    transcription: dict, metrics: dict
) -> PronunciationResult:
    """Ask GPT-4o-mini to assess pronunciation from the transcription."""

    words_list = [
        w.get("word", "").strip()
        for w in transcription.get("words", [])
        if w.get("word", "").strip()
    ]

    segments_info = [
        {
            "text": s.get("text", "").strip(),
            "confidence": s.get("avg_logprob", 0),
            "no_speech_prob": s.get("no_speech_prob", 0),
        }
        for s in transcription.get("segments", [])
    ]

    user_prompt = f"""Analyze this English speech transcription for pronunciation quality.

CONTEXT: A learner recorded themselves speaking English. Whisper ASR produced the
transcription below. Your task is to assess each word and provide actionable feedback.

ANALYSIS PRINCIPLES:
- If a transcribed word seems contextually wrong, the speaker likely mispronounced a
  similar-sounding word that Whisper misrecognized. Flag this as "mispronounced" and
  suggest what the intended word might have been.
- Low segment confidence (avg_logprob < -0.5) indicates unclear pronunciation.
- Consider common ESL difficulties: th/s/z, r/l, v/w, vowel shifts, word stress,
  consonant clusters, final consonant deletion, schwa insertion.
- Speech rate outside 120-160 WPM may indicate fluency challenges.
- High pause ratio suggests hesitation or lack of confidence.

TRANSCRIPTION: "{transcription['text']}"

SEGMENT DETAILS (confidence closer to 0 = more confident):
{json.dumps(segments_info, indent=2)}

SPEECH METRICS:
- Duration: {metrics['duration']}s
- Words: {metrics['word_count']}
- Speech rate: {metrics['speech_rate']} WPM  (optimal range: 120-160)
- Avg segment confidence: {metrics['avg_confidence']}
- Pause ratio: {metrics['pause_ratio']:.1%}

WORDS (in spoken order): {json.dumps(words_list)}

Respond with ONLY this JSON structure — no markdown, no commentary:
{{
  "overall_score": <0-100 int>,
  "fluency_score": <0-100 int>,
  "clarity_score": <0-100 int>,
  "words": [
    {{
      "word": "<the word as transcribed>",
      "status": "correct|mispronounced|unclear",
      "feedback": "<specific feedback or empty string if correct>",
      "expected_ipa": "<IPA pronunciation or empty string if correct>"
    }}
  ],
  "summary": "<2-3 sentence overall assessment>",
  "strengths": ["<strength 1>", "<strength 2>"],
  "improvements": ["<area 1>", "<area 2>"]
}}

IMPORTANT:
- The "words" array MUST have exactly one entry per word in the WORDS list, same order.
- Be constructive and encouraging — this is for a real learner.
- For mispronounced words, explain WHAT went wrong and HOW to fix it.
- Provide IPA only for words that need correction."""

    response = await _get_client().chat.completions.create(
        model="llama3-8b-8192",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=4000,
    )

    raw = response.choices[0].message.content
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("LLM returned invalid JSON: %s", raw[:500])
        raise RuntimeError("Pronunciation analysis returned an invalid response. Please try again.")

    # Build typed word assessments
    word_assessments: list[WordAssessment] = []
    for w in result.get("words", []):
        status = w.get("status", "correct")
        if status not in ("correct", "mispronounced", "unclear"):
            status = "correct"
        word_assessments.append(
            WordAssessment(
                word=w.get("word", ""),
                status=status,
                feedback=w.get("feedback", ""),
                expected_ipa=w.get("expected_ipa", ""),
            )
        )

    return PronunciationResult(
        overall_score=max(0, min(100, result.get("overall_score", 0))),
        fluency_score=max(0, min(100, result.get("fluency_score", 0))),
        clarity_score=max(0, min(100, result.get("clarity_score", 0))),
        words=word_assessments,
        summary=result.get("summary", "Analysis complete."),
        strengths=result.get("strengths", []),
        improvements=result.get("improvements", []),
    )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
async def score_pronunciation(
    audio_bytes: bytes, filename: str
) -> PronunciationResult:
    """Run the full pronunciation assessment pipeline."""
    logger.info("Step 1/3 — Transcribing audio with Whisper...")
    transcription = await transcribe_audio(audio_bytes, filename)

    if not transcription.get("text", "").strip():
        raise RuntimeError(
            "No speech detected in the audio. Please upload a recording "
            "where you are clearly speaking English."
        )

    logger.info(
        "Step 2/3 — Computing metrics (%d words, %.1fs)...",
        len(transcription.get("words", [])),
        transcription.get("duration", 0),
    )
    metrics = compute_metrics(transcription)

    logger.info("Step 3/3 — Analyzing pronunciation with GPT-4o-mini...")
    result = await analyze_pronunciation(transcription, metrics)

    logger.info("Done — overall score: %d", result.overall_score)
    return result
