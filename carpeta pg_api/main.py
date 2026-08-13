"""
API genérica para tu base Postgres.

Al arrancar, se conecta a la base, detecta todas las tablas existentes
(usando SQLAlchemy automap) y genera endpoints CRUD para cada una:

    GET    /{tabla}            -> lista registros (con paginación)
    GET    /{tabla}/{id}       -> un registro por su primary key
    POST   /{tabla}            -> crea un registro
    PUT    /{tabla}/{id}       -> actualiza un registro
    DELETE /{tabla}/{id}       -> borra un registro

No necesitás escribir modelos a mano: si agregás una tabla nueva en
Postgres, con reiniciar la API ya aparece disponible.

Correr con:  uvicorn main:app --reload
Docs interactivas en: http://127.0.0.1:8000/docs
"""

from typing import Any
from fastapi import FastAPI, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from sqlalchemy.ext.automap import automap_base
from sqlalchemy.orm import Session
from sqlalchemy import inspect

from database import engine, SessionLocal

app = FastAPI(title="API para tu base Postgres")

# --- Reflejar el esquema existente ---
Base = automap_base()
Base.prepare(autoload_with=engine)

# Tablas protegidas: el backend Next.js (apps/web/src/server/modules/**) es la
# ÚNICA fuente de verdad para su escritura. En particular `assignments` solo se
# modifica dentro de la transacción atómica de dispatch/internal/assignment.ts
# (UPDATE condicional + índices únicos parciales que impiden la doble
# asignación). Un PUT/DELETE genérico aquí se saltaría esa transacción, la
# máquina de estados (assertTransition) y la auditoría en incident_events —
# exactamente lo que esas capas existen para impedir.
#
# Esta API sigue sirviendo para inspeccionar catálogo (zones, facilities) sin
# abrir una puerta trasera al núcleo del sistema. Si necesitas mutar una de
# estas tablas, hazlo a través de la API de Next.js, no de aquí.
TABLAS_PROTEGIDAS = {
    "assignments",
    "vehicles",
    "incidents",
    "incident_reports",
    "incident_events",
    "dispatch_runs",
    "dispatch_candidates",
    "vehicle_locations",
    "vehicle_current_location",
    "shifts",
}

# Diccionario {nombre_tabla: clase_mapeada}, excluyendo las protegidas.
tablas = {
    nombre: modelo
    for nombre, modelo in Base.classes.items()
    if nombre not in TABLAS_PROTEGIDAS
}

if not list(tablas):
    raise RuntimeError(
        "No se encontraron tablas con primary key en la base. "
        "SQLAlchemy automap solo mapea tablas que tengan PK definida."
    )


def row_to_dict(obj: Any) -> dict:
    """Convierte una fila mapeada de SQLAlchemy en un dict serializable."""
    return {c.key: getattr(obj, c.key) for c in inspect(obj).mapper.column_attrs}


def get_pk_column(modelo):
    """Devuelve el nombre de la columna primary key de la tabla."""
    pk_cols = inspect(modelo).primary_key
    if len(pk_cols) != 1:
        return None  # no soportamos PK compuestas en los endpoints genéricos
    return pk_cols[0].name


for nombre_tabla, modelo in tablas.items():

    def make_routes(nombre_tabla=nombre_tabla, modelo=modelo):
        pk_name = get_pk_column(modelo)

        @app.get(f"/{nombre_tabla}", tags=[nombre_tabla], summary=f"Listar {nombre_tabla}")
        def listar(skip: int = 0, limit: int = Query(default=50, le=500)):
            db: Session = SessionLocal()
            try:
                registros = db.query(modelo).offset(skip).limit(limit).all()
                return jsonable_encoder([row_to_dict(r) for r in registros])
            finally:
                db.close()

        if pk_name:

            @app.get(f"/{nombre_tabla}/{{item_id}}", tags=[nombre_tabla], summary=f"Obtener un {nombre_tabla}")
            def obtener(item_id: str):
                db: Session = SessionLocal()
                try:
                    registro = db.query(modelo).get(item_id)
                    if registro is None:
                        raise HTTPException(status_code=404, detail=f"{nombre_tabla} no encontrado")
                    return jsonable_encoder(row_to_dict(registro))
                finally:
                    db.close()

            @app.put(f"/{nombre_tabla}/{{item_id}}", tags=[nombre_tabla], summary=f"Actualizar un {nombre_tabla}")
            def actualizar(item_id: str, cambios: dict):
                db: Session = SessionLocal()
                try:
                    registro = db.query(modelo).get(item_id)
                    if registro is None:
                        raise HTTPException(status_code=404, detail=f"{nombre_tabla} no encontrado")
                    for campo, valor in cambios.items():
                        if hasattr(registro, campo):
                            setattr(registro, campo, valor)
                    db.commit()
                    db.refresh(registro)
                    return jsonable_encoder(row_to_dict(registro))
                finally:
                    db.close()

            @app.delete(f"/{nombre_tabla}/{{item_id}}", tags=[nombre_tabla], summary=f"Borrar un {nombre_tabla}")
            def borrar(item_id: str):
                db: Session = SessionLocal()
                try:
                    registro = db.query(modelo).get(item_id)
                    if registro is None:
                        raise HTTPException(status_code=404, detail=f"{nombre_tabla} no encontrado")
                    db.delete(registro)
                    db.commit()
                    return {"detail": f"{nombre_tabla} eliminado"}
                finally:
                    db.close()

        @app.post(f"/{nombre_tabla}", tags=[nombre_tabla], summary=f"Crear un {nombre_tabla}", status_code=201)
        def crear(datos: dict):
            db: Session = SessionLocal()
            try:
                nuevo = modelo(**datos)
                db.add(nuevo)
                db.commit()
                db.refresh(nuevo)
                return jsonable_encoder(row_to_dict(nuevo))
            except TypeError as e:
                raise HTTPException(status_code=422, detail=f"Campos inválidos: {e}")
            finally:
                db.close()

    make_routes()


@app.get("/", summary="Listado de tablas disponibles")
def raiz():
    return {"tablas_disponibles": list(tablas.keys())}
