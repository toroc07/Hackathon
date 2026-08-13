import type { Config } from 'tailwindcss';

/**
 * Los colores mapean a los tokens semánticos de globals.css.
 *
 * Se usan nombres de ROL (surface, emergency, ok) y no de color (slate, rose):
 * un componente que dice `bg-emergency` sigue siendo correcto si mañana el rojo
 * cambia de tono; uno que dice `bg-rose-500` hay que ir a buscarlo.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--surface-base)',
          raised:  'var(--surface-raised)',
          overlay: 'var(--surface-overlay)',
          pressed: 'var(--surface-pressed)',
        },
        content: {
          DEFAULT:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted:     'var(--text-muted)',
        },
        emergency: {
          DEFAULT: 'var(--emergency)',
          hover:   'var(--emergency-hover)',
          pressed: 'var(--emergency-pressed)',
          soft:    'var(--emergency-soft)',
          ring:    'var(--emergency-ring)',
        },
        ok:   { DEFAULT: 'var(--ok)',   soft: 'var(--ok-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        edge: {
          subtle: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      spacing: {
        touch: 'var(--touch-min)',
        'touch-lg': 'var(--touch-comfort)',
      },
      transitionTimingFunction: {
        enter: 'var(--motion-enter)',
        exit:  'var(--motion-exit)',
      },
    },
  },
  plugins: [],
};

export default config;
