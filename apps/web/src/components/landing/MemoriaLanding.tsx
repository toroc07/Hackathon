'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type PlayerStatus = 'standby' | 'recording' | 'recPaused' | 'stopped' | 'review' | 'paused';

interface Recording {
  id: string;
  type: string;
  date: Date;
  duration: number;
  status: 'revision' | 'detenida' | 'archivada';
  location: string;
  notes: string;
}

interface Mark {
  t: number;
  at: Date;
}

interface AuditEntry {
  t: Date;
  action: string;
  rec?: string;
}

const NAV = [
  { href: '#hero', label: 'Inicio' },
  { href: '#demo', label: 'Reproductor' },
  { href: '#why', label: 'Por qué importa' },
  { href: '#estados', label: 'Estados' },
  { href: '#tecnica', label: 'Técnica' },
];

const SEED_RECORDINGS: Recording[] = [
  { id: 'INC-2026-001', type: 'Médica', date: new Date(Date.now() - 4 * 3600e3), duration: 96, status: 'revision', location: 'Av. del Lago 45', notes: 'Dolor torácico, U-07 en camino.' },
  { id: 'INC-2026-002', type: 'Trauma', date: new Date(Date.now() - 9 * 3600e3), duration: 142, status: 'detenida', location: 'Carrera 5 # 12-30', notes: '' },
  { id: 'INC-2026-003', type: 'Incendio', date: new Date(Date.now() - 26 * 3600e3), duration: 77, status: 'archivada', location: 'Zona portuaria', notes: 'Retenida por incumplimiento normativo.' },
  { id: 'INC-2026-004', type: 'Seguridad', date: new Date(Date.now() - 31 * 3600e3), duration: 203, status: 'archivada', location: 'Centro', notes: '' },
  { id: 'INC-2026-005', type: 'Médica', date: new Date(Date.now() - 48 * 3600e3), duration: 58, status: 'archivada', location: 'Manga', notes: '' },
  { id: 'INC-2026-006', type: 'Otro', date: new Date(Date.now() - 72 * 3600e3), duration: 119, status: 'archivada', location: 'Bocagrande', notes: '' },
];

const STATUS_LBL: Record<string, string> = {
  recording: 'Activa',
  recPaused: 'Pausada',
  detenida: 'Detenida',
  revision: 'En revisión',
  archivada: 'Archivada',
};

const STATUS_CHIP: Record<string, string> = {
  activa: 'border-dispatch-rec/40 text-dispatch-rec',
  pausada: 'border-dispatch-amber/40 text-dispatch-amber',
  detenida: 'border-dispatch-line text-dispatch-muted',
  revision: 'border-dispatch-blue/40 text-dispatch-blue',
  archivada: 'border-dispatch-lime/40 text-dispatch-lime',
};

