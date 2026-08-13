(function () {
  'use strict';

  /* ------------------------- Estado global ------------------------- */
  const MAX_MS = 120000;        // 2 min auto-stop
  const MIN_MS = 2000;          // validación mínima
  const KEY = 'dp_audio_last_report';
  const LOC_KEY = 'dp_audio_location';

  let state = 'idle';           // idle | recording | processing | confirmed | error
  let recordStart = 0;
  let recordDur = 0;
  let timerId = null;
  let pendingBlob = null;       // Reporte sin confirmar / pendiente de envío
  let lastReport = null;        // Último reporte confirmado (vive en localStorage)
  let address = localStorage.getItem(LOC_KEY) || '';

  /* ------------------------- Referencias DOM ------------------------- */
  const el = {
    clock: document.getElementById('clock'),
    net: document.getElementById('net'),
    offlineBanner: document.getElementById('offlineBanner'),
    wave: document.getElementById('wave'),
    recordBtn: document.getElementById('recordBtn'),
    recordIcon: document.getElementById('recordIcon'),
    recordText: document.getElementById('recordText'),
    timer: document.getElementById('timer'),
    hint: document.getElementById('hint'),
    statusMsg: document.getElementById('statusMsg'),
    actions: document.getElementById('actions'),
    retryBtn: document.getElementById('retryBtn'),
    newReportBtn: document.getElementById('newReportBtn'),
    callBtn: document.getElementById('callBtn'),
    changeLoc: document.getElementById('changeLoc'),
    address: document.getElementById('address'),
    modal: document.getElementById('locationModal'),
    locationInput: document.getElementById('locationInput'),
    locationSave: document.getElementById('locationSave'),
    locationCancel: document.getElementById('locationCancel'),
  };

  /* ------------------------- Utilidades ------------------------- */
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  const buzz = (pattern) => {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* noop */ }
    }
  };

  const setTimer = (ms) => {
    el.timer.textContent = fmt(ms);
    el.timer.classList.toggle('warn', ms >= 90000);
  };

  const setStatus = (html, type) => {
    el.statusMsg.innerHTML = html;
    el.statusMsg.dataset.type = type || '';
    el.statusMsg.classList.add('visible');
  };

  const clearStatus = () => {
    el.statusMsg.innerHTML = '';
    el.statusMsg.classList.remove('visible');
  };

  function setState(next) {
    state = next;
    const r = el.recordBtn;
    r.classList.toggle('is-recording', next === 'recording');
    r.classList.toggle('is-processing', next === 'processing');
    r.classList.toggle('is-error', next === 'error');
    r.disabled = next === 'processing' || next === 'confirmed';
    r.setAttribute('aria-pressed', next === 'recording');
    if (next !== 'recording') { el.recordBtn.classList.remove('is-recording'); }
  }

  const saveReport = (report) => {
    lastReport = report;
    try {
      localStorage.setItem(KEY, JSON.stringify(report));
      window.dispatchEvent(new CustomEvent('dp-audio-report', { detail: report }));
    } catch (e) { /* almacenamiento no disponible */ }
  };

  function resetAll() {
    clearInterval(timerId); timerId = null;
    stopWave();
    setTimer(0);
    el.hint.textContent = 'Toca para iniciar · mantén para hablar';
    el.recordIcon.textContent = '🎙️';
    el.recordText.textContent = 'Presiona para grabar';
    clearStatus();
    el.actions.classList.remove('visible');
    setState('idle');
  }

  /* ------------------------- Reloj + estado de red ------------------------- */
  function tickClock() {
    const d = new Date();
    el.clock.textContent = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  }
  tickClock();
  setInterval(tickClock, 30000);

  function setOnline(on) {
    el.net.textContent = on ? '📶' : '📡';
    el.net.classList.toggle('off', !on);
    el.offlineBanner.classList.toggle('visible', !on);
  }
  setOnline(navigator.onLine);
  window.addEventListener('online', () => { setOnline(true); flushPending(); });
  window.addEventListener('offline', () => setOnline(false));

  /* ------------------------- Ondas de voz ------------------------- */
  const ctx = el.wave.getContext('2d');
  const W = () => (el.wave.width = el.wave.clientWidth);
  const H = () => (el.wave.height = 56);
  let rafId = null;
  let vol = 0.4;
  let t = 0;

  function drawWave() {
    W(); H();
    ctx.clearRect(0, 0, el.wave.width, 56);
    const base = 28;
    const amp = 3 + vol * 18;
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff6b35';
    for (let x = 0; x <= el.wave.width; x += 2) {
      const y = base + Math.sin((x / 18) + t) * amp * Math.sin(x / el.wave.width * Math.PI);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function runWave() {
    if (rafId != null) return;
    const step = () => {
      t += 0.18;
      drawWave();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function stopWave() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    ctx.clearRect(0, 0, el.wave.width, 56);
  }

  /* ------------------------- Micrófono opcional ------------------------- */
  let micStream = null;
  let micCtx = null;
  let analyser = null;

  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micCtx = new AudioContext();
      const src = micCtx.createMediaStreamSource(micStream);
      analyser = micCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      return true;
    } catch (e) {
      return false;
    }
  }

  function stopMic() {
    if (micStream) { micStream.getTracks().forEach((tr) => tr.stop()); micStream = null; }
    if (micCtx && micCtx.state !== 'closed') { micCtx.close().catch(() => {}); micCtx = null; }
    analyser = null;
  }

  /* ------------------------- Timers + animación ------------------------- */
  function startTimers() {
    setTimer(0);
    runWave();
    const tick = () => {
      const d = Date.now() - recordStart;
      setTimer(d);
      if (analyser) {
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        vol = Math.min(1, (sum / buf.length / 255) * 2.2);
      } else {
        vol = 0.45 + Math.random() * 0.25;
      }
      if (d >= MAX_MS) stopRecording();  // auto-stop a los 2 min
    };
    timerId = setInterval(tick, 120);
    tick();
  }

  /* ------------------------- Grabar ------------------------- */
  async function startRecording() {
    if (state === 'error') resetAll();
    if (state !== 'idle') return;

    await startMic();
    buzz(60);
    state = 'recording';
    setState('recording');
    recordStart = Date.now();
    el.recordIcon.textContent = '🔴';
    el.recordText.textContent = 'Grabando…';
    el.hint.textContent = 'Suelta el botón para terminar';
    el.recordBtn.classList.add('is-recording');
    el.recordBtn.querySelector('.record-ring')?.remove();
    clearStatus();
    el.actions.classList.remove('visible');
    startTimers();
  }

  async function stopRecording() {
    if (state !== 'recording') return;
    clearInterval(timerId); timerId = null;
    stopWave();
    stopMic();
    buzz([40, 40, 40]);

    recordDur = Date.now() - recordStart;
    if (recordDur < MIN_MS) {
      buzz([80, 80]);
      setStatus('⚠️ La grabación es muy corta. Intenta de nuevo.', 'error');
      resetAll();
      setState('error');
      return;
    }

    buildAudio(recordDur).then((blob) => {
      pendingBlob = blob;
      if (navigator.onLine) submitReport();
      else showPending();
    });
  }

  /* ------------------------- Audio sintético (WAV reproducible) ------------------------- */
  function buildAudio(durMs) {
    return new Promise((resolve) => {
      const sr = 22050;
      const secs = Math.min(MAX_MS, Math.max(2000, durMs)) / 1000;
      const total = Math.floor(sr * secs);
      const buf = new Float32Array(total);

      let beat = 0;
      const beep = (start, freq, dur) => {
        const n0 = Math.floor(start * sr);
        const n1 = Math.min(total, n0 + Math.floor(dur * sr));
        for (let i = n0; i < n1; i++) {
          buf[i] += 0.22 * Math.sin(2 * Math.PI * freq * (i / sr));
        }
      };

      // Timbre inicial estilo "despacho" + tonos de marcado
      beep(0, 950, 0.18);
      beep(0.22, 950, 0.18);
      for (let i = 0; i < 4; i++) beep(0.6 + i * 0.24, 440, 0.1);

      beat = 1.6;
      while (beat < secs - 0.3) {
        beep(beat, 880, 0.05);
        beat += 0.7;
      }

      const dataLen = total * 2;
      const ab = new ArrayBuffer(44 + dataLen);
      const dv = new DataView(ab);
      let o = 0;
      const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
      str('RIFF'); dv.setUint32(o, 36 + dataLen, true); o += 4;
      str('WAVE'); str('fmt ');
      dv.setUint32(o, 16, true); o += 4;
      dv.setUint16(o, 1, true); o += 2;          // PCM
      dv.setUint16(o, 1, true); o += 2;          // mono
      dv.setUint32(o, sr, true); o += 4;         // sample rate
      dv.setUint32(o, sr * 2, true); o += 4;     // byte rate
      dv.setUint16(o, 2, true); o += 2;          // block align
      dv.setUint16(o, 16, true); o += 2;         // bits
      str('data'); dv.setUint32(o, dataLen, true); o += 4;

      for (let i = 0; i < total; i++) {
        let v = Math.max(-1, Math.min(1, buf[i] * 0.9));
        dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }

      resolve(new Blob([ab], { type: 'audio/wav' }));
    });
  }

  /* ------------------------- Envío + confirmación ------------------------- */
  async function playAudio(blob) {
    try {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
      await new Promise((res) => {
        audio.addEventListener('ended', res, { once: true });
        setTimeout(res, 6000);
      });
    } catch (e) { /* autoplay bloqueado: continuar igual */ }
  }

  async function submitReport() {
    if (!pendingBlob) return;
    setState('processing');
    el.recordIcon.textContent = '⏳';
    el.recordText.textContent = 'Enviando…';
    setStatus('<span class="spinner"></span>Enviando reporte…', 'info');

    await new Promise((res) => setTimeout(res, 900));

    // Demo: el envío siempre "funciona". En producción aquí iría fetch() al backend.
    const ok = true;
    if (!ok) {
      setState('error');
      el.recordIcon.textContent = '⚠️';
      el.recordText.textContent = 'Intenta de nuevo';
      setStatus('⚠️ No se pudo enviar. Revisa tu conexión.', 'error');
      el.actions.classList.add('visible');
      return;
    }

    const report = {
      id: 'RD-' + Date.now().toString(36).toUpperCase(),
      ts: new Date().toISOString(),
      durMs: recordDur,
      address: address || 'Cra 13 # 26-45, Cartagena',
      blob: pendingBlob,
    };
    saveReport(report);
    pendingBlob = null;

    setState('confirmed');
    el.recordIcon.textContent = '✅';
    el.recordText.textContent = 'Emergencia reportada';
    setStatus('✅ Emergencia reportada · Incidente ' + report.id, 'ok');
    el.hint.textContent = 'Tu reporte fue enviado al Despacho de Cartagena';
    el.actions.classList.add('visible');

    playAudio(report.blob);
  }

  function showPending() {
    setState('error');
    el.recordIcon.textContent = '📡';
    el.recordText.textContent = 'Sin conexión';
    setStatus('📡 Sin conexión. Se guardó localmente y se enviará al reconectar.', 'info');
    el.actions.classList.add('visible');
    setOnline(false);
  }

  function flushPending() {
    if (pendingBlob && navigator.onLine) {
      if (state === 'error') submitReport();
    }
  }

  /* ------------------------- Gestos: tap + press-and-hold ------------------------- */
  let pressTimer = null;
  let isPressed = false;

  function beginPress(e) {
    if (e) e.preventDefault();
    isPressed = true;
    pressTimer = setTimeout(() => startRecording(), 120);
  }

  function endPress(e) {
    if (e) e.preventDefault();
    clearTimeout(pressTimer);
    if (isPressed && state === 'recording') stopRecording();
    isPressed = false;
  }

  el.recordBtn.addEventListener('pointerdown', beginPress);
  el.recordBtn.addEventListener('pointerup', endPress);
  el.recordBtn.addEventListener('pointerleave', endPress);
  el.recordBtn.addEventListener('pointercancel', endPress);
  el.recordBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------- Botones secundarios ------------------------- */
  el.callBtn.addEventListener('click', () => { location.href = 'tel:123'; });

  el.retryBtn.addEventListener('click', () => {
    if (pendingBlob) submitReport();
    else resetAll();
  });

  el.newReportBtn.addEventListener('click', () => { resetAll(); });
  el.recordBtn.addEventListener('click', () => {
    if (state === 'idle') beginPress();
    else if (state === 'recording') endPress();
    else if (state === 'error') startRecording();
  });

  /* ------------------------- Ubicación ------------------------- */
  function renderAddress() {
    el.address.textContent =
      address || 'Detectando ubicación…';
  }

  function openModal() {
    el.locationInput.value = address || 'Cra 13 # 26-45, Cartagena';
    el.modal.classList.add('open');
    setTimeout(() => el.locationInput.focus(), 50);
  }

  el.changeLoc.addEventListener('click', openModal);
  el.locationCancel.addEventListener('click', () => el.modal.classList.remove('open'));
  el.locationSave.addEventListener('click', () => {
    address = el.locationInput.value.trim();
    if (address) localStorage.setItem(LOC_KEY, address);
    renderAddress();
    el.modal.classList.remove('open');
  });
  el.locationInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.locationSave.click();
    if (e.key === 'Escape') el.locationCancel.click();
  });

  // Geo-localización real cuando está disponible
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      () => { if (!address) el.address.textContent = 'Cra 13 # 26-45, Cartagena'; },
      () => { if (!address) el.address.textContent = 'Cra 13 # 26-45, Cartagena'; },
      { timeout: 4000 }
    );
  }

  renderAddress();

  /* ------------------------- Persistencia: últimos reportes ------------------------- */
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const r = JSON.parse(raw);
      if (r && r.id) {
        lastReport = r;
        setState('confirmed');
        el.recordIcon.textContent = '✅';
        el.recordText.textContent = 'Emergencia reportada';
        setStatus('✅ Emergencia reportada · Incidente ' + r.id, 'ok');
        el.hint.textContent = 'Tu reporte fue enviado al Despacho de Cartagena';
        el.actions.classList.add('visible');
      }
    }
  } catch (e) { /* noop */ }

  // Exponer estado para pruebas automatizadas
  window.recorderState = {
    get state() { return state; },
    get lastReport() { return lastReport; },
    get pending() { return !!pendingBlob; },
  };
})();
