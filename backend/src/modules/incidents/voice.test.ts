import { INCIDENT_TYPE } from '@dispatch/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeTranscript, classifyIncidentType } from './voice.js';

describe('classifyIncidentType', () => {
  it.each([
    ['Hubo un choque de dos carros en la esquina', 'TRAFFIC_ACCIDENT'],
    ['Mi papá tiene un dolor de pecho fuerte', 'CARDIAC'],
    ['La señora no responde, está inconsciente', 'UNCONSCIOUS'],
    ['Se cayó de una escalera', 'FALL'],
    ['Tiene una herida que sangra mucho', 'TRAUMA'],
    ['No puede respirar bien', 'RESPIRATORY'],
    ['Mi esposa está embarazada y con contracciones', 'OBSTETRIC'],
  ] as const)('clasifica %j como %s', (text, expected) => {
    expect(classifyIncidentType(text)).toBe(expected);
  });

  it('devuelve null cuando ningún patrón coincide (la UI deja "OTHER" al criterio del usuario)', () => {
    expect(classifyIncidentType('Hay una situación rara en la calle')).toBeNull();
  });

  it('no distingue mayúsculas/minúsculas ni tildes al buscar la palabra clave', () => {
    expect(classifyIncidentType('CHOQUE de motos')).toBe('TRAFFIC_ACCIDENT');
  });

  it('nunca sugiere un tipo fuera del vocabulario controlado', () => {
    const result = classifyIncidentType('choque con herida y sangrado y no respira');
    expect(result === null || (INCIDENT_TYPE as readonly string[]).includes(result)).toBe(true);
  });
});

describe('analyzeTranscript', () => {
  const ORIGINAL_KEY = process.env.GROQ_API_KEY;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env.GROQ_API_KEY = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  function mockChatResponse(body: unknown, ok = true) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    }));
  }

  it('usa el JSON del LLM cuando responde bien y el tipo es válido', async () => {
    mockChatResponse({ summary: 'Choque con una persona herida en el barrio Manga.', type: 'TRAFFIC_ACCIDENT', patientCount: 1 });
    const result = await analyzeTranscript('hubo un choque en manga con un herido');
    expect(result).toEqual({
      summary: 'Choque con una persona herida en el barrio Manga.',
      suggestedType: 'TRAFFIC_ACCIDENT',
      suggestedPatientCount: 1,
    });
  });

  it('cae al clasificador por palabras clave si el LLM sugiere un tipo fuera del vocabulario', async () => {
    mockChatResponse({ summary: 'resumen', type: 'ALIEN_ABDUCTION', patientCount: null });
    const result = await analyzeTranscript('hubo un choque de carros');
    expect(result.suggestedType).toBe('TRAFFIC_ACCIDENT');
  });

  it('nunca lanza y usa el texto crudo si el LLM responde con error HTTP', async () => {
    mockChatResponse({}, false);
    const result = await analyzeTranscript('un choque de motos');
    expect(result).toEqual({ summary: 'un choque de motos', suggestedType: 'TRAFFIC_ACCIDENT', suggestedPatientCount: null });
  });

  it('nunca lanza y usa el texto crudo si la red falla', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const result = await analyzeTranscript('una señora inconsciente');
    expect(result).toEqual({ summary: 'una señora inconsciente', suggestedType: 'UNCONSCIOUS', suggestedPatientCount: null });
  });

  it('nunca lanza si el LLM responde JSON inválido', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'no soy json' } }] }),
    }));
    const result = await analyzeTranscript('una caída en la calle');
    expect(result.suggestedType).toBe('FALL');
  });

  it('sin GROQ_API_KEY, se salta la llamada de red y usa el fallback determinista', async () => {
    delete process.env.GROQ_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await analyzeTranscript('un choque de carros');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.suggestedType).toBe('TRAFFIC_ACCIDENT');
  });

  it('descarta patientCount fuera de rango (0-50) o no entero', async () => {
    mockChatResponse({ summary: 'x', type: null, patientCount: 999 });
    const result = await analyzeTranscript('texto cualquiera');
    expect(result.suggestedPatientCount).toBeNull();
  });
});
