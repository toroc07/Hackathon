from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any


# ============================================================
# CONFIGURACIÓN
# ============================================================

BASE_DIR = Path(__file__).resolve().parent.parent

GRAPH_FILE = BASE_DIR / "data" / "cartagena_graph.pkl"


# ============================================================
# CARGAR
# ============================================================

def load_graph():

    if not GRAPH_FILE.exists():

        raise FileNotFoundError(
            f"No existe:\n{GRAPH_FILE}"
        )

    with GRAPH_FILE.open(
        "rb"
    ) as file:

        return pickle.load(file)


# ============================================================
# GUARDAR
# ============================================================

def save_graph(
    graph,
):

    with GRAPH_FILE.open(
        "wb"
    ) as file:

        pickle.dump(
            graph,
            file,
            protocol=pickle.HIGHEST_PROTOCOL,
        )


# ============================================================
# VELOCIDAD MÍNIMA
# ============================================================

def minimum_speed(
    base_speed: float,
) -> float:

    return max(
        5.0,
        base_speed * 0.10,
    )


# ============================================================
# APLICAR VELOCIDAD
# ============================================================

def set_traffic_speed(
    edge,
    speed: float,
    source: str,
):

    base_speed = edge[
        "speed"
    ]

    speed = max(
        minimum_speed(
            base_speed
        ),
        speed,
    )

    speed = min(
        speed,
        base_speed,
    )

    edge[
        "traffic_speed"
    ] = speed

    edge[
        "traffic_factor"
    ] = (
        speed / base_speed
    )

    edge[
        "traffic_source"
    ] = source


# ============================================================
# TRÁFICO NORMAL
# ============================================================

def apply_normal_traffic(
    graph,
):

    factors = {

        "motorway": 0.90,
        "motorway_link": 0.90,

        "trunk": 0.90,
        "trunk_link": 0.90,

        "primary": 0.85,
        "primary_link": 0.85,

        "secondary": 0.88,
        "secondary_link": 0.88,

        "tertiary": 0.92,
        "tertiary_link": 0.92,

        "unclassified": 0.95,

        "residential": 0.95,

        "living_street": 0.95,

        "service": 0.95,
    }

    for _, _, edge in graph.edges(
        data=True
    ):

        highway = edge.get(
            "highway",
            "residential",
        )

        factor = factors.get(
            highway,
            0.90,
        )

        base_speed = edge[
            "speed"
        ]

        set_traffic_speed(
            edge,
            base_speed * factor,
            "simulation_normal",
        )


# ============================================================
# HORA PICO
# ============================================================

def apply_rush_hour(
    graph,
):

    factors = {

        "motorway": 0.65,
        "motorway_link": 0.60,

        "trunk": 0.60,
        "trunk_link": 0.55,

        "primary": 0.45,
        "primary_link": 0.40,

        "secondary": 0.55,
        "secondary_link": 0.50,

        "tertiary": 0.65,
        "tertiary_link": 0.60,

        "unclassified": 0.75,

        "residential": 0.80,

        "living_street": 0.85,

        "service": 0.75,
    }

    for _, _, edge in graph.edges(
        data=True
    ):

        highway = edge.get(
            "highway",
            "residential",
        )

        factor = factors.get(
            highway,
            0.70,
        )

        base_speed = edge[
            "speed"
        ]

        set_traffic_speed(
            edge,
            base_speed * factor,
            "simulation_rush_hour",
        )


# ============================================================
# INCIDENTE
# ============================================================

def apply_incident(
    graph,
    road_name: str,
    speed_factor: float = 0.15,
):
    """
    Simula un accidente/obstrucción.

    Todas las carreteras cuyo nombre coincida
    recibirán una reducción fuerte de velocidad.
    """

    affected = 0

    for _, _, edge in graph.edges(
        data=True
    ):

        name = edge.get(
            "name"
        )

        if not name:
            continue

        if (
            str(name).lower()
            != road_name.lower()
        ):
            continue

        base_speed = edge[
            "speed"
        ]

        set_traffic_speed(
            edge,
            base_speed * speed_factor,
            "simulation_incident",
        )

        affected += 1

    return affected


# ============================================================
# INCIDENTE POR ROAD ID
# ============================================================

def apply_incident_by_id(
    graph,
    road_id: str,
    speed_factor: float = 0.10,
):

    affected = 0

    for _, _, edge in graph.edges(
        data=True
    ):

        if str(
            edge.get(
                "road_id"
            )
        ) != str(road_id):

            continue

        base_speed = edge[
            "speed"
        ]

        set_traffic_speed(
            edge,
            base_speed * speed_factor,
            "simulation_incident",
        )

        affected += 1

    return affected


# ============================================================
# INFORMACIÓN
# ============================================================

def traffic_level(
    factor: float,
):

    if factor >= 0.85:
        return "LIBRE"

    if factor >= 0.65:
        return "LIGERO"

    if factor >= 0.45:
        return "MODERADO"

    if factor >= 0.25:
        return "PESADO"

    return "MUY PESADO"


# ============================================================
# RESUMEN
# ============================================================

def traffic_summary(
    graph,
):

    result = {
        "LIBRE": 0,
        "LIGERO": 0,
        "MODERADO": 0,
        "PESADO": 0,
        "MUY PESADO": 0,
    }

    for _, _, edge in graph.edges(
        data=True
    ):

        factor = edge.get(
            "traffic_factor",
            1.0,
        )

        level = traffic_level(
            factor
        )

        result[level] += 1

    return result


# ============================================================
# DEMO
# ============================================================

def main():

    print("=" * 70)
    print(
        " CARTAGENA TRAFFIC ENGINE"
    )
    print("=" * 70)

    graph = load_graph()

    print()
    print(
        "Aplicando tráfico de hora pico..."
    )

    apply_rush_hour(
        graph
    )

    summary = traffic_summary(
        graph
    )

    print()

    for level, count in summary.items():

        print(
            f"{level:12} "
            f"{count:,} aristas"
        )

    save_graph(
        graph
    )

    print()
    print(
        "✓ Tráfico actualizado."
    )

    print(
        "✓ Fuente: simulation_rush_hour"
    )

    print("=" * 70)


if __name__ == "__main__":
    main()