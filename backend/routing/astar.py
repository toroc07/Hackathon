from __future__ import annotations

import heapq
import math
import pickle
from pathlib import Path
from typing import Any


# ============================================================
# CONFIGURACIÓN
# ============================================================

BASE_DIR = Path(__file__).resolve().parent.parent

GRAPH_FILE = BASE_DIR / "data" / "cartagena_graph.pkl"

HEURISTIC_SPEED_KMH = 100.0


# ============================================================
# CARGAR GRAFO
# ============================================================

def load_graph() -> dict[str, Any]:

    if not GRAPH_FILE.exists():
        raise FileNotFoundError(
            f"No existe el grafo:\n{GRAPH_FILE}"
        )

    with GRAPH_FILE.open("rb") as file:
        graph = pickle.load(file)

    return graph


# ============================================================
# HAVERSINE
# ============================================================

def haversine(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:

    earth_radius = 6_371_000

    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)

    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad)
        * math.cos(lat2_rad)
        * math.sin(delta_lon / 2) ** 2
    )

    c = 2 * math.atan2(
        math.sqrt(a),
        math.sqrt(1 - a),
    )

    return earth_radius * c


# ============================================================
# NODO MÁS CERCANO
# ============================================================

def nearest_node(
    graph,
    latitude: float,
    longitude: float,
):

    closest_node = None
    closest_distance = float("inf")

    for node, data in graph.nodes(data=True):

        distance = haversine(
            latitude,
            longitude,
            data["lat"],
            data["lon"],
        )

        if distance < closest_distance:

            closest_distance = distance
            closest_node = node

    if closest_node is None:
        raise RuntimeError(
            "El grafo no contiene nodos."
        )

    return closest_node, closest_distance


# ============================================================
# HEURÍSTICA
# ============================================================

def heuristic(
    graph,
    node_a,
    node_b,
):

    data_a = graph.nodes[node_a]
    data_b = graph.nodes[node_b]

    distance = haversine(
        data_a["lat"],
        data_a["lon"],
        data_b["lat"],
        data_b["lon"],
    )

    speed_mps = (
        HEURISTIC_SPEED_KMH
        * 1000
        / 3600
    )

    return distance / speed_mps


# ============================================================
# COSTO DE UNA CARRETERA
# ============================================================

def get_edge_cost(edge_data) -> float:
    """
    Devuelve el tiempo actual de recorrer una carretera.

    Si traffic_speed existe, utilizamos esa velocidad.

    De esta manera A* no necesita saber nada sobre el
    sistema de tráfico.
    """

    distance = edge_data["distance"]

    traffic_speed = edge_data.get(
        "traffic_speed"
    )

    if (
        traffic_speed is None
        or traffic_speed <= 0
    ):
        traffic_speed = edge_data["speed"]

    speed_mps = (
        traffic_speed
        * 1000
        / 3600
    )

    return distance / speed_mps


# ============================================================
# A*
# ============================================================

def astar(
    graph,
    start,
    goal,
):

    if start not in graph:
        raise ValueError(
            "El nodo inicial no existe."
        )

    if goal not in graph:
        raise ValueError(
            "El nodo destino no existe."
        )

    open_set = []

    counter = 0

    initial_h = heuristic(
        graph,
        start,
        goal,
    )

    heapq.heappush(
        open_set,
        (
            initial_h,
            counter,
            start,
        ),
    )

    g_score = {
        start: 0.0
    }

    came_from = {}

    closed_set = set()

    nodes_processed = 0

    while open_set:

        (
            _,
            _,
            current,
        ) = heapq.heappop(
            open_set
        )

        if current in closed_set:
            continue

        closed_set.add(current)

        nodes_processed += 1

        # ----------------------------------------------------
        # DESTINO
        # ----------------------------------------------------

        if current == goal:

            path = reconstruct_path(
                came_from,
                current,
            )

            return {
                "success": True,
                "path": path,
                "travel_time": g_score[current],
                "nodes_processed": nodes_processed,
            }

        # ----------------------------------------------------
        # VECINOS
        # ----------------------------------------------------

        for neighbor in graph.successors(
            current
        ):

            if neighbor in closed_set:
                continue

            edge_data = graph[
                current
            ][neighbor]

            edge_cost = get_edge_cost(
                edge_data
            )

            tentative_g = (
                g_score[current]
                + edge_cost
            )

            previous_g = g_score.get(
                neighbor,
                float("inf"),
            )

            if tentative_g >= previous_g:
                continue

            came_from[
                neighbor
            ] = (
                current,
                edge_data,
            )

            g_score[
                neighbor
            ] = tentative_g

            f_score = (
                tentative_g
                + heuristic(
                    graph,
                    neighbor,
                    goal,
                )
            )

            counter += 1

            heapq.heappush(
                open_set,
                (
                    f_score,
                    counter,
                    neighbor,
                ),
            )

    return {
        "success": False,
        "path": [],
        "travel_time": None,
        "nodes_processed": nodes_processed,
    }


