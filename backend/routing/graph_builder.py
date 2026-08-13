from __future__ import annotations

import json
import math
import pickle
from pathlib import Path
from typing import Any

import networkx as nx
from shapely.geometry import LineString, Point, MultiPoint
from shapely.ops import split
from shapely.strtree import STRtree


# ============================================================
# CONFIGURACIÓN
# ============================================================

BASE_DIR = Path(__file__).resolve().parent.parent

INPUT_FILE = BASE_DIR / "data" / "carreteras.geojson"
OUTPUT_FILE = BASE_DIR / "data" / "cartagena_graph.pkl"


# ============================================================
# TIPOS DE VÍAS PERMITIDOS
# ============================================================

ALLOWED_HIGHWAYS = {
    "motorway",
    "motorway_link",

    "trunk",
    "trunk_link",

    "primary",
    "primary_link",

    "secondary",
    "secondary_link",

    "tertiary",
    "tertiary_link",

    "unclassified",

    "residential",
    "living_street",

    "service",
}


# ============================================================
# VELOCIDADES POR DEFECTO
# ============================================================

DEFAULT_SPEEDS = {
    "motorway": 80,
    "motorway_link": 60,

    "trunk": 70,
    "trunk_link": 50,

    "primary": 60,
    "primary_link": 50,

    "secondary": 50,
    "secondary_link": 40,

    "tertiary": 40,
    "tertiary_link": 35,

    "unclassified": 35,

    "residential": 30,
    "living_street": 20,

    "service": 20,
}


# ============================================================
# DISTANCIA HAVERSINE
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

    delta_lat = math.radians(
        lat2 - lat1
    )

    delta_lon = math.radians(
        lon2 - lon1
    )

    a = (
        math.sin(delta_lat / 2) ** 2
        +
        math.cos(lat1_rad)
        *
        math.cos(lat2_rad)
        *
        math.sin(delta_lon / 2) ** 2
    )

    c = 2 * math.atan2(
        math.sqrt(a),
        math.sqrt(1 - a),
    )

    return earth_radius * c


# ============================================================
# VELOCIDAD
# ============================================================

def parse_speed(
    value: Any,
    highway: str,
) -> float:

    if value is None:
        return DEFAULT_SPEEDS.get(
            highway,
            30,
        )

    try:

        if isinstance(
            value,
            (int, float),
        ):
            return float(value)

        text = (
            str(value)
            .strip()
            .lower()
        )

        if "mph" in text:

            number = float(
                text
                .replace("mph", "")
                .strip()
            )

            return number * 1.60934

        number = ""

        for character in text:

            if (
                character.isdigit()
                or character == "."
            ):
                number += character

            elif number:
                break

        if number:
            return float(number)

    except (
        ValueError,
        TypeError,
    ):
        pass

    return DEFAULT_SPEEDS.get(
        highway,
        30,
    )


# ============================================================
# ONEWAY
# ============================================================

def normalize_oneway(
    value: Any,
) -> str:

    if value is None:
        return "no"

    value = (
        str(value)
        .strip()
        .lower()
    )

    if value in {
        "yes",
        "true",
        "1",
    }:
        return "yes"

    if value == "-1":
        return "-1"

    return "no"


# ============================================================
# COORDENADA
# ============================================================

def coordinate_key(
    lon: float,
    lat: float,
) -> tuple[float, float]:

    return (
        round(float(lon), 7),
        round(float(lat), 7),
    )


# ============================================================
# CARGAR CARRETERAS
# ============================================================

