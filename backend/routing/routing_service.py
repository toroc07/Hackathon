"""
Servicio HTTP de rutas sobre el grafo vial de Cartagena.

Expone el A* de `astar.py` para que la app web dibuje la ruta REAL por calles
(como Uber/inDriver) en vez de una línea recta entre dos puntos.

    GET  /health                    -> estado + tamaño del grafo
    GET  /route?from_lat=..&...     -> ruta entre dos coordenadas
    POST /route                     -> lo mismo con cuerpo JSON

Correr con:  uvicorn routing_service:app --port 4002
(desde backend/routing, o `python routing_service.py`)

Dos cosas que este módulo añade sobre `astar.py` y que importan en vivo:

1. Índice espacial en rejilla para `nearest_node`. El barrido lineal de
   astar.py recorre los 25k nodos por cada extremo de cada petición; con dos
   paneles pidiendo ruta cada pocos segundos eso se nota. La rejilla mira solo
   los nodos de las celdas vecinas.

2. Caché de rutas por par de nodos ya "pegados" al grafo. El GPS de la
   ambulancia se mueve metro a metro, pero cae una y otra vez sobre el mismo
   nodo: recalcular el A* entero para el mismo par es trabajo tirado.
"""

from __future__ import annotations

import math
import os
import sys
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))

from astar import (  # noqa: E402
    GRAPH_FILE,
    astar,
    calculate_distance,
    format_time,
    haversine,
    load_graph,
    path_to_coordinates,
)


# ============================================================
# CONFIGURACIÓN
# ============================================================

PORT = int(os.environ.get("PORT", "4002"))

# Tamaño de celda de la rejilla, en grados. ~0.0045° ≈ 500 m: suficiente para
# que cada celda tenga unas pocas decenas de nodos.
CELL_SIZE = 0.0045

# Si el punto queda a más de esto del nodo vial más cercano, no es un fallo:
# en Cartagena hay zonas sin vía mapeada. Se avisa en la respuesta para que el
# cliente pueda decir "aproximado" en vez de mentir.
SNAP_WARNING_METERS = 300.0

# Nº de rutas cacheadas. Cada una son unos cientos de coordenadas.
ROUTE_CACHE_SIZE = 256


# ============================================================
# ESTADO DEL SERVICIO
# ============================================================

class RoutingEngine:
    """Grafo + índice espacial + caché. Se construye una vez al arrancar."""

    def __init__(self) -> None:
        self.graph: Any = None
        self.grid: dict[tuple[int, int], list] = {}
        self.cache: OrderedDict[tuple, dict] = OrderedDict()
        self.loaded_at: float | None = None

    # --------------------------------------------------------
    # CARGA
    # --------------------------------------------------------

    def load(self) -> None:
        started = time.time()

        if not GRAPH_FILE.exists():
            raise FileNotFoundError(
                f"No existe el grafo: {GRAPH_FILE}\n"
                "Constrúyelo con: python graph_builder.py"
            )

        self.graph = load_graph()
        self.build_grid()
        self.loaded_at = time.time()

        print(
            f"[routing] grafo listo: "
            f"{self.graph.number_of_nodes():,} nodos, "
            f"{self.graph.number_of_edges():,} aristas "
            f"({time.time() - started:.1f}s)"
        )

    def build_grid(self) -> None:
        grid: dict[tuple[int, int], list] = {}

        for node, data in self.graph.nodes(data=True):
            key = (
                int(math.floor(data["lat"] / CELL_SIZE)),
                int(math.floor(data["lon"] / CELL_SIZE)),
            )
            grid.setdefault(key, []).append((node, data["lat"], data["lon"]))

        self.grid = grid

    @property
    def ready(self) -> bool:
        return self.graph is not None

    # --------------------------------------------------------
    # NODO MÁS CERCANO (rejilla)
    # --------------------------------------------------------

    def nearest_node(self, latitude: float, longitude: float):
        """Anillos concéntricos de celdas hasta encontrar candidatos.

        Se expande un anillo EXTRA después del primer acierto: el nodo más
        cercano puede estar justo al otro lado del borde de la celda, y
        parar en el primer acierto devolvería un nodo peor.
        """
        center_row = int(math.floor(latitude / CELL_SIZE))
        center_col = int(math.floor(longitude / CELL_SIZE))

        best_node = None
        best_distance = float("inf")
        rings_after_hit = 0

        for radius in range(0, 40):
            found_here = False

            for row in range(center_row - radius, center_row + radius + 1):
                for col in range(center_col - radius, center_col + radius + 1):
                    # Solo el borde del anillo: el interior ya se miró.
                    if radius > 0 and (
                        abs(row - center_row) != radius
                        and abs(col - center_col) != radius
                    ):
                        continue

                    for node, node_lat, node_lon in self.grid.get((row, col), ()):
                        distance = haversine(latitude, longitude, node_lat, node_lon)
                        if distance < best_distance:
                            best_distance = distance
                            best_node = node
                            found_here = True

            if best_node is not None:
                rings_after_hit += 1
                if rings_after_hit >= 2 and not found_here:
                    break

        if best_node is None:
            raise HTTPException(
                status_code=503,
                detail="El grafo no tiene nodos cerca de esa coordenada.",
            )

        return best_node, best_distance

    # --------------------------------------------------------
    # RUTA
    # --------------------------------------------------------

    def route(
        self,
        from_lat: float,
        from_lng: float,
        to_lat: float,
        to_lng: float,
    ) -> dict:
        start_node, start_snap = self.nearest_node(from_lat, from_lng)
        goal_node, goal_snap = self.nearest_node(to_lat, to_lng)

        cache_key = (start_node, goal_node)
        cached = self.cache.get(cache_key)

        if cached is not None:
            self.cache.move_to_end(cache_key)
            result = dict(cached)
            result["cached"] = True
        else:
            found = astar(self.graph, start_node, goal_node)

            if not found["success"]:
                raise HTTPException(
                    status_code=422,
                    detail="No existe una ruta por calles entre esos dos puntos.",
                )

            path = found["path"]
            distance = calculate_distance(path)
            travel_time = found["travel_time"]

            result = {
                "coordinates": path_to_coordinates(self.graph, path),
                "distanceMeters": round(distance, 1),
                "durationSeconds": round(travel_time, 1),
                "durationText": format_time(travel_time),
                "nodesProcessed": found["nodes_processed"],
                "cached": False,
            }

            self.cache[cache_key] = result
            if len(self.cache) > ROUTE_CACHE_SIZE:
                self.cache.popitem(last=False)
            result = dict(result)

        # Los extremos reales se añaden FUERA de la caché: el nodo pegado es
        # el mismo, pero la coordenada exacta del GPS no, y la línea debe
        # salir del vehículo y terminar en el incidente, no en la esquina.
        result["coordinates"] = (
            [[from_lng, from_lat]] + result["coordinates"] + [[to_lng, to_lat]]
        )
        result["snapMeters"] = {
            "from": round(start_snap, 1),
            "to": round(goal_snap, 1),
        }
        result["approximate"] = (
            start_snap > SNAP_WARNING_METERS or goal_snap > SNAP_WARNING_METERS
        )
        result["source"] = "graph"

        return result