# ============================================================
# RECONSTRUIR RUTA
# ============================================================

def reconstruct_path(
    came_from,
    current,
):

    path = []

    while current in came_from:

        previous, edge = came_from[
            current
        ]

        path.append(
            {
                "from": previous,
                "to": current,
                "data": edge,
            }
        )

        current = previous

    path.reverse()

    return path


# ============================================================
# DISTANCIA
# ============================================================

def calculate_distance(path):

    return sum(
        item["data"]["distance"]
        for item in path
    )


# ============================================================
# FORMATEAR TIEMPO
# ============================================================

def format_time(seconds):

    seconds = max(
        0,
        int(round(seconds)),
    )

    hours = seconds // 3600

    minutes = (
        seconds % 3600
    ) // 60

    seconds %= 60

    if hours:
        return (
            f"{hours} h "
            f"{minutes} min "
            f"{seconds} s"
        )

    if minutes:
        return (
            f"{minutes} min "
            f"{seconds} s"
        )

    return f"{seconds} s"


# ============================================================
# COORDENADAS DE LA RUTA
# ============================================================

def path_to_coordinates(
    graph,
    path,
):

    if not path:
        return []

    coordinates = []

    first = path[0]["from"]

    first_data = graph.nodes[first]

    coordinates.append(
        [
            first_data["lon"],
            first_data["lat"],
        ]
    )

    for item in path:

        node = item["to"]

        data = graph.nodes[node]

        coordinates.append(
            [
                data["lon"],
                data["lat"],
            ]
        )

    return coordinates


# ============================================================
# CALCULAR RUTA
# ============================================================

def calculate_route(
    graph,
    start_lat: float,
    start_lon: float,
    goal_lat: float,
    goal_lon: float,
):

    start_node, start_distance = nearest_node(
        graph,
        start_lat,
        start_lon,
    )

    goal_node, goal_distance = nearest_node(
        graph,
        goal_lat,
        goal_lon,
    )

    result = astar(
        graph,
        start_node,
        goal_node,
    )

    if not result["success"]:

        return {
            "success": False,
            "message": (
                "No existe una ruta."
            ),
        }

    path = result["path"]

    distance = calculate_distance(
        path
    )

    travel_time = result[
        "travel_time"
    ]

    coordinates = path_to_coordinates(
        graph,
        path,
    )

    return {
        "success": True,

        "start": {
            "latitude": start_lat,
            "longitude": start_lon,
        },

        "destination": {
            "latitude": goal_lat,
            "longitude": goal_lon,
        },

        "start_node": start_node,

        "goal_node": goal_node,

        "snap_distance_start": start_distance,

        "snap_distance_goal": goal_distance,

        "distance_meters": distance,

        "distance_km": distance / 1000,

        "travel_time_seconds": travel_time,

        "travel_time_formatted": format_time(
            travel_time
        ),

        "nodes_processed": result[
            "nodes_processed"
        ],

        "route": coordinates,
    }


# ============================================================
# PRUEBA
# ============================================================

def main():

    print("=" * 70)
    print(
        " CARTAGENA AMBULANCE ROUTING ENGINE"
    )
    print(
        " A* + DYNAMIC TRAFFIC TEST"
    )
    print("=" * 70)

    graph = load_graph()

    start_lat = 10.3996
    start_lon = -75.5140

    goal_lat = 10.4140
    goal_lon = -75.4960

    print()
    print(
        f"Origen: "
        f"{start_lat}, {start_lon}"
    )

    print(
        f"Destino: "
        f"{goal_lat}, {goal_lon}"
    )

    result = calculate_route(
        graph,
        start_lat,
        start_lon,
        goal_lat,
        goal_lon,
    )

    print()

    if not result["success"]:

        print(
            "❌",
            result["message"],
        )

        return

    print("=" * 70)
    print("✓ RUTA")
    print("=" * 70)

    print(
        f"Distancia: "
        f"{result['distance_km']:.2f} km"
    )

    print(
        f"Tiempo: "
        f"{result['travel_time_formatted']}"
    )

    print(
        f"Nodos procesados: "
        f"{result['nodes_processed']:,}"
    )

    print("=" * 70)


if __name__ == "__main__":
    main()