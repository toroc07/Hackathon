/**
 * Iconos vectoriales del sistema.
 *
 * Sustituyen a los emoji. Un emoji depende de la fuente del sistema: se ve
 * distinto en cada teléfono, no hereda el color del tema, no escala con los
 * tokens y algunos lectores de pantalla lo leen con nombres absurdos
 * ("cara con boca abierta") en medio de una emergencia.
 *
 * Convenciones: 24px por defecto, trazo 2, `currentColor` para que hereden el
 * color del contenedor y funcionen igual en cualquier superficie.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorativo por defecto: el significado lo da el texto o el aria-label
      // del control que lo contiene, no el icono.
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const MicIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <path d="M12 19v3" />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);

export const AmbulanceIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h11v9H3z" />
    <path d="M14 11h4l3 3v3h-7z" />
    <circle cx="7" cy="18.5" r="1.8" />
    <circle cx="17" cy="18.5" r="1.8" />
    <path d="M8.5 10.5v3M7 12h3" />
  </Icon>
);

export const CarCrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 15h16v3H4z" />
    <path d="M6 15l1.6-4.2A2 2 0 0 1 9.5 9.5h5a2 2 0 0 1 1.9 1.3L18 15" />
    <circle cx="7.5" cy="18.5" r="1.4" />
    <circle cx="16.5" cy="18.5" r="1.4" />
    <path d="M12 3v3M9 4.5l1.5 2M15 4.5l-1.5 2" />
  </Icon>
);

export const HeartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20s-7-4.6-7-9.4A4 4 0 0 1 12 8a4 4 0 0 1 7 2.6C19 15.4 12 20 12 20Z" />
    <path d="M8.5 12.5h2l1-2 1.5 3.5 1-1.5h1.5" />
  </Icon>
);

export const UnconsciousIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.5" cy="9" r="2.2" />
    <path d="M9 12h7a3 3 0 0 1 3 3v1H9z" />
    <path d="M4 16h15" />
    <path d="M4.5 6.5 6 8M8.5 6.5 7 8" />
  </Icon>
);

export const FallIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="16" cy="5.5" r="2.2" />
    <path d="M15 9 11 13l-4 1" />
    <path d="M13 11l1.5 4M11 13l-3 4" />
    <path d="M3 20h18" />
  </Icon>
);

export const LungsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v9" />
    <path d="M12 8c-1.5 0-2.5 1-2.5 2.5V13c0 3-1 5-3 5-1.4 0-2.5-1-2.5-2.6 0-3 1.5-6.4 3.5-8.4" />
    <path d="M12 8c1.5 0 2.5 1 2.5 2.5V13c0 3 1 5 3 5 1.4 0 2.5-1 2.5-2.6 0-3-1.5-6.4-3.5-8.4" />
  </Icon>
);

export const TraumaIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12h4l2-4 3 8 2-4h5" />
    <path d="M12 3v2M12 19v2" />
  </Icon>
);

export const SosIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </Icon>
);

export const LocationIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4 2.5 20h19L12 4Z" />
    <path d="M12 10v4M12 17v.5" />
  </Icon>
);

export const RetryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v5h-5" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 12 16-8-6 16-2.5-6.5L4 12Z" />
  </Icon>
);
