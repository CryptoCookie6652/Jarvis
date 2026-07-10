// Free voice tier: Web Speech API for recognition, speechSynthesis for speech.
// Half-duplex by default — recognition is gated off while Jarvis speaks, so
// speakers can't make it hear itself. Headphones mode keeps the mic hot during
// playback, which enables true voice barge-in. Esc always interrupts.

export function initVoice({ send }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const els = {
    mic: document.getElementById('mic-toggle'),
    mute: document.getElementById('mute-toggle'),
    headphones: document.getElementById('headphones-mode'),
    voiceSel: document.getElementById('voice-select'),
    lang: document.getElementById('voice-lang'),
    rate: document.getElementById('voice-rate'),
    status: document.getElementById('voice-status'),
    hearing: document.getElementById('voice-hearing'),
  };

  if (!SR || !('speechSynthesis' in window)) {
    els.status.textContent = 'voice not supported in this browser';
    return { speak() {}, stopSpeaking() {}, setThinking() {} };
  }

  const state = {
    micOn: false,
    muted: false,
    thinking: false,
    speaking: false,
    queue: [], // utterances buffered while the conductor is busy
    speakQueue: [], // sentences waiting for TTS
  };

  // --- chime (WebAudio, no assets) ---
  let audioCtx = null;
  function playChime() {
    try {
      audioCtx ??= new AudioContext();
      const t0 = audioCtx.currentTime;
      for (const [freq, at] of [[880, 0], [1174.66, 0.14]]) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, t0 + at);
        gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.25);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.3);
      }
    } catch {
      /* audio blocked until first gesture; fine */
    }
  }

  // --- recognition ---
  let rec = null;
  let recActive = false;

  function startRec() {
    if (!state.micOn || recActive) return;
    if (state.speaking && !els.headphones.checked) return;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = els.lang.value;
    rec.onresult = onResult;
    rec.onerror = () => {}; // no-speech etc: onend restarts us
    rec.onend = () => {
      recActive = false;
      setTimeout(startRec, 250);
    };
    try {
      rec.start();
      recActive = true;
    } catch {
      recActive = false;
    }
    setStatus();
  }

  function stopRec() {
    if (!rec) return;
    rec.onend = null;
    try {
      rec.abort();
    } catch {}
    rec = null;
    recActive = false;
  }

  function onResult(event) {
    let interim = '';
    let finals = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finals += result[0].transcript;
      else interim += result[0].transcript;
    }
    // Voice barge-in: any speech while Jarvis talks cuts it off. Only reachable
    // in headphones mode — on speakers the mic is already gated during playback.
    if (state.speaking && (interim.trim() || finals.trim())) stopSpeaking();
    els.hearing.textContent = interim ? `… ${interim}` : '';
    if (finals.trim()) handleUtterance(finals.trim());
  }

  function handleUtterance(text) {
    els.hearing.textContent = '';
    if (state.thinking) {
      state.queue.push(text);
      setStatus();
    } else {
      send(text);
    }
  }

  // --- speech synthesis ---
  let voices = [];
  function loadVoices() {
    voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    const saved = localStorage.getItem('jarvis-voice');
    els.voiceSel.innerHTML = voices
      .map((v) => `<option${v.name === saved ? ' selected' : ''}>${v.name}</option>`)
      .join('');
    if (!saved) {
      const best =
        voices.find((v) => v.lang.startsWith('en') && /natural|neural/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('en') && /google/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('en'));
      if (best) els.voiceSel.value = best.name;
    }
  }
  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();

  function speak(text, opts = {}) {
    if (state.muted || !text) return;
    // Politeness: if the user is mid-utterance, hold the announcement briefly.
    if (els.hearing.textContent && (opts._defer ?? 0) < 5) {
      setTimeout(() => speak(text, { ...opts, _defer: (opts._defer ?? 0) + 1 }), 1200);
      return;
    }
    if (opts.chime) playChime();
    const parts = (text.match(/[^.!?\n]+[.!?]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    state.speakQueue.push(...parts);
    if (!state.speaking) pumpSpeech();
  }

  function pumpSpeech() {
    const next = state.speakQueue.shift();
    if (next == null) {
      state.speaking = false;
      setStatus();
      if (state.micOn && !recActive) startRec();
      return;
    }
    state.speaking = true;
    if (!els.headphones.checked) stopRec();
    setStatus();
    const utter = new SpeechSynthesisUtterance(next);
    const chosen = voices.find((v) => v.name === els.voiceSel.value);
    if (chosen) utter.voice = chosen;
    utter.rate = Number(els.rate.value) || 1;
    utter.onend = pumpSpeech;
    utter.onerror = pumpSpeech;
    speechSynthesis.speak(utter);
  }

  function stopSpeaking() {
    state.speakQueue.length = 0;
    speechSynthesis.cancel();
    // onend/onerror fire after cancel and find an empty queue → clean finish.
  }

  // Chrome pauses long utterances; periodic resume() is the standard fix.
  setInterval(() => {
    if (state.speaking) speechSynthesis.resume();
  }, 5000);

  function setThinking(on) {
    state.thinking = on;
    if (!on && state.queue.length) {
      send(state.queue.splice(0).join(' '));
      state.thinking = true; // send() flips status via SSE; stay honest meanwhile
    }
    setStatus();
  }

  function setStatus() {
    els.status.textContent = !state.micOn
      ? 'mic off'
      : state.speaking
        ? 'speaking — Esc interrupts'
        : state.thinking
          ? state.queue.length
            ? `thinking… (${state.queue.length} queued)`
            : 'thinking…'
          : 'listening';
  }

  // --- UI wiring ---
  els.mic.addEventListener('click', () => {
    state.micOn = !state.micOn;
    els.mic.classList.toggle('on', state.micOn);
    els.mic.textContent = state.micOn ? '🎙 on' : '🎙 off';
    if (state.micOn) {
      playChime(); // doubles as AudioContext unlock on a user gesture
      startRec();
    } else {
      stopRec();
    }
    setStatus();
  });

  els.mute.addEventListener('click', () => {
    state.muted = !state.muted;
    els.mute.textContent = state.muted ? '🔇' : '🔊';
    if (state.muted) stopSpeaking();
  });

  els.voiceSel.addEventListener('change', () =>
    localStorage.setItem('jarvis-voice', els.voiceSel.value),
  );
  els.lang.addEventListener('change', () => {
    localStorage.setItem('jarvis-lang', els.lang.value);
    stopRec();
    startRec();
  });
  const savedLang = localStorage.getItem('jarvis-lang');
  if (savedLang) els.lang.value = savedLang;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopSpeaking();
  });

  return { speak, stopSpeaking, setThinking };
}
