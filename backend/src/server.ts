import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zConversationTurn, zConverseResponse } from '@dispatch/contracts';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import { converseTurn, synthesizeSpeech } from './modules/incidents/conversation.js';
import { transcribeAudio } from './modules/incidents/voice.js';
import { HttpError, toApiError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4001);
// WhatsApp limita notas de voz a ~16MB/varios minutos; aquí acotamos más
// corto (nota de emergencia, no un podcast) para mantener el request liviano.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

const app = express();
app.use(cors());
// public/test.html — página manual para grabar y probar la llamada sin curl/Postman.
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'audio-service' });
});

// Raíz informativa: no hay UI, así que un GET / a mano no debe verse "roto".
// El reporte de voz que CREA el incidente vive en apps/web (POST
// /api/incidents/audio) — ahí está el motor de deduplicación real. Este
// servicio es solo la "llamada" con IA: orientación en vivo mientras espera
// la ambulancia, no reemplaza ni duplica ese reporte.
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'audio-service',
    endpoints: {
      'GET /health': 'estado del servicio',
      'GET /test.html': 'página manual para probar la llamada con la IA',
      'POST /api/incidents/converse': 'multipart: campos `audio` + `history` (JSON) → { transcript, reply, replyAudioBase64, history }',
    },
  });
});

app.post('/api/incidents/converse', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file || req.file.size === 0) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Falta el archivo de audio (`audio`)');
    }
    const historyRaw = typeof req.body?.history === 'string' ? req.body.history : '[]';
    let history: z.infer<typeof zConversationTurn>[];
    try {
      history = z.array(zConversationTurn).parse(JSON.parse(historyRaw));
    } catch {
      throw new HttpError(400, 'VALIDATION_FAILED', '`history` debe ser JSON válido: [{role, content}]');
    }

    const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype, req.file.originalname || 'turno.webm');
    const { reply, detectedTypes } = await converseTurn(transcript, history);
    const replyAudio = await synthesizeSpeech(reply);

    res.json(zConverseResponse.parse({
      transcript,
      reply,
      detectedTypes,
      replyAudioBase64: replyAudio ? replyAudio.buffer.toString('base64') : null,
      replyAudioMimeType: replyAudio ? replyAudio.mimeType : null,
      history: [...history, { role: 'user', content: transcript }, { role: 'assistant', content: reply }],
    }));
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
