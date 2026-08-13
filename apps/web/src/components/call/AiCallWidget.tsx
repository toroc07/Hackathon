'use client';

/**
 * "Llamada" con la IA — orientación de primeros auxilios en vivo mientras
 * espera la ambulancia. Habla contra el audio-service (servicio aparte,
 * NEXT_PUBLIC_AUDIO_SERVICE_URL), no contra esta app: no crea ni modifica
 * incidentes, eso lo sigue haciendo POST /api/incidents/audio.
 *
 * Detección de voz automática (VAD): nada de botones de grabar/detener por
 * turno, se siente como hablar con alguien. Mismo mecanismo que
 * backend/public/test.html, adaptado a los tokens de diseño de la app.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertIcon, PhoneIcon, PhoneOffIcon } from '@/src/components/ui/icons';

const AUDIO_SERVICE_URL = process.env.NEXT_PUBLIC_AUDIO_SERVICE_URL ?? '';
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 300;
const MAX_TURN_MS = 20_000;

type CallState = 'idle' | 'listening' | 'recording' | 'processing' | 'speaking' | 'unavailable';

interface Turn { role: 'user' | 'assistant'; content: string }

interface ConverseResponse {
  transcript: string;
  reply: string;
  detectedTypes: string[];
  replyAudioBase64: string | null;
  replyAudioMimeType: string | null;
  history: Turn[];
}

const STATUS_LABEL: Partial<Record<CallState, string>> = {
  listening: 'Escuchando…',
  recording: 'Te estoy escuchando…',
  processing: 'Pensando…',
  speaking: 'Hablando…',
};

export function AiCallWidget() {
  const [state, setState] = useState<CallState>(AUDIO_SERVICE_URL ? 'idle' : 'unavailable');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const historyRef = useRef<Turn[]>([]);
  const stateRef = useRef<CallState>(state);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const speechStartedAtRef = useRef(0);
  const lastLoudAtRef = useRef(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const setCallState = (next: CallState) => { stateRef.current = next; setState(next); };

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  useEffect(() => () => { endCall(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  function currentVolume(): number {
    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;
    if (!analyser || !dataArray) return 0;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (const v of dataArray) { const norm = (v - 128) / 128; sum += norm * norm; }
    return Math.sqrt(sum / dataArray.length);
  }

  function startRecorder() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.start();
    mediaRecorderRef.current = recorder;
  }

  async function stopRecorderAndSend() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });
    setCallState('processing');

    const form = new FormData();
    form.append('audio', blob, 'turno.webm');
    form.append('history', JSON.stringify(historyRef.current));
    try {
      const res = await fetch(`${AUDIO_SERVICE_URL}/api/incidents/converse`, { method: 'POST', body: form });
      const json = (await res.json()) as ConverseResponse & { error?: { message?: string } };
      if (stateRef.current === 'idle') return; // colgaron mientras esperábamos
      if (!res.ok) {
        setErrorMsg(json.error?.message ?? `Error del servicio (${res.status})`);
        setCallState('listening');
        return;
      }
      historyRef.current = json.history;
      setTurns((prev) => [...prev, { role: 'user', content: json.transcript }, { role: 'assistant', content: json.reply }]);

      if (json.replyAudioBase64 && audioElRef.current) {
        setCallState('speaking');
        const audioEl = audioElRef.current;
        audioEl.src = `data:${json.replyAudioMimeType || 'audio/wav'};base64,${json.replyAudioBase64}`;
        audioEl.onended = () => { if (stateRef.current !== 'idle') setCallState('listening'); };
        audioEl.play().catch(() => { if (stateRef.current !== 'idle') setCallState('listening'); });
      } else if ('speechSynthesis' in window) {
        setCallState('speaking');
        const utterance = new SpeechSynthesisUtterance(json.reply);
        utterance.lang = 'es-ES';
        utterance.onend = () => { if (stateRef.current !== 'idle') setCallState('listening'); };
        utterance.onerror = () => { if (stateRef.current !== 'idle') setCallState('listening'); };
        speechSynthesis.speak(utterance);
      } else {
        setCallState('listening');
      }
    } catch {
      if (stateRef.current !== 'idle') {
        setErrorMsg('Sin conexión con el servicio de llamada.');
        setCallState('listening');
      }
    }
  }

  function pollVolume() {
    pollTimerRef.current = window.setInterval(() => {
      const current = stateRef.current;
      if (current !== 'listening' && current !== 'recording') return;
      const level = currentVolume();
      const threshold = 0.02;
      const now = Date.now();

      if (level > threshold) {
        lastLoudAtRef.current = now;
        if (current === 'listening') {
          speechStartedAtRef.current = now;
          startRecorder();
          setCallState('recording');
        }
      }
      if (current === 'recording') {
        const silentFor = now - lastLoudAtRef.current;
        const spokeFor = now - speechStartedAtRef.current;
        if ((silentFor > SILENCE_MS && spokeFor > MIN_SPEECH_MS) || spokeFor > MAX_TURN_MS) {
          void stopRecorderAndSend();
        }
      }
    }, 100);
  }

  async function startCall() {
    setErrorMsg(null);
    setTurns([]);
    historyRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataArrayRef.current = new Uint8Array(analyser.fftSize);

      setCallState('listening');
      pollVolume();
    } catch {
      setErrorMsg('No pudimos acceder al micrófono.');
    }
  }

  function endCall() {
    setCallState('idle');
    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close();
    audioElRef.current?.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    streamRef.current = null;
    audioCtxRef.current = null;
  }

  if (state === 'unavailable') return null;

  return (
    <div className="rounded-md bg-surface-raised ring-1 ring-edge-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-semibold text-[15px]">Orientación por voz</p>
          <p className="text-[13px] text-content-secondary">
            {state === 'idle' ? 'Habla con la IA mientras esperas la ambulancia.' : STATUS_LABEL[state]}
          </p>
        </div>
        {state === 'idle' ? (
          <button
            type="button"
            onClick={() => void startCall()}
            aria-label="Iniciar llamada con la IA"
            className="pressable shrink-0 rounded-full bg-ok hover:brightness-110 text-white
                       flex items-center justify-center"
            style={{ width: 'var(--touch-comfort)', height: 'var(--touch-comfort)' }}
          >
            <PhoneIcon size={22} />
          </button>
        ) : (
          <button
            type="button"
            onClick={endCall}
            aria-label="Colgar"
            className="pressable shrink-0 rounded-full bg-emergency hover:bg-emergency-hover text-white
                       flex items-center justify-center"
            style={{ width: 'var(--touch-comfort)', height: 'var(--touch-comfort)' }}
          >
            <PhoneOffIcon size={22} />
          </button>
        )}
      </div>

      {errorMsg && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-emergency text-[13px]">
          <AlertIcon size={16} /> <span>{errorMsg}</span>
        </p>
      )}

      {turns.length > 0 && (
        <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
          {turns.map((turn, i) => (
            <p
              key={i}
              className={[
                'max-w-[85%] rounded-md px-3 py-2 text-[13px] leading-snug',
                turn.role === 'user'
                  ? 'self-end bg-info-soft text-content'
                  : 'self-start bg-surface-overlay text-content-secondary',
              ].join(' ')}
            >
              {turn.content}
            </p>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioElRef} className="hidden" />
    </div>
  );
}
