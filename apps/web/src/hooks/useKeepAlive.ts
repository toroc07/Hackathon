'use client';

import { useEffect } from 'react';

/** Marca en `sessionStorage`: una pestaña, un calentamiento. */
const SESSION_KEY = 'dispatch:warmed';

/**
 * Calienta los servicios en capa gratuita al abrir la app.
 *
 * El cron de GitHub Actions (.github/workflows/keepalive.yml) es la defensa
 * principal, pero los `schedule` de GitHub llegan tarde con frecuencia. Esto
 * cubre el hueco: si alguien abre la app justo cuando Render acaba de dormirse,
 * los ~50 s de arranque transcurren mientras lee la pantalla, no mientras
 * espera a que la IA conteste o a que aparezca la ruta.
 *
 * Dispara y olvida: no bloquea el render, no muestra errores y no reintenta.
 * Si falla, cada pantalla ya degrada por su cuenta (la ruta cae a línea recta,
 * la llamada avisa de que no hay servicio).
 */
export function useKeepAlive(): void {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch {
      // Modo privado sin sessionStorage: se calienta igual, solo que en cada
      // carga. Es peor, pero no es motivo para no calentar.
    }

    void fetch('/api/keepalive', { cache: 'no-store', keepalive: true }).catch(() => {});
  }, []);
}
