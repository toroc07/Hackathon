import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/** Tokens semánticos, no colores crudos: si el tema cambia, esto cambia con él
 *  sin tocar cada componente que lo usa. */
const variants: Record<Variant, string> = {
  primary: 'bg-emergency text-white hover:bg-emergency-hover active:bg-emergency-pressed',
  secondary: 'ring-1 ring-edge-strong bg-surface-raised text-content hover:ring-content-muted',
  danger: 'bg-emergency text-white hover:bg-emergency-hover active:bg-emergency-pressed',
  ghost: 'bg-transparent text-content-secondary hover:bg-surface-raised',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'primary', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        // 48px de piso: el mínimo de 44px de Apple asume que estás quieto;
        // aquí la persona puede estar en movimiento.
        'pressable inline-flex min-h-touch items-center justify-center rounded-sm px-4',
        'text-[15px] font-semibold transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        className,
      ].join(' ')}
      {...props}
    />
  );
});
