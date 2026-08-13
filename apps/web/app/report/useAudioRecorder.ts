'use client';

import { MAX_AUDIO_SECONDS } from '@dispatch/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopped' | 'unsupported' | 'denied';

interface Recording {
  base64: string;
  mimeType: string;
  durationSeconds: number;
  /** Para que la persona pueda escucharse antes de enviar. */
  objectUrl: string;
}

/**
 * Grabacion de voz para el reporte ciudadano.
 *
 * Decisiones que importan en la calle, no en el escritorio:
 *
 * - Corta sola a los 60s. Alguien nervioso puede olvidar soltar el boton, y un
 *   audio de 5 minutos retrasa el despacho sin aportar nada.
 * - Expone un nivel de volumen en vivo. Sin feedback visual la gente no sabe si
 *   el microfono la esta captando y repite el reporte.
 * - Si el navegador no soporta MediaRecorder o niegan el permiso, lo dice
 *   explicitamente para que la UI ofrezca el camino con botones. Nunca se
 *   queda en un estado ambiguo: en una emergencia eso cuesta minutos.
 */
export function useAudioRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioContextRef.current?.close().catch(() => { /* ya cerrado */ });
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia
        || typeof MediaRecorder === 'undefined') {
      setState('unsupported');
      return;
    }

    setState('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,   // la calle es ruidosa y la gente se aleja del micro
        },
      });
    } catch {
      setState('denied');
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    // opus es el mejor ratio calidad/peso y es lo que aceptan los motores de
    // transcripcion; Safari solo da mp4, asi que se prueba en orden.
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = async () => {
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      const buffer = await blob.arrayBuffer();

      let binary = '';
      const bytes = new Uint8Array(buffer);
      // En trozos: String.fromCharCode con cientos de miles de argumentos
      // desborda la pila en móviles.
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }

      setRecording({
        base64: btoa(binary),
        mimeType: type.split(';')[0] ?? 'audio/webm',
        durationSeconds: Math.min(MAX_AUDIO_SECONDS, (Date.now() - startedAtRef.current) / 1000),
        objectUrl: URL.createObjectURL(blob),
      });
      setState('stopped');
      cleanup();
    };

    // Medidor de volumen: prueba visible de que el micrófono está captando.
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
        setLevel(Math.min(1, peak / 90));
        setSeconds((Date.now() - startedAtRef.current) / 1000);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Sin medidor se puede grabar igual; no es motivo para fallar.
    }

    startedAtRef.current = Date.now();
    recorder.start();
    setSeconds(0);
    setState('recording');

    // Corte duro de seguridad.
    window.setTimeout(() => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    }, MAX_AUDIO_SECONDS * 1000);
  }, [cleanup]);

  const reset = useCallback(() => {
    if (recording) URL.revokeObjectURL(recording.objectUrl);
    setRecording(null);
    setSeconds(0);
    setLevel(0);
    setState('idle');
  }, [recording]);

  return { state, seconds, level, recording, start, stop, reset };
}
