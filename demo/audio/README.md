# Prototipo: Reporte de emergencia por voz

Móvil-first (iOS/Android), sin dependencias, todo vanilla HTML/CSS/JS.
Demo autocontenida del bot de emergencias: graba audio (micrófono real si se permite, sino genera una señal audible), valida duración mínima (2 s) y máxima (2 min), simula envío con confirmación e incidente, y guarda el último reporte en `localStorage`.

## Cómo probar

Abre `demo/audio/index.html` en un navegador (Chrome/Edge/Safari), o sirve la carpeta:

```sh
npx serve demo/audio
```

## Comportamiento

| Estado            | UI                                            |
|-------------------|-----------------------------------------------|
| Idle              | Botón gris, "Presiona para grabar"            |
| Grabando          | Pulso rojo + onda + cronómetro (auto-corte 2 min) |
| Enviando          | Spinner "Enviando reporte…"                   |
| Confirmado        | ✅ "Emergencia reportada" + número de incidente |
| Error / offline   | ⚠️ mensaje + botón "Reintentar envío"          |

## Notas de implementación

- `getUserMedia` se usa solo como mejora: si el permiso se deniega o no existe, se sintetiza un WAV 16-bit/22 kHz reproducible (beeps estilo despacho + tonos de marcado) para que siempre haya audio audible.
- El envío es simulado (promesa). Para integrarlo a producción, reemplaza `submitReport()` por un `fetch` al backend.
- Ubicación: usa Geolocation si está disponible; fallback a «Cra 13 # 26-45, Cartagena», editable con el botón CAMBIAR.
- `navigator.vibrate()` en inicio/fin de grabación (requiere dispositivo con vibración).

## Entregables

- `index.html` — estructura
- `styles.css` — tema oscuro (`#000000`), acentos ámbar `#FF6B35`
- `app.js` — lógica de estados, audio, persistencia y geolocalización
