'use client';

import { useState } from 'react';

export function SlideToConfirm({ label, onConfirm, disabled = false, large = false }: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  large?: boolean;
}) {
  const [value, setValue] = useState(0);
  return (
    <label className={`flex flex-col justify-center rounded-2xl border-2 border-red-400 bg-red-950 p-3 text-center ${large ? 'min-h-[32dvh]' : ''}`}>
      <span className="mb-2 block text-sm font-black uppercase tracking-widest text-red-100">{label}</span>
      <input
        aria-label={label}
        className="h-16 w-full cursor-ew-resize accent-red-500 disabled:opacity-50"
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
      <span className="block text-xs font-bold text-red-200">DESLIZA HASTA EL FINAL →</span>
    </label>
  );
}
