# System Architecture — Pronunciation Coach

## 1. Overview

Pronunciation Coach is a web application that assesses English pronunciation from short audio recordings (30–45 seconds). A user uploads or records audio in the browser; the server transcribes it, computes speech metrics, and uses an LLM to produce a word-level pronunciation assessment — all without storing any user data.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (Client)                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │
│  │ Upload / Rec  │→│ Validate     │→│ POST /api/analyze          │ │
│  │ (drag-drop,  │  │ (format,     │  │ FormData + x-consent: true │ │
│  │  mic record) │  │  30-45s)     │  └─────────┬──────────────────┘ │
│  └──────────────┘  └──────────────┘            │                    │
│                                                │                    │
│  ┌─────────────────────────────────────────────┴──────────────────┐ │
│  │ Results UI: Score rings · Word chips · Detail cards · Summary  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RENDER (Server — Docker container)                                 │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ FastAPI (main.py)                                              │ │
│  │  • CORS middleware          • Consent validation (DPDP)        │ │
│  │  • File size / format guard • Duration check via pydub+ffmpeg  │ │
│  │  • Serves static frontend  • /api/health, /api/analyze        │ │
│  └──────────┬──────────────────────────────┬─────────────────────┘ │
│             │                              │                       │
│             ▼                              ▼                       │
│  ┌──────────────────┐          ┌────────────────────────┐          │
│  │ OpenAI Whisper    │          │ OpenAI GPT-4o-mini     │          │
│  │ (whisper-1)       │          │ (chat.completions)     │          │
│  │                   │          │                        │          │
│  │ IN:  audio bytes  │          │ IN:  transcription,    │          │
│  │ OUT: text,        │─────────→│      segments, metrics │          │
│  │      segments     │          │ OUT: JSON with per-word│          │
│  │      (avg_logprob)│          │      scores, IPA,      │          │
│  │      words        │          │      summary           │          │
│  │      (timestamps) │          │                        │          │
│  └──────────────────┘          └────────────────────────┘          │
│                                                                     │
│  Audio bytes deleted from memory after response (DPDP)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Models & APIs — What and Why

### OpenAI Whisper (`whisper-1`)

**Role:** Speech-to-text transcription with word-level timestamps and segment-level confidence.

**Why Whisper over alternatives:**

| Alternative | Trade-off |
|-------------|-----------|
| Google Cloud STT | Word-level confidence scores, but requires GCP project + service account. Whisper is simpler to integrate via a single API key. |
| Azure Speech (Pronunciation Assessment) | Gold-standard phoneme-level scoring, but requires Azure account, SDK setup, and a more complex integration. Best upgrade path for v2. |
| Deepgram | Great word-level confidence, but adds a second API provider. Whisper + GPT-4o-mini keeps everything under one OpenAI key. |
| Browser Web Speech API | Free but wildly inconsistent across browsers, no confidence data, poor non-native accent handling. |

**Key outputs used:**
- `text` — full transcription
- `segments[].avg_logprob` — segment confidence (lower = less confident = potential pronunciation issue)
- `segments[].no_speech_prob` — silence detection
- `words[].word`, `words[].start`, `words[].end` — word boundaries for metric computation

### OpenAI GPT-4o-mini

**Role:** Analyze the transcription to identify pronunciation issues and produce structured feedback.

**Why GPT-4o-mini:**
- **Cost-effective** — ~20× cheaper than GPT-4o, fast enough for real-time use
- **JSON mode** — `response_format: json_object` ensures valid structured output
- **Contextual reasoning** — can infer mispronunciation from context (e.g., "tree" transcribed where "three" was intended = th/t confusion)
- **IPA knowledge** — can generate correct IPA pronunciations for flagged words

---

## 4. Scoring & Highlighting Methodology

### Scoring Pipeline

```
Audio → Whisper → Transcription + Segments + Words
                         │
                         ▼
              Metric Computation
              ├─ Speech Rate (WPM)
              ├─ Pause Ratio
              └─ Avg Segment Confidence
                         │
                         ▼
              GPT-4o-mini Analysis
              ├─ Overall Score (0-100)
              ├─ Fluency Score (0-100)
              ├─ Clarity Score (0-100)
              ├─ Per-word: correct / mispronounced / unclear
              ├─ Specific feedback per flagged word
              └─ IPA pronunciation for corrections
```

### How It Works

1. **Whisper transcribes the audio** with verbose output, producing segment confidence (`avg_logprob`) and word timestamps.

2. **Computed metrics** provide quantitative signals:
   - **Speech rate** (WPM): 120–160 is optimal; outside this range suggests fluency issues
   - **Pause ratio**: High pause ratio = hesitation
   - **Avg confidence**: Segments with `avg_logprob < -0.5` indicate Whisper struggled, likely due to unclear pronunciation