def load_roads():

    print()
    print("Cargando carreteras...")
    print(
        f"Archivo: {INPUT_FILE}"
    )

    if not INPUT_FILE.exists():

        raise FileNotFoundError(
            f"No existe:\n{INPUT_FILE}"
        )

    with INPUT_FILE.open(
        "r",
        encoding="utf-8",
    ) as file:

        data = json.load(file)

    features = data.get(
        "features",
        [],
    )

    print(
        f"Elementos encontrados: "
        f"{len(features):,}"
    )

    roads = []

    for feature in features:

        geometry = feature.get(
            "geometry"
        )

        properties = feature.get(
            "properties",
            {},
        )

        if not geometry:
            continue

        if geometry.get(
            "type"
        ) != "LineString":

            continue

        highway = properties.get(
            "highway"
        )

        if highway not in ALLOWED_HIGHWAYS:
            continue

        coordinates = geometry.get(
            "coordinates",
            [],
        )

        if len(coordinates) < 2:
            continue

        try:

            line = LineString(
                [
                    (
                        float(point[0]),
                        float(point[1]),
                    )
                    for point in coordinates
                ]
            )

        except (
            ValueError,
            TypeError,
        ):
            continue

        if line.is_empty:
            continue

        if line.length <= 0:
            continue

        roads.append(
            {
                "line": line,
                "properties": properties,
            }
        )

    print(
        f"Carreteras utilizables: "
        f"{len(roads):,}"
    )

    return roads


# ============================================================
# DETECTAR Y CREAR SEGMENTOS
# ============================================================

def split_roads(
    roads,
):

    print()
    print(
        "Detectando intersecciones..."
    )

    lines = [
        road["line"]
        for road in roads
    ]

    tree = STRtree(lines)

    segments = []

    total = len(roads)

    for index, road in enumerate(
        roads,
        start=1,
    ):

        line = road["line"]

        properties = road["properties"]

        # ----------------------------------------------------
        # Buscar líneas cercanas/intersectantes
        # ----------------------------------------------------

        candidate_indices = tree.query(
            line
        )

        split_points = []

        for candidate_index in candidate_indices:

            candidate_index = int(
                candidate_index
            )

            # No necesitamos comparar consigo misma.
            if candidate_index == (
                index - 1
            ):
                continue

            other_line = lines[
                candidate_index
            ]

            try:

                intersection = (
                    line.intersection(
                        other_line
                    )
                )

            except Exception:
                continue

            if intersection.is_empty:
                continue

            # ------------------------------------------------
            # Punto
            # ------------------------------------------------

            if intersection.geom_type == "Point":

                point = intersection

                if (
                    point.distance(
                        Point(line.coords[0])
                    ) > 1e-9
                    and
                    point.distance(
                        Point(line.coords[-1])
                    ) > 1e-9
                ):

                    split_points.append(
                        point
                    )

            # ------------------------------------------------
            # MultiPoint
            # ------------------------------------------------

            elif intersection.geom_type == "MultiPoint":

                for point in intersection.geoms:

                    if (
                        point.distance(
                            Point(line.coords[0])
                        ) > 1e-9
                        and
                        point.distance(
                            Point(line.coords[-1])
                        ) > 1e-9
                    ):

                        split_points.append(
                            point
                        )

        # ----------------------------------------------------
        # Dividir carretera
        # ----------------------------------------------------

        try:

            if split_points:

                # Eliminar puntos duplicados
                unique_points = {}

                for point in split_points:

                    key = (
                        round(point.x, 9),
                        round(point.y, 9),
                    )

                    unique_points[key] = point

                splitter = MultiPoint(
                    list(
                        unique_points.values()
                    )
                )

                result = split(
                    line,
                    splitter,
                )

                pieces = list(
                    result.geoms
                )

            else:

                pieces = [line]

        except Exception:

            pieces = [line]

        # ----------------------------------------------------
        # Guardar segmentos
        # ----------------------------------------------------

        for piece in pieces:

            if piece.length <= 0:
                continue

            coords = list(
                piece.coords
            )

            if len(coords) < 2:
                continue

            segments.append(
                {
                    "line": piece,
                    "properties": properties,
                }
            )

        # ----------------------------------------------------
        # Progreso
        # ----------------------------------------------------

        if (
            index % 500 == 0
            or index == total
        ):

            print(
                f"  Procesadas "
                f"{index:,}/{total:,} "
                f"carreteras | "
                f"segmentos: "
                f"{len(segments):,}"
            )

    print()
    print(
        f"Segmentos finales: "
        f"{len(segments):,}"
    )

    return segments


# ============================================================
# CONSTRUIR GRAFO
# ============================================================