engine = RoutingEngine()


# ============================================================
# APP
# ============================================================

app = FastAPI(
    title="Cartagena routing service",
    description="A* sobre el grafo vial de OpenStreetMap de Cartagena.",
    version="1.0.0",
)

# La app web (Next.js) llama desde otro origen en desarrollo y desde el
# servidor en producción; abrir CORS aquí no expone nada: el servicio es de
# solo lectura y no toca la base de datos.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    engine.load()


class RouteRequest(BaseModel):
    from_lat: float = Field(..., ge=-90, le=90, alias="fromLat")
    from_lng: float = Field(..., ge=-180, le=180, alias="fromLng")
    to_lat: float = Field(..., ge=-90, le=90, alias="toLat")
    to_lng: float = Field(..., ge=-180, le=180, alias="toLng")

    model_config = {"populate_by_name": True}


@app.get("/health", summary="Estado del servicio")
def health() -> dict:
    """Sondeo barato: es también el destino del keep-alive.

    Devuelve 200 aunque el grafo no esté cargado, con `ok: false`, para que un
    monitor distinga "servicio caído" de "servicio arriba pero sin grafo".
    """
    return {
        "ok": engine.ready,
        "service": "routing-service",
        "nodes": engine.graph.number_of_nodes() if engine.ready else 0,
        "edges": engine.graph.number_of_edges() if engine.ready else 0,
        "cachedRoutes": len(engine.cache),
        "uptimeSeconds": round(time.time() - engine.loaded_at) if engine.loaded_at else 0,
    }


@app.get("/route", summary="Ruta entre dos coordenadas")
def get_route(
    from_lat: float = Query(..., ge=-90, le=90, alias="fromLat"),
    from_lng: float = Query(..., ge=-180, le=180, alias="fromLng"),
    to_lat: float = Query(..., ge=-90, le=90, alias="toLat"),
    to_lng: float = Query(..., ge=-180, le=180, alias="toLng"),
) -> dict:
    if not engine.ready:
        raise HTTPException(status_code=503, detail="El grafo aún no está cargado.")

    return engine.route(from_lat, from_lng, to_lat, to_lng)


@app.post("/route", summary="Ruta entre dos coordenadas (JSON)")
def post_route(body: RouteRequest) -> dict:
    if not engine.ready:
        raise HTTPException(status_code=503, detail="El grafo aún no está cargado.")

    return engine.route(body.from_lat, body.from_lng, body.to_lat, body.to_lng)


@app.get("/", summary="Índice")
def index() -> dict:
    return {
        "service": "routing-service",
        "endpoints": {
            "GET /health": "estado del servicio y tamaño del grafo",
            "GET /route?fromLat=&fromLng=&toLat=&toLng=": "ruta por calles",
            "POST /route": "lo mismo con cuerpo JSON",
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