3. **GPT-4o-mini receives the transcription + metrics** and applies its knowledge of:
   - Common ESL pronunciation patterns (th/s, r/l, v/w, vowel shifts, consonant clusters)
   - Contextual analysis — if a transcribed word doesn't fit the context, the speaker likely mispronounced a similar word
   - The relationship between Whisper's confidence and pronunciation clarity

4. **Highlighting logic:**
   - 🟢 **Correct** (green) — word pronounced clearly
   - 🟡 **Unclear** (yellow) — pronunciation could be improved, but was understood
   - 🔴 **Mispronounced** (red) — likely pronunciation error, with specific feedback and IPA

### Limitations

This approach scores **transcription-derived pronunciation**, not raw acoustics. It cannot detect:
- Subtle accent variations that don't affect transcription
- Intonation or prosody issues (beyond what's captured in speech rate)
- Phoneme-level errors that Whisper still transcribes correctly

**Upgrade path:** Azure Cognitive Services Pronunciation Assessment provides phoneme-level accuracy with acoustic analysis. This would be the natural v2 enhancement.

---

## 5. DPDP Compliance

This app is designed with India's **Digital Personal Data Protection Act (DPDP) 2023** in mind.

### 5.1 Data Minimisation (Section 4)

| Data Type | Collected? | Stored? | Details |
|-----------|-----------|---------|---------|
| Audio file | Yes (uploaded) | **No** | Processed in-memory only. Never written to disk, database, or cache. Python reference deleted (`del audio_bytes`) after processing. |
| Transcription | Yes (generated) | **No** | Exists only in server memory during the request lifecycle. Returned to client, then discarded. |
| Analysis results | Yes (generated) | **No** | Returned in the HTTP response body. Not logged or persisted server-side. |
| Personal identifiers | **No** | **No** | No accounts, emails, names, IP logging, or cookies. |

### 5.2 Consent (Section 6)

- A **mandatory consent checkbox** must be checked before uploading audio
- The consent text clearly states: what data is processed, how it's handled, and that it's deleted immediately
- The API enforces consent via the `x-consent: true` header — requests without it are rejected (HTTP 400)
- Consent is **freely given, specific, informed, and unambiguous** — the user actively checks a box

### 5.3 Purpose Limitation (Section 4)

Audio is used **solely** for pronunciation assessment. It is not:
- Stored for later use
- Used for model training or fine-tuning
- Shared with third parties beyond the stated API providers
- Used for analytics, profiling, or any secondary purpose

### 5.4 Data Residency & Cross-Border Transfer

- **Server:** Render (US-based hosting)
- **APIs:** OpenAI (US-based processing)
- **Disclosure:** The privacy section clearly states that audio is sent to OpenAI's US-based servers
- **Mitigation:** Since no data is stored and processing is ephemeral, cross-border data concerns are minimised. No personal data persists outside the request lifecycle.

### 5.5 Deletion & Retention

- **Retention period:** Zero. Audio is held in memory only during the ~10-15 second analysis window.
- **Automatic deletion:** Python's garbage collector reclaims memory after the request handler returns. `del audio_bytes` is called explicitly in a `finally` block.
- **No deletion requests needed:** Since nothing is stored, there is nothing to delete. The user's "right to erasure" is satisfied by design.

### 5.6 Security

- HTTPS enforced (Render provides TLS by default)
- No database, no credentials stored, no attack surface for data exfiltration
- API key stored as a server-side environment variable, never exposed to the client

---

## 6. Trade-offs & Future Work

### Deliberate Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Whisper + LLM vs. Azure Pronunciation Assessment | Less granular (no phoneme-level scoring) | Single API provider, simpler setup, faster to ship. Azure would be the v2 upgrade. |
| GPT-4o-mini vs. GPT-4o | Slightly less nuanced analysis | 20× cheaper, fast enough, and pronunciation patterns are well within its capability. |
| Render free tier | Cold starts (~30s after 15 min idle) | Zero cost, sufficient for demo. Paid tier eliminates cold starts. |
| No user accounts | No history, no progress tracking | Maximises DPDP compliance, simplifies architecture. |
| Client-side duration validation | Can be bypassed (server also validates) | Better UX — instant feedback before upload. Server is the source of truth. |
| Vanilla HTML/CSS/JS | No component framework | Zero build step, instant load, no tooling overhead for a single-page app. |

### What I'd Build Next (1 More Week)

1. **Azure Pronunciation Assessment integration** — phoneme-level accuracy with acoustic analysis, the industry standard for language learning apps
2. **Reference text mode** — let users provide the text they're reading, enabling word-by-word comparison between intended and actual speech
3. **Audio recording improvements** — noise detection, automatic gain control, waveform playback with word-aligned highlighting
4. **Progress tracking** — optional accounts (with proper DPDP consent flows) to track improvement over time
5. **Multi-language support** — extend beyond English to other languages Whisper supports
6. **Caching layer** — for repeat analyses, with explicit user consent and TTL-based auto-deletion
7. **Rate limiting** — prevent API abuse; currently relies on Render's built-in DDoS protection