def build_graph(
    segments,
):

    print()
    print(
        "Construyendo grafo dirigido..."
    )

    graph = nx.DiGraph()

    for segment in segments:

        line = segment["line"]

        properties = segment[
            "properties"
        ]

        coords = list(
            line.coords
        )

        start = coords[0]
        end = coords[-1]

        start_node = coordinate_key(
            start[0],
            start[1],
        )

        end_node = coordinate_key(
            end[0],
            end[1],
        )

        if start_node == end_node:
            continue

        # ----------------------------------------------------
        # Datos de la carretera
        # ----------------------------------------------------

        highway = properties.get(
            "highway",
            "unclassified",
        )

        name = properties.get(
            "name"
        )

        ref = properties.get(
            "ref"
        )

        oneway = normalize_oneway(
            properties.get(
                "oneway"
            )
        )

        speed = parse_speed(
            properties.get(
                "maxspeed"
            ),
            highway,
        )

        # ----------------------------------------------------
        # Distancia real del segmento
        # ----------------------------------------------------

        distance = 0.0

        for i in range(
            len(coords) - 1
        ):

            lon1, lat1 = coords[i]
            lon2, lat2 = coords[i + 1]

            distance += haversine(
                lat1,
                lon1,
                lat2,
                lon2,
            )

        if distance <= 0:
            continue

        # ----------------------------------------------------
        # Tiempo base
        # ----------------------------------------------------

        travel_time = (
            distance
            /
            1000
            /
            speed
            *
            3600
        )

        # ----------------------------------------------------
        # Crear nodos
        # ----------------------------------------------------

        graph.add_node(
            start_node,
            lat=start_node[1],
            lon=start_node[0],
        )

        graph.add_node(
            end_node,
            lat=end_node[1],
            lon=end_node[0],
        )

        road_id = properties.get(
            "@id"
        )

        if road_id is None:

            road_id = properties.get(
                "id"
            )

        if road_id is None:

            road_id = (
                f"{highway}:"
                f"{start_node[0]:.7f}:"
                f"{start_node[1]:.7f}:"
                f"{end_node[0]:.7f}:"
                f"{end_node[1]:.7f}"
            )


        edge_data = {
            "road_id": str(road_id),

            "distance": distance,

            "speed": speed,

            "travel_time": travel_time,

            "highway": highway,

            "name": name,

            "ref": ref,

            "oneway": oneway,

            "traffic_speed": speed,

            "traffic_factor": 1.0,

            "traffic_source": "default",
        }

        # ----------------------------------------------------
        # SENTIDO NORMAL
        # ----------------------------------------------------

        if oneway != "-1":

            graph.add_edge(
                start_node,
                end_node,
                **edge_data,
            )

        # ----------------------------------------------------
        # SENTIDO INVERSO
        #
        # OSM oneway=-1 significa que el sentido
        # permitido es contrario a la geometría.
        # ----------------------------------------------------

        if oneway == "-1":

            graph.add_edge(
                end_node,
                start_node,
                **edge_data,
            )

        # ----------------------------------------------------
        # CALLE DE DOBLE SENTIDO
        # ----------------------------------------------------

        elif oneway != "yes":

            graph.add_edge(
                end_node,
                start_node,
                **edge_data,
            )

    print()
    print(
        f"Nodos: "
        f"{graph.number_of_nodes():,}"
    )

    print(
        f"Aristas: "
        f"{graph.number_of_edges():,}"
    )

    return graph


# ============================================================
# GUARDAR
# ============================================================

def save_graph(
    graph,
):

    OUTPUT_FILE.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with OUTPUT_FILE.open(
        "wb",
    ) as file:

        pickle.dump(
            graph,
            file,
            protocol=pickle.HIGHEST_PROTOCOL,
        )

    print()
    print(
        "✓ Grafo guardado:"
    )

    print(
        OUTPUT_FILE
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 70)
    print(
        " CARTAGENA AMBULANCE ROUTING ENGINE"
    )
    print(
        " CONSTRUCTOR DEL GRAFO VIAL"
    )
    print("=" * 70)

    roads = load_roads()

    segments = split_roads(
        roads
    )

    graph = build_graph(
        segments
    )

    save_graph(
        graph
    )

    print()
    print("=" * 70)
    print(
        "✓ GRAFO RECONSTRUIDO CORRECTAMENTE"
    )
    print("=" * 70)


if __name__ == "__main__":
    main()