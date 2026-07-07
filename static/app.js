/* ═══════════════════════════════════════════════════════════════
   Pronunciation Coach — Frontend Application
   ═══════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ── State ─────────────────────────────────────────────────
  let audioFile = null;
  let audioDuration = 0;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStartTime = null;
  let recordTimerInterval = null;
  let audioStream = null;
  let analyserNode = null;
  let animFrameId = null;

  // ── DOM refs ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dropZone        = $("#drop-zone");
  const fileInput       = $("#file-input");
  const audioPreview    = $("#audio-preview");
  const audioPlayer     = $("#audio-player");
  const fileNameEl      = $("#file-name");
  const fileDurationEl  = $("#file-duration");
  const btnRemove       = $("#btn-remove");
  const consentCheckbox = $("#consent-checkbox");
  const btnAnalyze      = $("#btn-analyze");
  const uploadSection   = $("#upload-section");
  const loadingSection  = $("#loading-section");
  const loadingText     = $("#loading-text");
  const resultsSection  = $("#results-section");
  const errorBanner     = $("#error-banner");
  const errorText       = $("#error-text");
  const btnRetry        = $("#btn-retry");

  // Recorder
  const btnRecord       = $("#btn-record");
  const btnStopRecord   = $("#btn-stop-record");
  const recordTimerEl   = $("#record-timer");
  const recordHint      = $("#record-range-hint");
  const vizCanvas       = $("#visualizer-canvas");

  // ── Tab switching ─────────────────────────────────────────
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      $$(".tab-content").forEach((c) => c.classList.remove("active"));

      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      const panel = $(`#tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add("active");
    });
  });

  // ── Drag & Drop ───────────────────────────────────────────
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  // ── File handling ─────────────────────────────────────────
  async function handleFile(file) {
    hideError();

    // Validate MIME type loosely (some browsers report different types)
    const validExts = [
      ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm",
      ".mp4", ".mpeg", ".mpga", ".oga", ".wma",
    ];
    const ext = (file.name || "").toLowerCase().match(/\.[^.]+$/)?.[0] || "";
    const isAudio = file.type.startsWith("audio/") || file.type.startsWith("video/");
    if (!isAudio && ext && !validExts.includes(ext)) {
      showError("Unsupported file type. Please upload WAV, MP3, M4A, FLAC, OGG, or WebM.");
      return;
    }

    // Decode to check duration
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      audioDuration = decoded.duration;
      audioCtx.close();
    } catch {
      // Fallback: let the server validate duration
      audioDuration = null;
    }

    if (audioDuration !== null) {
      if (audioDuration < 30) {
        showError(`Audio too short (${audioDuration.toFixed(1)}s). Minimum is 30 seconds.`);
        return;
      }
      if (audioDuration > 45) {
        showError(`Audio too long (${audioDuration.toFixed(1)}s). Maximum is 45 seconds.`);
        return;
      }
    }

    audioFile = file;
    showPreview(file);
  }

  function showPreview(file) {
    fileNameEl.textContent = file.name || "recording.webm";
    fileDurationEl.textContent = audioDuration
      ? `${audioDuration.toFixed(1)}s`
      : "—";
    audioPlayer.src = URL.createObjectURL(file);
    audioPreview.classList.remove("hidden");
    updateAnalyzeButton();
  }

  btnRemove.addEventListener("click", () => {
    audioFile = null;
    audioDuration = 0;
    audioPreview.classList.add("hidden");
    audioPlayer.src = "";
    fileInput.value = "";
    updateAnalyzeButton();
  });

  // ── Consent & Analyze button ──────────────────────────────
  function updateAnalyzeButton() {
    btnAnalyze.disabled = !(audioFile && consentCheckbox.checked);
  }

  consentCheckbox.addEventListener("change", updateAnalyzeButton);

  // ── Recording ─────────────────────────────────────────────
  btnRecord.addEventListener("click", startRecording);
  btnStopRecord.addEventListener("click", stopRecording);

  async function startRecording() {
    hideError();

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showError(
        "Microphone access denied. Please allow microphone permission to record."
      );
      return;
    }

    // Pick a supported MIME type
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";

    mediaRecorder = new MediaRecorder(audioStream, { mimeType });
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mimeType });
      const ext = mimeType.includes("webm") ? "webm" : "mp4";
      const file = new File([blob], `recording.${ext}`, { type: mimeType });
      await handleFile(file);
      cleanupRecording();
    };

    mediaRecorder.start(250); // Collect data every 250ms
    recordStartTime = Date.now();

    btnRecord.disabled = true;
    btnRecord.classList.add("recording");
    btnStopRecord.disabled = false;

    // Start visualizer
    setupVisualizer(audioStream);

    // Timer
    recordTimerInterval = setInterval(() => {
      const elapsed = (Date.now() - recordStartTime) / 1000;
      recordTimerEl.textContent = formatTime(elapsed);

      if (elapsed >= 30) {
        recordHint.textContent = "✓ You can stop now, or keep going up to 45s";
        recordHint.style.color = "#10b981";
      }

      // Auto-stop at 45s
      if (elapsed >= 45) {
        stopRecording();
      }
    }, 100);
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;

    const elapsed = (Date.now() - recordStartTime) / 1000;
    if (elapsed < 30) {
      showError(`Recording too short (${elapsed.toFixed(1)}s). Please record at least 30 seconds.`);
      return;
    }

    mediaRecorder.stop();
    clearInterval(recordTimerInterval);

    btnRecord.disabled = false;
    btnRecord.classList.remove("recording");
    btnStopRecord.disabled = true;
    recordHint.textContent = "Record between 30 and 45 seconds";
    recordHint.style.color = "";

    cancelAnimationFrame(animFrameId);
  }

  function cleanupRecording() {
    if (audioStream) {
      audioStream.getTracks().forEach((t) => t.stop());
      audioStream = null;
    }
  }

  function setupVisualizer(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 128;
    source.connect(analyserNode);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const ctx = vizCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    vizCanvas.width = vizCanvas.clientWidth * dpr;
    vizCanvas.height = vizCanvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const w = vizCanvas.clientWidth;
    const h = vizCanvas.clientHeight;

    function draw() {
      if (!mediaRecorder || mediaRecorder.state !== "recording") return;
      animFrameId = requestAnimationFrame(draw);

      analyserNode.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, w, h);

      const barW = w / bufferLength;
      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i] / 255;
        const barH = val * h * 0.9;
        const hue = 260 + i * (60 / bufferLength);
        ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${0.6 + val * 0.4})`;
        ctx.fillRect(i * barW, h - barH, barW - 1, barH);
      }
    }
    draw();
  }

  // ── Analyze ───────────────────────────────────────────────
  btnAnalyze.addEventListener("click", analyzeAudio);

  async function analyzeAudio() {
    if (!audioFile || !consentCheckbox.checked) return;

    hideError();
    uploadSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");

    // Animate loading steps
    const steps = $$(".loading-step");
    const messages = [
      "Uploading audio…",
      "Transcribing speech with Whisper…",
      "Analyzing pronunciation…",
      "Generating your score…",
    ];

    let stepIdx = 0;
    const stepInterval = setInterval(() => {
      if (stepIdx < steps.length) {
        if (stepIdx > 0) steps[stepIdx - 1].classList.replace("active", "done");
        steps[stepIdx].classList.add("active");
        loadingText.textContent = messages[stepIdx] || messages[0];
        stepIdx++;
      }
    }, 3000);

    const formData = new FormData();
    formData.append("audio", audioFile);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "x-consent": "true" },
        body: formData,
      });

      clearInterval(stepInterval);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Server error (${response.status})`);
      }

      const data = await response.json();

      if (!data.success || !data.result) {
        throw new Error(data.error || "Analysis returned no result.");
      }

      showResults(data.result);
    } catch (err) {
      clearInterval(stepInterval);
      loadingSection.classList.add("hidden");
      uploadSection.classList.remove("hidden");
      showError(err.message);
    }
  }

  // ── Results ───────────────────────────────────────────────
  function showResults(result) {
    loadingSection.classList.add("hidden");
    resultsSection.classList.remove("hidden");

    // Animate scores
    animateScore("score-pronunciation", result.overall_score);
    animateScore("score-fluency", result.fluency_score);
    animateScore("score-clarity", result.clarity_score);

    // Words
    renderWords(result.words);

    // Summary
    $("#summary-text").textContent = result.summary;
    renderFeedbackList("strengths-list", result.strengths);
    renderFeedbackList("improvements-list", result.improvements);

    // Scroll to results
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function animateScore(cardId, target) {
    const card = $(`#${cardId}`);
    const valueEl = card.querySelector(".score-value");
    const ringFill = card.querySelector(".ring-fill");
    const circumference = 2 * Math.PI * 50; // r = 50

    // Color based on score
    let color;
    if (target >= 80) color = "#10b981";
    else if (target >= 60) color = "#f59e0b";
    else color = "#ef4444";

    ringFill.style.stroke = color;

    // Animate ring (after a tiny delay to trigger CSS transition)
    requestAnimationFrame(() => {
      ringFill.style.strokeDashoffset =
        circumference * (1 - target / 100);
    });

    // Count up
    let current = 0;
    const step = target / 50; // ~50 steps over ~800ms
    const counter = setInterval(() => {
      current += step;
      if (current >= target) {
        current = target;
        clearInterval(counter);
      }
      valueEl.textContent = Math.round(current);
    }, 16);
  }

  function renderWords(words) {
    const container = $("#word-analysis");
    container.innerHTML = "";

    words.forEach((word, idx) => {
      const chip = document.createElement("span");
      chip.className = `word-chip ${word.status}`;
      chip.textContent = word.word;
      chip.style.animationDelay = `${idx * 40}ms`;

      if (word.status !== "correct") {
        chip.addEventListener("click", () => showWordDetail(word));
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        chip.addEventListener("keydown", (e) => {
          if (e.key === "Enter") showWordDetail(word);
        });
      }

      container.appendChild(chip);
    });
  }

  function showWordDetail(word) {
    const card = $("#word-detail");
    const wordEl = $("#detail-word");
    const badge = $("#detail-status-badge");
    const content = $("#detail-content");

    wordEl.textContent = `"${word.word}"`;
    wordEl.className = `detail-word ${word.status}`;

    badge.textContent = word.status === "mispronounced" ? "Mispronounced" : "Unclear";
    badge.className = `detail-status-badge ${word.status}`;

    let html = "";
    if (word.feedback) {
      html += `<p>${escapeHtml(word.feedback)}</p>`;
    }
    if (word.expected_ipa) {
      html += `<p class="detail-ipa">Correct pronunciation: <strong>/${escapeHtml(word.expected_ipa)}/</strong></p>`;
    }
    if (!word.feedback && !word.expected_ipa) {
      html += `<p>This word could use improvement. Try speaking it more slowly and clearly.</p>`;
    }

    content.innerHTML = html;
    card.classList.remove("hidden");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderFeedbackList(listId, items) {
    const list = $(`#${listId}`);
    list.innerHTML = "";
    (items || []).forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });
  }

  // ── Try Again ─────────────────────────────────────────────
  btnRetry.addEventListener("click", () => {
    resultsSection.classList.add("hidden");
    uploadSection.classList.remove("hidden");

    // Reset state
    audioFile = null;
    audioDuration = 0;
    audioPreview.classList.add("hidden");
    audioPlayer.src = "";
    fileInput.value = "";
    consentCheckbox.checked = false;
    updateAnalyzeButton();

    // Reset word detail
    $("#word-detail").classList.add("hidden");

    // Reset score rings
    $$(".ring-fill").forEach((r) => {
      r.style.strokeDashoffset = 2 * Math.PI * 50;
    });
    $$(".score-value").forEach((v) => (v.textContent = "0"));

    // Reset timer
    recordTimerEl.textContent = "00:00";

    uploadSection.scrollIntoView({ behavior: "smooth" });
  });

  // ── Error helpers ─────────────────────────────────────────
  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove("hidden");
  }

  function hideError() {
    errorBanner.classList.add("hidden");
  }

  // ── Utilities ─────────────────────────────────────────────
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
