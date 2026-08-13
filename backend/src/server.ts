import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zTranscribeAudioResponse } from '@dispatch/contracts';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { HttpError, toApiError } from './errors.js';
import { transcribeVoiceReport } from './modules/incidents/voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4001);
// WhatsApp limita notas de voz a ~16MB/varios minutos; aquí acotamos más
// corto (nota de emergencia, no un podcast) para mantener el request liviano.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

const app = express();
app.use(cors());
// public/test.html — página manual para grabar y probar la transcripción sin curl/Postman.
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'audio-service' });
});

// Raíz informativa: no hay UI, así que un GET / a mano no debe verse "roto".
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'audio-service',
    endpoints: {
      'GET /health': 'estado del servicio',
      'GET /test.html': 'página manual para grabar y probar la transcripción',
      'POST /api/incidents/transcribe': 'multipart/form-data con campo `audio` → { description, suggestedType }',
    },
  });
});

app.post('/api/incidents/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file || req.file.size === 0) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Falta el archivo de audio (`audio`)');
    }
    const result = await transcribeVoiceReport(req.file.buffer, req.file.mimetype, req.file.originalname || 'nota-de-voz.webm');
    res.json(zTranscribeAudioResponse.parse(result));
  } catch (error) {
    const mapped = toApiError(error);
    res.status(mapped.status).json(mapped.body);
  }
});

// Errores de multer (archivo demasiado grande, campo inválido) no pasan por
// el try/catch de la ruta: llegan aquí.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof MulterError) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'El audio es demasiado largo o el campo es inválido' } });
    return;
  }
  const mapped = toApiError(error);
  res.status(mapped.status).json(mapped.body);
});

app.listen(PORT, () => {
  console.log(`[audio-service] escuchando en http://localhost:${PORT}`);
});
