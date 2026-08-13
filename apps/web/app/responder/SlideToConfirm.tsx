'use client';

import { useState } from 'react';

/**
 * Confirmación por deslizamiento para acciones irreversibles (rechazar,
 * cerrar servicio). Un diálogo sí/no se toca sin querer en un vehículo en
 * movimiento; deslizar hasta el final es una intención inequívoca.
 */
export function SlideToConfirm({ label, onConfirm, disabled = false, large = false }: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  large?: boolean;
}) {
  const [value, setValue] = useState(0);
  const progress = value / 100;

  return (
    <label
      className={`relative flex flex-col justify-center overflow-hidden rounded-2xl border border-edge-strong
                 bg-surface-raised p-4 text-center shadow-sm transition-opacity
                 ${disabled ? 'opacity-50' : ''} ${large ? 'min-h-[22dvh]' : ''}`}
    >
      {/* Relleno que avanza con el dedo: confirma en tiempo real que el gesto
          está siendo captado, no solo al soltar. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 bg-emergency-soft"
        style={{ width: `${progress * 100}%`, transition: value === 0 ? 'width 150ms ease-out' : 'none' }}
      />
      <span className="relative mb-2 block text-sm font-bold uppercase tracking-[.12em] text-content">
        {label}
      </span>
      <input
        aria-label={label}
        className="relative h-16 w-full cursor-ew-resize accent-emergency disabled:opacity-50"
        disabled={disabled}
        max={100}
        min={0}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          setValue(next);
          if (next === 100) {
            onConfirm();
            setValue(0);
          }
        }}
        step={1}
        type="range"
        value={value}
      />
      <span className="relative block text-xs font-bold text-content-muted">
        DESLIZA HASTA EL FINAL →
      </span>
    </label>
  );
}
