import { INCIDENT_TYPE } from '@dispatch/contracts';
import { describe, expect, it } from 'vitest';
import { classifyAllIncidentTypes, classifyIncidentType } from './voice.js';

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

  it.each([
    ['amputa', 'TRAUMA'],
    ['sin piernas', 'TRAUMA'],
    ['el bus le cortó las piernas', 'TRAUMA'],
    ['perdió el brazo', 'TRAUMA'],
  ] as const)('detecta trauma catastrófico: %j', (text, expected) => {
    expect(classifyIncidentType(text)).toBe(expected);
  });
});

describe('classifyAllIncidentTypes', () => {
  it('devuelve TODOS los tipos que coinciden, no solo el primero', () => {
    const result = classifyAllIncidentTypes('está inconsciente y el bus le cortó las piernas');
    expect(result).toEqual(expect.arrayContaining(['UNCONSCIOUS', 'TRAUMA']));
  });

  it('devuelve arreglo vacío cuando no coincide nada', () => {
    expect(classifyAllIncidentTypes('una situación rara')).toEqual([]);
  });

  it('classifyIncidentType es el primer elemento de classifyAllIncidentTypes', () => {
    const text = 'choque con herida';
    expect(classifyIncidentType(text)).toBe(classifyAllIncidentTypes(text)[0] ?? null);
  });
});
