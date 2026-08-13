import type { IncidentType } from '@dispatch/contracts';

/**
 * Protocolos de primeros auxilios básicos, para nivel de testigo (no personal
 * médico), mientras espera la ambulancia. Curados a mano — el LLM del §32
 * (`converseTurn`) los recibe como contexto de referencia en vez de
 * improvisar procedimientos de memoria. Mismo espíritu que `triage.ts`:
 * conocimiento explícito y auditable, la IA lo comunica, no lo inventa.
 *
 * Deliberadamente genérico y conservador — el objetivo es no empeorar la
 * situación mientras llega ayuda profesional, no diagnosticar ni tratar.
 */
export interface FirstAidProtocol {
  readonly haz: readonly string[];
  readonly evita: readonly string[];
  readonly señalesDeAlarma: readonly string[];
}

export const FIRST_AID_PROTOCOLS: Record<IncidentType, FirstAidProtocol> = {
  TRAFFIC_ACCIDENT: {
    haz: [
      'No mover a la persona salvo peligro inmediato (fuego, tráfico).',
      'Señalizar la escena si es seguro hacerlo.',
      'Si hay sangrado, presión firme con un paño limpio.',
      'Abrigarla y hablarle con calma para mantenerla despierta.',
    ],
    evita: [
      'No quitar el casco a un motociclista salvo que no respire.',
      'No dar de comer ni beber.',
      'No mover el cuello ni la espalda.',
    ],
    señalesDeAlarma: ['pérdida de consciencia', 'dificultad para respirar', 'sangrado que no para con presión'],
  },
  CARDIAC: {
    haz: [
      'Sentarla en posición cómoda, semi-sentada.',
      'Aflojar ropa ajustada al cuello o pecho.',
      'Mantener la calma y no dejarla sola.',
      'Si sabe hacer RCP y la persona deja de responder y no respira con normalidad, iniciarla.',
    ],
    evita: ['No darle de comer ni beber.', 'No dejarla sola en ningún momento.'],
    señalesDeAlarma: ['pérdida de consciencia', 'deja de respirar con normalidad'],
  },
  UNCONSCIOUS: {
    haz: [
      'Verificar si respira, acercando oído y mejilla a su boca.',
      'Si respira, colocarla de lado (posición lateral de seguridad) para que no se ahogue si vomita.',
      'Si sabe hacer RCP y no respira, iniciarla de inmediato.',
    ],
    evita: ['No darle nada de comer ni beber.', 'No dejarla boca arriba si hay riesgo de vómito.'],
    señalesDeAlarma: ['deja de respirar', 'convulsiones'],
  },
  FALL: {
    haz: [
      'Mantenerla quieta si hay sospecha de lesión en cuello, espalda o cadera (dolor intenso, no puede mover una extremidad).',
      'Abrigarla y hablarle con calma.',
      'Si hay sangrado, presión firme con un paño limpio.',
    ],
    evita: ['No enderezar una extremidad deformada.', 'No forzarla a levantarse o caminar.'],
    señalesDeAlarma: ['no puede mover brazos o piernas', 'dolor intenso en cuello o espalda', 'pérdida de consciencia'],
  },
  TRAUMA: {
    haz: [
      'Presión firme y constante sobre la herida con un paño limpio.',
      'Si el paño se empapa, poner otro encima sin retirar el primero.',
      'Elevar la zona afectada si es posible.',
      'Mantenerla abrigada y calmada.',
    ],
    evita: [
      'No quitar objetos clavados o empalados — dejarlos y evitar que se muevan.',
      'No usar torniquete salvo saber hacerlo y que el sangrado sea masivo e incontrolable.',
    ],
    señalesDeAlarma: ['sangrado que no se controla con presión', 'palidez extrema', 'pérdida de consciencia'],
  },
  RESPIRATORY: {
    haz: [
      'Ayudarla a sentarse derecha — facilita respirar.',
      'Aflojar ropa ajustada al cuello o pecho.',
      'Hablar despacio y mantener la calma.',
      'Si tiene inhalador recetado, ayudarla a usarlo.',
    ],
    evita: ['No acostarla.', 'No dejarla sola.'],
    señalesDeAlarma: ['labios o piel azulada', 'no puede hablar por falta de aire', 'pérdida de consciencia'],
  },
  OBSTETRIC: {
    haz: [
      'Mantenerla cómoda, preferiblemente recostada de lado izquierdo.',
      'Si el parto parece inminente, tener paños limpios a mano y mantener la calma.',
      'Si el bebé empieza a nacer, dejar que salga solo y sostenerlo con cuidado.',
    ],
    evita: ['No tirar del bebé.', 'No darle de comer.', 'No cruzarle las piernas para "retener" el parto.'],
    señalesDeAlarma: ['sangrado abundante', 'el bebé nace antes de que llegue la ambulancia'],
  },
  OTHER: {
    haz: [
      'Mantener la calma y verificar si la persona responde y respira con normalidad.',
      'Mantenerla segura, cómoda y abrigada.',
    ],
    evita: ['No moverla innecesariamente.'],
    señalesDeAlarma: ['pérdida de consciencia', 'dificultad para respirar'],
  },
};

function formatOne(type: IncidentType): string {
  const p = FIRST_AID_PROTOCOLS[type];
  return [
    `· ${type} — Haz: ${p.haz.join(' ')}`,
    `  Evita: ${p.evita.join(' ')}`,
    `  Señales de alarma: ${p.señalesDeAlarma.join(', ')}.`,
  ].join('\n');
}

/**
 * Formatea el/los protocolo(s) como bloque de contexto para el prompt del
 * LLM. Una emergencia real puede calzar en más de un tipo a la vez (p. ej.
 * inconsciente Y con sangrado severo) — el LLM recibe TODOS los que
 * apliquen, nunca solo el primero detectado en la conversación. TRAUMA va
 * siempre primero cuando está presente: control de hemorragia es prioridad
 * sobre cualquier otra instrucción — una lesión con sangrado catastrófico no
 * es algo que se "deje para después".
 */
export function formatFirstAidProtocols(types: readonly IncidentType[]): string {
  if (types.length === 0) return '';
  const hasTrauma = types.includes('TRAUMA');
  const ordered = [...types].sort((a, b) => (a === 'TRAUMA' ? -1 : b === 'TRAUMA' ? 1 : 0));
  const header = types.length > 1
    ? 'Esta emergencia calza con más de un tipo a la vez — dales atención a TODOS, no ignores ninguno por atender otro. Si hay control de sangrado pendiente, es la prioridad sobre cualquier otra instrucción.'
    : 'Básate en esto, no inventes procedimientos distintos.';
  const traumaDirective = hasTrauma
    ? 'TRAUMA está presente: da la instrucción de control de sangrado (presión firme) como tu PRIMERA frase, de forma directa. No preguntes primero si está sangrando para decidir si la das — en una herida grave o amputación se asume que sí y se actúa.'
    : null;
  return [
    `Contexto médico de referencia para esta emergencia:`,
    header,
    ...(traumaDirective ? [traumaDirective] : []),
    ...ordered.map(formatOne),
  ].join('\n');
}
