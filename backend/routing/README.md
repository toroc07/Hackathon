# Servicio de rutas — Cartagena

A* sobre el grafo vial de OpenStreetMap. Es lo que hace que el mapa de la app
dibuje la ruta real por calles (como Uber/inDriver) en vez de una línea recta.

## Poner en marcha

```bash
pip install -r requirements.txt

# 1. Construir el grafo desde data/carreteras.geojson (~1 min, una sola vez).
#    Produce data/cartagena_graph.pkl (~12 MB), que está en .gitignore:
#    es un artefacto derivado, no fuente.
python graph_builder.py

# 2. Levantar el servicio (por defecto en :4002).
python routing_service.py
```

Comprobar:

```bash
curl "http://127.0.0.1:4002/health"
curl "http://127.0.0.1:4002/route?fromLat=10.3996&fromLng=-75.5140&toLat=10.4140&toLng=-75.4960"
```

## Cómo lo consume la app

`apps/web/app/api/routing/route.ts` hace de proxy y lee la URL de
`ROUTING_SERVICE_URL` (por defecto `http://127.0.0.1:4002`). Si el servicio no
responde a tiempo, la app degrada a una línea recta con el mismo modelo de ETA
del despacho y la UI lo dice: la etiqueta del mapa pasa de «Ruta por calles» a
«Trayecto estimado». **El despacho no depende de este servicio**: si se cae, se
sigue asignando y siguiendo la ambulancia igual.

En producción hay que definir `ROUTING_SERVICE_URL` en el entorno de Vercel.
Como el `.pkl` no está versionado, el despliegue debe correr `graph_builder.py`
antes de arrancar:

```
Build:  pip install -r requirements.txt && python graph_builder.py
Start:  uvicorn routing_service:app --host 0.0.0.0 --port $PORT
```

El arranque carga los 25k nodos en memoria, así que el primer despertar en frío
tarda unos segundos: por eso el servicio entra en el keep-alive
(`.github/workflows/keepalive.yml` y `/api/keepalive`).

## Archivos

| Archivo | Qué hace |
|---|---|
| `graph_builder.py` | GeoJSON de OSM → grafo dirigido con sentidos y velocidades |
| `astar.py` | A* con coste temporal; respeta `traffic_speed` si existe |
| `traffic.py` | Ajusta `traffic_speed` de las aristas por perfiles de tráfico |
| `routing_service.py` | API HTTP: índice espacial para el snapping + caché de rutas |