const STATUS_DOT: Record<string, string> = {
  activa: 'bg-dispatch-rec animate-blink',
  pausada: 'bg-dispatch-amber',
  detenida: 'bg-dispatch-muted',
  revision: 'bg-dispatch-blue animate-blink-slow',
  archivada: 'bg-dispatch-lime',
};

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r}`;
};

const fmtClock = (d: Date): string =>
  `${d.getHours() < 10 ? '0' : ''}${d.getHours()}:${d.getMinutes() < 10 ? '0' : ''}${d.getMinutes()}:${d.getSeconds() < 10 ? '0' : ''}${d.getSeconds()}`;

const fmtDate = (d: Date): string =>
  `${d.getFullYear()}-${d.getMonth() + 1 < 10 ? '0' : ''}${d.getMonth() + 1}-${d.getDate() < 10 ? '0' : ''}${d.getDate()} ${d.getHours() < 10 ? '0' : ''}${d.getHours()}:${d.getMinutes() < 10 ? '0' : ''}${d.getMinutes()}`;

function synthWav(seconds: number): Blob {
  const rate = 22050;
  const total = Math.max(1, seconds) * rate;
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);

  const writeStr = (off: number, str: string): number => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i));
    return off + str.length;
  };

  let o = 0;
  o = writeStr(o, 'RIFF');
  v.setUint32(o, 36 + total * 2, true);
  o += 4;
  o = writeStr(o, 'WAVE');
  o = writeStr(o, 'fmt ');
  v.setUint32(o, 16, true);
  o += 4;
  v.setUint16(o, 1, true);
  o += 2;
  v.setUint16(o, 1, true);
  o += 2;
  v.setUint32(o, rate, true);
  o += 4;
  v.setUint32(o, rate * 2, true);
  o += 4;
  v.setUint16(o, 2, true);
  o += 2;
  v.setUint16(o, 16, true);
  o += 2;
  o = writeStr(o, 'data');
  v.setUint32(o, total * 2, true);
  o += 4;

  const base = 0.14;
  const trem = 0.03;
  let p = 0;
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    const env = 0.4 + 0.6 * Math.min(1, t / 0.4);
    const env2 = 0.4 + 0.6 * Math.min(1, (Math.max(1, seconds) - t) / 0.6);
    const s =
      Math.sin(2 * Math.PI * 175 * t) * 0.22 * env +
      Math.sin(2 * Math.PI * 175 * t * 0.5) * 0.16 * env +
      Math.sin(2 * Math.PI * 525 * t) * 0.06 * env +
      Math.sin(2 * Math.PI * 93 * t + Math.sin(2 * Math.PI * 3.1 * t) * 1.6) * (base + trem * env) +
      (Math.random() * 2 - 1) * 0.012;
    v.setInt16(o + i * 2, Math.max(-32768, Math.min(32767, Math.round(s * env2 * 32767))), true);
  }
  p = 0; // (byte offset bookkeeping only; sample loop writes absolute positions)
  void p;
  return new Blob([buf], { type: 'audio/wav' });
}

export default function MemoriaLanding() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<PlayerStatus>('standby');
  const [recSeconds, setRecSeconds] = useState(0);
  const [timeBig, setTimeBig] = useState('00:00');
  const [current, setCurrent] = useState<Recording | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [note, setNote] = useState('');
  const [noteMsg, setNoteMsg] = useState(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditVisible, setAuditVisible] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const [toast, setToast] = useState<{ html: string; visible: boolean }>({ html: '', visible: false });

  const [filters, setFilters] = useState({ q: '', type: '', from: '', to: '' });
  const [recordings, setRecordings] = useState<Recording[]>(SEED_RECORDINGS);

  const toastShow = useCallback((html: string) => {
    setToast({ html, visible: true });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 3200);
  }, []);

  const auditAdd = useCallback((action: string, rec?: string) => {
    setAudit((a) => [{ t: new Date(), action, rec }, ...a].slice(0, 60));
  }, []);

  const loadUrl = useCallback((blob: Blob) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    audio.src = url;
    audio.load();
  }, []);

  const updatePlayUI = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : 0;
    setProgress({ cur: audio.currentTime || 0, dur });
    setTimeBig(fmt(audio.currentTime || 0));
  }, []);

  const renderPlayBtn = useCallback((isPlaying: boolean) => {
    setPlaying(isPlaying);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (status === 'recording' || status === 'recPaused') return;
    if (!current) {
      toastShow('No hay grabación cargada');
      return;
    }
    if (audio.paused) {
      void audio.play();
      setStatus('review');
      setTimeBig(fmt(audio.currentTime));
      renderPlayBtn(true);
      auditAdd('Reproducción iniciada');
    } else {
      audio.pause();
      setStatus('paused');
      setTimeBig(fmt(audio.currentTime));
      renderPlayBtn(false);
      auditAdd('Reproducción pausada');
    }
  }, [status, current, toastShow, auditAdd, renderPlayBtn]);

  const seekRel = useCallback(
    (d: number) => {
      const audio = audioRef.current;
      if (!audio || !current) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + d));
      updatePlayUI();
      auditAdd(`Avance de ${d > 0 ? '+' : ''}${d} s`);
    },
    [current, updatePlayUI, auditAdd],
  );

  const seekClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !current) return;
      const tr = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - tr.left) / tr.width;
      audio.currentTime = pct * (audio.duration || 0);
      updatePlayUI();
      auditAdd('Búsqueda manual');
    },
    [current, updatePlayUI, auditAdd],
  );

  const addMark = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const t = audio.currentTime;
    setMarks((m) => [...m, { t, at: new Date() }]);
    auditAdd(`Marca añadida a los ${fmt(t)}`);
    toastShow(`Marca guardada en <b>${fmt(t)}</b>`);
  }, [current, auditAdd, toastShow]);

  const goToMark = useCallback(
    (t: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = t;
      updatePlayUI();
    },
    [updatePlayUI],
  );

  const downloadAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current || !urlRef.current) return;
    const a = document.createElement('a');
    a.href = urlRef.current;
    a.download = `${current.id}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    auditAdd('Descarga del archivo', current.id);
    toastShow(`Descargando <b>${current.id}.wav</b>`);
  }, [current, auditAdd, toastShow]);

  const saveNote = useCallback(() => {
    if (!current) {
      toastShow('No hay grabación cargada');
      return;
    }
    setCurrent((c) => (c ? { ...c, notes: note } : c));
    setNoteDirty(false);
    auditAdd('Nota del operador guardada', current.id);
    setNoteMsg(true);
    window.setTimeout(() => setNoteMsg(false), 1800);
    toastShow(`Nota vinculada a <b>${current.id}</b>`);
  }, [current, note, toastShow, auditAdd]);

  const startRecording = useCallback(() => {
    if (status === 'recording' || status === 'recPaused') return;
    setRecSeconds(0);
    setMarks([]);
    setNoteDirty(false);
    setTimeBig('00:00');
    setStatus('recording');
    auditAdd('Grabación iniciada');
    toastShow('Grabación en curso · <b>rojo parpadeante</b> = activa');
  }, [status, auditAdd, toastShow]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording' && status !== 'recPaused') return;
    const secs = Math.max(1, recSeconds);
    const blob = synthWav(secs);
    const start = new Date(Date.now() - secs * 1000);
    const rec: Recording = {
      id: 'INC-2026-0' + (1 + Math.floor(Math.random() * 40)),
      type: ['Médica', 'Trauma', 'Incendio', 'Seguridad', 'Otro'][Math.floor(Math.random() * 5)],
      location: 'Ubicación estimada por torre celular',
      date: start,
      duration: secs,
      status: 'detenida',
      notes: '',
    };
    setMarks([]);
    setNote('');
    loadUrl(blob);
    const audio = audioRef.current;
    if (audio) audio.currentTime = 0;
    setCurrent(rec);
    setTimeBig('00:00');
    setProgress({ cur: 0, dur: secs });
    setStatus('stopped');
    setRecordings((list) => [rec, ...list]);
    auditAdd(`Grabación detenida · ${rec.id}`, rec.id);
    toastShow(`Grabación <b>${rec.id}</b> lista para revisar`);
  }, [status, recSeconds, loadUrl, auditAdd, toastShow]);

  const toggleRec = useCallback(() => {
    if (status === 'recording' || status === 'recPaused') stopRecording();
    else startRecording();
  }, [status, stopRecording, startRecording]);

  const loadRecIntoPlayer = useCallback(
    (rec: Recording) => {
      setCurrent(rec);
      setMarks([]);
      const blob = synthWav(rec.duration);
      loadUrl(blob);
      const audio = audioRef.current;
      if (audio) audio.currentTime = 0;
      setNote(rec.notes || '');
      setNoteDirty(false);
      setTimeBig('00:00');
      setProgress({ cur: 0, dur: rec.duration });
      setStatus('stopped');
      renderPlayBtn(false);
      auditAdd(`Grabación cargada en reproductor · ${rec.id}`, rec.id);
      document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' });
    },
    [loadUrl, auditAdd, renderPlayBtn],
  );

  const archiveRec = useCallback(
    (id: string) => {
      setRecordings((list) => list.map((r) => (r.id === id ? { ...r, status: 'archivada' as const } : r)));
      auditAdd(`Grabación archivada · ${id}`, id);
      toastShow(`Grabación <b>${id}</b> archivada (no se elimina)`);
    },
    [auditAdd, toastShow],
  );

  const loadDemo = useCallback(() => {
    loadRecIntoPlayer(SEED_RECORDINGS[0]);
  }, [loadRecIntoPlayer]);

  useEffect(() => {
    loadDemo();
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'recording') return;
    const id = window.setInterval(() => {
      setRecSeconds((s) => {
        const next = s + 1;
        setTimeBig(fmt(next));
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const filtered = recordings
    .filter((r) => {
      const q = filters.q.trim().toLowerCase();
      if (q && !r.id.toLowerCase().includes(q)) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.from && r.date < new Date(`${filters.from}T00:00:00`)) return false;
      if (filters.to && r.date > new Date(`${filters.to}T23:59:59`)) return false;
      return true;
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const statusChip = STATUS_CHIP[status === 'recPaused' ? 'pausada' : status === 'review' ? 'revision' : status === 'recording' ? 'activa' : status === 'paused' ? 'pausada' : 'detenida'];
  const statusDot = STATUS_DOT[status === 'recPaused' ? 'pausada' : status === 'review' ? 'revision' : status === 'recording' ? 'activa' : status === 'paused' ? 'pausada' : 'detenida'];
  const statusLabel =
    status === 'standby' ? 'En espera' : STATUS_LBL[status === 'recPaused' ? 'recPaused' : status === 'review' ? 'revision' : status === 'recording' ? 'recording' : status === 'paused' ? 'recPaused' : 'detenida'];

  const recording = status === 'recording' || status === 'recPaused';
  const pct = progress.dur > 0 ? Math.min(100, (progress.cur / progress.dur) * 100) : 0;

  return (
    <div className="min-h-screen bg-dispatch-night text-dispatch-text font-sans">
      {/* ---------- Header ---------- */}
      <header className="sticky top-0 z-50 border-b border-dispatch-line bg-dispatch-night/85 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-5">
          <a href="#hero" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-dispatch-rec/15 text-dispatch-rec">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
                <path d="M4 3h16v18l-8-5-8 5z" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-dispatch-text">Despacho Cartagena</span>
          </a>
          <div className="ml-auto hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="rounded-md px-3 py-1.5 text-sm text-dispatch-muted transition hover:bg-dispatch-lineSoft hover:text-dispatch-text">
                {item.label}
              </a>
            ))}
          </div>
          <a
            href="#demo"
            className="ml-2 inline-flex items-center gap-2 rounded-lg bg-dispatch-rec px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-dispatch-rec/90"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
              <circle cx="12" cy="12" r="6" />
            </svg>
            Probar demo
          </a>
        </nav>
      </header>

      <main>
        {/* ---------- Hero ---------- */}
        <section id="hero" className="hero-grid border-b border-dispatch-line">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[1.15fr_1fr]">
            <div>
              <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-dispatch-line bg-dispatch-panel px-3 py-1 text-xs font-medium text-dispatch-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-dispatch-lime animate-blink" />
                Coordinación de emergencias · Cartagena
              </p>
              <h1 className="text-4xl font-bold leading-[1.08] tracking-tight text-dispatch-text sm:text-5xl lg:text-[56px]">
                Memoria de llamada, <span className="text-dispatch-rec">grabada</span> y <span className="text-dispatch-blue">auditable</span>.
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-dispatch-muted">
                Graba, transcribe y ancla cada llamada al incidente. Con registro de operador, marcas de tiempo y auditoría completa para el Cuerpo de Bomberos de Cartagena.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a
                  href="#demo"
                  className="inline-flex items-center gap-2 rounded-lg bg-dispatch-text px-5 py-3 text-sm font-semibold text-dispatch-night transition hover:bg-dispatch-text/90"
                >
                  Abrir el reproductor
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
                <a
                  href="#estados"
                  className="inline-flex items-center gap-2 rounded-lg border border-dispatch-line bg-dispatch-panel px-5 py-3 text-sm font-semibold text-dispatch-text transition hover:border-dispatch-lineSoft hover:bg-dispatch-panel2"
                >
                  Cómo funciona
                </a>
              </div>
              <ul className="mt-9 flex flex-wrap gap-x-6 gap-y-2 text-sm text-dispatch-muted">
                <li className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-dispatch-lime">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Grabación fiel de la llamada
                </li>
                <li className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-dispatch-lime">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Notas vinculadas al incidente
                </li>
                <li className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-dispatch-lime">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Auditoría inmutable
                </li>
              </ul>
            </div>

            {/* Hero card: mini snapshot */}
            <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
              <div className="flex items-center justify-between border-b border-dispatch-lineSoft pb-3">
                <span className="text-xs font-medium uppercase tracking-wider text-dispatch-muted">Resumen de turno</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-dispatch-lime/40 px-2 py-0.5 text-[11px] font-semibold text-dispatch-lime">
                  <span className="h-1.5 w-1.5 rounded-full bg-dispatch-lime animate-blink" />
                  En servicio
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                  <dt className="text-xs text-dispatch-muted">Llamadas hoy</dt>
                  <dd className="mt-1 text-2xl font-bold text-dispatch-text">38</dd>
                </div>
                <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                  <dt className="text-xs text-dispatch-muted">Tiempo medio</dt>
                  <dd className="mt-1 text-2xl font-bold text-dispatch-blue">01:36</dd>
                </div>
                <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                  <dt className="text-xs text-dispatch-muted">Unidades activas</dt>
                  <dd className="mt-1 text-2xl font-bold text-dispatch-lime">07</dd>
                </div>
                <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                  <dt className="text-xs text-dispatch-muted">Incidentes abiertos</dt>
                  <dd className="mt-1 text-2xl font-bold text-dispatch-rec">04</dd>
                </div>
              </dl>
              <div className="mt-4 rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-dispatch-text">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-dispatch-amber">
                    <path d="M4 3h16v18l-8-5-8 5z" />
                  </svg>
                  INC-2026-001 · Médica
                </p>
                <p className="mt-1.5 text-sm text-dispatch-muted">Dolor torácico, U-07 en camino.</p>
                <p className="mt-2 text-xs text-dispatch-muted">
                  Av. del Lago 45 <span className="text-dispatch-muted/60">(estimada)</span>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Demo / reproductor ---------- */}
        <section id="demo" className="border-b border-dispatch-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="mb-10 max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-widest text-dispatch-amber">Demo interactiva</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">El reproductor que ya usa el puesto de mando</h2>
              <p className="mt-3 text-dispatch-muted">
                Controles grandes (mínimo 48&nbsp;px), una sola pantalla junto al mapa de incidentes y las unidades. Pulsa «Iniciar» para simular una grabación, o usa la llamada de ejemplo ya cargada.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
              {/* Reproductor */}
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6 sm:p-8">
                <audio ref={audioRef} className="hidden" onTimeUpdate={updatePlayUI} onDurationChange={updatePlayUI} onEnded={() => renderPlayBtn(false)} />

                <div className="flex flex-wrap items-center gap-3">
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusChip}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
                    {statusLabel}
                  </span>
                  <span className="text-xs text-dispatch-muted">Demo sin permiso de micrófono · audio sintético</span>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                    <dt className="text-xs text-dispatch-muted">Incidente</dt>
                    <dd className="mt-1 text-sm font-semibold text-dispatch-text" id="metaId">
                      {current ? current.id : '—'}
                    </dd>
                  </div>
                  <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                    <dt className="text-xs text-dispatch-muted">Tipo</dt>
                    <dd className="mt-1 text-sm font-semibold text-dispatch-text">{current ? current.type : '—'}</dd>
                  </div>
                  <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                    <dt className="text-xs text-dispatch-muted">Ubicación</dt>
                    <dd className="mt-1 text-sm font-semibold text-dispatch-text">
                      {current ? current.location : '—'}{' '}
                      {current && <span className="text-xs font-normal text-dispatch-muted">(estimada)</span>}
                    </dd>
                  </div>
                  <div className="rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                    <dt className="text-xs text-dispatch-muted">Inicio</dt>
                    <dd className="mt-1 text-sm font-semibold text-dispatch-text">{current ? fmtClock(current.date) : '--:--:--'}</dd>
                  </div>
                </div>

                <div className="mt-8 flex items-center gap-6">
                  <div className={`min-w-[110px] font-mono text-5xl font-bold tracking-tight ${recording ? 'text-dispatch-rec' : status === 'review' || status === 'paused' ? 'text-dispatch-blue' : 'text-dispatch-text'}`}>
                    {timeBig}
                  </div>
                  <div className="flex-1 space-y-2">
                    <p className="text-sm text-dispatch-muted" id="timeCap">
                      {recording
                        ? 'Grabando en vivo · pulse detener para revisar'
                        : status === 'review'
                          ? 'Revisando grabación · queda registrado en auditoría'
                          : status === 'paused'
                            ? 'Pausada · pulsa reproducir para continuar'
                            : current
                              ? 'Cargada · pulsa reproducir'
                              : 'Lista para grabar'}
                    </p>
                    <div
                      className="group relative h-2 w-full cursor-pointer rounded-full bg-dispatch-lineSoft"
                      onClick={seekClick}
                    >
                      <div className="absolute left-0 top-0 h-full rounded-full bg-dispatch-blue/70" style={{ width: `${pct}%` }} />
                      <div className="absolute -top-1 h-4 w-1 rounded bg-dispatch-blue" style={{ left: `calc(${pct}% - 2px)` }} />
                      {marks.map((m, i) => (
                        <button
                          key={`${m.t}-${i}`}
                          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-dispatch-night bg-dispatch-amber transition hover:scale-125"
                          style={{ left: `${(m.t / (progress.dur || 1)) * 100}%` }}
                          title={`Marca · ${fmt(m.t)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            goToMark(m.t);
                          }}
                        />
                      ))}
                    </div>
                    <div className="flex justify-between text-xs tabular-nums text-dispatch-muted">
                      <span>{fmt(progress.cur)}</span>
                      <span>{fmt(progress.dur)}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => seekRel(-10)}
                    disabled={!current || recording}
                    className="inline-flex h-16 w-16 items-center justify-center rounded-full border border-dispatch-line bg-dispatch-panel2 text-dispatch-text transition hover:border-dispatch-text/40 disabled:opacity-35"
                    title="−10 segundos"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                      <path d="M12 5 6 12l6 7M19 5l-6 7 6 7" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={toggleRec}
                    className={`inline-flex h-16 w-16 items-center justify-center rounded-full transition ${
                      recording
                        ? 'bg-dispatch-rec text-white shadow-lg shadow-dispatch-rec/30'
                        : 'border border-dispatch-rec/50 bg-dispatch-rec/10 text-dispatch-rec hover:bg-dispatch-rec hover:text-white'
                    }`}
                    title={recording ? 'Detener grabación' : 'Iniciar grabación simulada'}
                  >
                    {recording ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-7 w-7">
                        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                        <circle cx="12" cy="12" r="6" fill="currentColor" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={togglePlay}
                    disabled={!current || recording}
                    className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-dispatch-lime text-dispatch-night transition hover:bg-dispatch-lime/90 disabled:opacity-35"
                    title={playing ? 'Pausar' : 'Reproducir'}
                  >
                    {playing ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="h-7 w-7">
                        <path d="M8 5v14M16 5v14" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 h-7 w-7">
                        <path d="M6 4l14 8-14 8z" fill="currentColor" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekRel(10)}
                    disabled={!current || recording}
                    className="inline-flex h-16 w-16 items-center justify-center rounded-full border border-dispatch-line bg-dispatch-panel2 text-dispatch-text transition hover:border-dispatch-text/40 disabled:opacity-35"
                    title="+10 segundos"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                      <path d="M12 5l6 7-6 7M5 5l6 7-6 7" />
                    </svg>
                  </button>
                </div>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={addMark}
                    disabled={!current || recording}
                    className="inline-flex items-center gap-2 rounded-lg border border-dispatch-amber/40 bg-dispatch-amber/10 px-4 py-2.5 text-sm font-semibold text-dispatch-amber transition hover:bg-dispatch-amber hover:text-dispatch-night disabled:opacity-35"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M4 3h16v18l-8-5-8 5z" />
                    </svg>
                    Marcar momento
                  </button>
                  <button
                    type="button"
                    onClick={downloadAudio}
                    disabled={!current || recording}
                    className="inline-flex items-center gap-2 rounded-lg border border-dispatch-lime/40 bg-dispatch-lime/10 px-4 py-2.5 text-sm font-semibold text-dispatch-lime transition hover:bg-dispatch-lime hover:text-dispatch-night disabled:opacity-35"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16" />
                    </svg>
                    Descargar WAV
                  </button>
                </div>

                {marks.length > 0 && (
                  <div className="mt-6 border-t border-dispatch-lineSoft pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-dispatch-muted">Marcas de tiempo</p>
                    <div className="flex flex-wrap gap-2">
                      {marks.map((m, i) => (
                        <button
                          key={`${m.t}-${i}`}
                          type="button"
                          onClick={() => goToMark(m.t)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-dispatch-line bg-dispatch-panel2 px-3 py-1.5 text-sm text-dispatch-amber transition hover:border-dispatch-amber/50"
                          title={`Ir a ${fmt(m.t)}`}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                            <path d="M4 3h16v18l-8-5-8 5z" />
                          </svg>
                          {fmt(m.t)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Panel lateral: notas + auditoría */}
              <div className="space-y-6">
                <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6">
                  <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-dispatch-muted">Notas del operador</p>
                  <textarea
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setNoteDirty(true);
                    }}
                    rows={4}
                    placeholder="Observaciones, datos del solicitante, unidades asignadas…"
                    className="w-full resize-none rounded-xl border border-dispatch-lineSoft bg-dispatch-panel2 px-3 py-2.5 text-sm text-dispatch-text placeholder:text-dispatch-muted/60 focus:border-dispatch-blue focus:outline-none"
                  />
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={saveNote}
                      disabled={!current || recording}
                      className="inline-flex items-center gap-2 rounded-lg bg-dispatch-blue px-4 py-2 text-sm font-semibold text-dispatch-night transition hover:bg-dispatch-blue/90 disabled:opacity-35"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Guardar nota
                    </button>
                    {noteMsg && <span className="text-sm font-semibold text-dispatch-lime">Nota guardada</span>}
                  </div>
                </div>

                <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold uppercase tracking-wider text-dispatch-muted">Auditoría</p>
                    <button
                      type="button"
                      onClick={() => setAuditVisible((v) => !v)}
                      className="rounded-md px-2 py-1 text-xs font-semibold text-dispatch-blue transition hover:bg-dispatch-lineSoft"
                    >
                      {auditVisible ? 'Ocultar' : 'Mostrar'}
                    </button>
                  </div>
                  {auditVisible && (
                    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                      {audit.length === 0 ? (
                        <div className="flex items-start gap-3 rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                          <time className="font-mono text-xs text-dispatch-muted">--:--:--</time>
                          <span className="text-sm text-dispatch-muted">Sin actividad registrada aún.</span>
                        </div>
                      ) : (
                        audit.map((e, i) => (
                          <div key={`${e.t.getTime()}-${i}`} className="flex items-start gap-3 rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 p-3">
                            <time className="shrink-0 font-mono text-xs text-dispatch-muted">{fmtClock(e.t)}</time>
                            <span className="text-sm text-dispatch-text">{e.action}</span>
                            {e.rec && <span className="ml-auto shrink-0 font-mono text-xs text-dispatch-muted">{e.rec}</span>}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Por qué importa ---------- */}
        <section id="why" className="border-b border-dispatch-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="mb-12 max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-widest text-dispatch-amber">Por qué importa</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">Una llamada puede decidir una vida</h2>
              <p className="mt-3 text-dispatch-muted">Cada decisión de despacho debe poder reconstruirse: qué se dijo, quién lo dijo y en qué segundo exacto.</p>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-dispatch-blue/30 bg-dispatch-blue/10 text-dispatch-blue">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                    <path d="M4 3h16v18l-8-5-8 5z" />
                  </svg>
                </span>
                <h3 className="mt-4 text-lg font-semibold text-dispatch-text">Claridad</h3>
                <p className="mt-2 text-sm leading-relaxed text-dispatch-muted">
                  Reproduce con exactitud cada llamada y consulta las notas del operador junto al audio, sin perder el contexto del incidente.
                </p>
              </div>

              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-dispatch-lime/30 bg-dispatch-lime/10 text-dispatch-lime">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
                  </svg>
                </span>
                <h3 className="mt-4 text-lg font-semibold text-dispatch-text">Trazabilidad</h3>
                <p className="mt-2 text-sm leading-relaxed text-dispatch-muted">
                  Cada archivo se vincula a su incidente con marca de tiempo, operador y estado. Nada queda huérfano ni sin responsable.
                </p>
              </div>

              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-dispatch-rec/30 bg-dispatch-rec/10 text-dispatch-rec">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" fill="currentColor" />
                  </svg>
                </span>
                <h3 className="mt-4 text-lg font-semibold text-dispatch-text">Velocidad</h3>
                <p className="mt-2 text-sm leading-relaxed text-dispatch-muted">
                  Un solo panel para escuchar, marcar, anotar y despachar. Menos clics, menos segundos perdidos en la sala de emergencias.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Estados ---------- */}
        <section id="estados" className="border-b border-dispatch-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="mb-10 max-w-2xl">
              <p className="text-sm font-semibold uppercase tracking-widest text-dispatch-amber">Estados</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">Cada grabación tiene un ciclo de vida</h2>
              <p className="mt-3 text-dispatch-muted">Del momento en que suena el teléfono hasta el archivo definitivo, el estado indica quién está actuando y qué toca hacer.</p>
            </div>

            <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-5">
              {[
                { key: 'activa', label: 'Activa', desc: 'En curso, está sonando ahora mismo.' },
                { key: 'detenida', label: 'Detenida', desc: 'Guardada y lista para revisar, marcar o descargar.' },
                { key: 'revision', label: 'En revisión', desc: 'El jefe de turno está validando el despacho.' },
                { key: 'archivada', label: 'Archivada', desc: 'Cerrada y retenida por normativa. No se elimina.' },
                { key: 'pausada', label: 'Pausada', desc: 'Reproducción suspendida por el operador.' },
              ].map((s) => (
                <div key={s.key} className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_CHIP[s.key]}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s.key]}`} />
                    {s.label}
                  </span>
                  <p className="mt-3 text-sm leading-relaxed text-dispatch-muted">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Listado / buscador ---------- */}
        <section id="listado" className="border-b border-dispatch-line">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-widest text-dispatch-amber">Historial</p>
                <h2 className="mt-2 text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">Grabaciones recientes</h2>
              </div>
              <button
                type="button"
                onClick={loadDemo}
                className="inline-flex items-center gap-2 rounded-lg border border-dispatch-line bg-dispatch-panel px-4 py-2.5 text-sm font-semibold text-dispatch-text transition hover:border-dispatch-text/40"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                </svg>
                Recargar demo
              </button>
            </div>

            <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5 sm:p-6">
              <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
                <input
                  type="search"
                  value={filters.q}
                  onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                  placeholder="Buscar por INC…"
                  className="rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 px-3 py-2.5 text-sm text-dispatch-text placeholder:text-dispatch-muted/60 focus:border-dispatch-blue focus:outline-none"
                />
                <select
                  value={filters.type}
                  onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
                  className="rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 px-3 py-2.5 text-sm text-dispatch-text focus:border-dispatch-blue focus:outline-none"
                >
                  <option value="">Todos los tipos</option>
                  {['Médica', 'Trauma', 'Incendio', 'Seguridad', 'Otro'].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                  className="rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 px-3 py-2.5 text-sm text-dispatch-text focus:border-dispatch-blue focus:outline-none [color-scheme:dark]"
                />
                <input
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                  className="rounded-lg border border-dispatch-lineSoft bg-dispatch-panel2 px-3 py-2.5 text-sm text-dispatch-text focus:border-dispatch-blue focus:outline-none [color-scheme:dark]"
                />
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-dispatch-lineSoft text-left text-xs uppercase tracking-wider text-dispatch-muted">
                      <th className="py-2.5 pr-3 font-semibold">Incidente</th>
                      <th className="py-2.5 pr-3 font-semibold">Tipo</th>
                      <th className="py-2.5 pr-3 font-semibold">Fecha</th>
                      <th className="py-2.5 pr-3 font-semibold">Duración</th>
                      <th className="py-2.5 pr-3 font-semibold">Estado</th>
                      <th className="py-2.5 font-semibold">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const chipKey = r.status === 'revision' ? 'revision' : r.status === 'detenida' ? 'detenida' : 'archivada';
                      return (
                        <tr key={r.id} className="border-b border-dispatch-lineSoft/60 last:border-0">
                          <td className="py-3 pr-3 font-mono text-dispatch-blue">{r.id}</td>
                          <td className="py-3 pr-3 text-dispatch-text">{r.type}</td>
                          <td className="py-3 pr-3 text-dispatch-muted">{fmtDate(r.date)}</td>
                          <td className="py-3 pr-3 font-mono text-dispatch-muted">{fmt(r.duration)}</td>
                          <td className="py-3 pr-3">
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_CHIP[chipKey]}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[chipKey]}`} />
                              {STATUS_LBL[r.status]}
                            </span>
                          </td>
                          <td className="py-3">
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => loadRecIntoPlayer(r)}
                                className="rounded-md border border-dispatch-blue/40 bg-dispatch-blue/10 px-2.5 py-1.5 text-xs font-semibold text-dispatch-blue transition hover:bg-dispatch-blue hover:text-dispatch-night"
                              >
                                Escuchar
                              </button>
                              {r.status !== 'archivada' && (
                                <button
                                  type="button"
                                  onClick={() => archiveRec(r.id)}
                                  className="rounded-md border border-dispatch-line px-2.5 py-1.5 text-xs font-semibold text-dispatch-muted transition hover:text-dispatch-text"
                                >
                                  Archivar
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <p className="py-8 text-center text-sm text-dispatch-muted">Sin resultados para los filtros actuales.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Técnica ---------- */}
        <section id="tecnica" className="border-b border-dispatch-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-dispatch-amber">Técnica</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">Hecho para funcionar en el puesto de mando</h2>
              <p className="mt-3 text-dispatch-muted">
                El registro de llamadas del Despacho Cartagena está pensado para pantallas táctiles, turnos largos y escenarios con ruido. Por eso cada elemento prioriza la lectura rápida y el mínimo de fricción.
              </p>
              <div className="mt-6 space-y-3">
                {[
                  'Botones grandes y zonas táctiles de al menos 48 px.',
                  'Misma pantalla para audio, mapa de incidentes y unidades.',
                  'Auditoría automática de cada acción del operador.',
                  'Retención conforme a normativa, con estado «archivada».',
                ].map((item) => (
                  <p key={item} className="flex items-start gap-2.5 text-sm text-dispatch-muted">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-4 w-4 shrink-0 text-dispatch-lime">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {item}
                  </p>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
                <p className="font-mono text-xs text-dispatch-muted">wav</p>
                <p className="mt-2 text-3xl font-bold text-dispatch-text">44,1 kHz</p>
                <p className="mt-1 text-sm text-dispatch-muted">Calidad de audio sin compresión para reproducir fielmente la llamada.</p>
              </div>
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
                <p className="font-mono text-xs text-dispatch-muted">acceso</p>
                <p className="mt-2 text-3xl font-bold text-dispatch-blue">Nivel 3</p>
                <p className="mt-1 text-sm text-dispatch-muted">Solo personal autorizado del puesto de mando puede escuchar y archivar.</p>
              </div>
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
                <p className="font-mono text-xs text-dispatch-muted">retención</p>
                <p className="mt-2 text-3xl font-bold text-dispatch-amber">3 años</p>
                <p className="mt-1 text-sm text-dispatch-muted">Las grabaciones archivadas se conservan por requisito normativo.</p>
              </div>
              <div className="rounded-2xl border border-dispatch-line bg-dispatch-panel p-5">
                <p className="font-mono text-xs text-dispatch-muted">transmisión</p>
                <p className="mt-2 text-3xl font-bold text-dispatch-lime">Encriptada</p>
                <p className="mt-1 text-sm text-dispatch-muted">La memoria viaja cifrada hasta el repositorio de incidentes.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- CTA ---------- */}
        <section className="border-b border-dispatch-line">
          <div className="mx-auto max-w-6xl px-5 py-20 text-center">
            <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight text-dispatch-text sm:text-4xl">
              Prueba la demo. Simula una llamada, márcala y descárgala.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-dispatch-muted">
              Todo ocurre en tu navegador: el audio sintético se genera localmente y la demo no requiere permiso de micrófono.
            </p>
            <a
              href="#demo"
              className="mt-8 inline-flex items-center gap-2 rounded-lg bg-dispatch-rec px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-dispatch-rec/90"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <circle cx="12" cy="12" r="6" />
              </svg>
              Abrir la demo
            </a>
          </div>
        </section>
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="border-t border-dispatch-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <p className="text-sm text-dispatch-muted">
            © {new Date().getFullYear()} Despacho Cartagena · Cuerpo de Bomberos de Cartagena
          </p>
          <div className="flex items-center gap-5 text-sm text-dispatch-muted">
            <a href="#demo" className="transition hover:text-dispatch-text">
              Demo
            </a>
            <a href="#estados" className="transition hover:text-dispatch-text">
              Estados
            </a>
            <a href="#tecnica" className="transition hover:text-dispatch-text">
              Técnica
            </a>
          </div>
        </div>
      </footer>

      {/* ---------- Toast ---------- */}
      {toast.visible && (
        <div
          className="fixed bottom-6 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-xl border border-dispatch-line bg-dispatch-panel px-4 py-3 text-sm text-dispatch-text shadow-2xl shadow-black/40"
          dangerouslySetInnerHTML={{ __html: toast.html }}
        />
      )}
    </div>
  );
}
