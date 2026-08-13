# API para tu base Postgres (Neon)

API genérica con FastAPI que detecta automáticamente las tablas de tu
base de datos y expone endpoints CRUD para cada una — no hace falta
escribir modelos a mano.

## 1. Instalar dependencias

```bash
python -m venv venv
source venv/bin/activate      # en Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Configurar la conexión

```bash
cp .env.example .env
```

Editá `.env` y pegá tu connection string completa (con la password real,
no la enmascarada). **No subas `.env` a git** — agregalo a `.gitignore`.

## 3. Correr la API

```bash
uvicorn main:app --reload
```

Abrí http://127.0.0.1:8000/docs para ver la documentación interactiva
(Swagger) con todos los endpoints generados según tus tablas reales.

## Cómo funciona

- `database.py` arma la conexión a Postgres usando SQLAlchemy, leyendo
  `DATABASE_URL` desde el `.env`.
- `main.py` usa `automap_base()` de SQLAlchemy para "leer" el esquema
  de tu base al arrancar y genera, para cada tabla con primary key:
  - `GET /{tabla}` — lista con paginación (`?skip=0&limit=50`)
  - `GET /{tabla}/{id}`
  - `POST /{tabla}`
  - `PUT /{tabla}/{id}`
  - `DELETE /{tabla}/{id}`

## Limitaciones a tener en cuenta

- Las tablas **sin primary key** no se mapean (SQLAlchemy automap las
  ignora) — solo generan el endpoint de listado (`GET`), no CRUD completo.
- Tablas con **primary key compuesta** (más de una columna) no tienen
  endpoints de `GET/{id}`, `PUT`, `DELETE` individuales en esta versión
  genérica — se podría extender si las necesitás.
- `POST`/`PUT` reciben el body como `dict` libre y lo aplican tal cual
  a las columnas — no valida tipos antes de escribir en la base. Para
  producción conviene definir modelos Pydantic explícitos por tabla
  (puedo ayudarte a generarlos si me pasás el nombre de las tablas
  que más te importan).
- Este diseño genérico es ideal para prototipar rápido o para uso
  interno. Si esta API va a estar expuesta públicamente, hay que
  sumarle autenticación (por ejemplo con `fastapi.security` + JWT) y
  restringir qué tablas/columnas se exponen.

## Seguridad

La password que compartiste en el connection string venía enmascarada
en tu mensaje, así que no llegó a quedar expuesta acá. De todos modos,
es buena práctica rotarla en el panel de Neon si alguna vez la pegás
completa en un chat, y siempre manejarla vía variables de entorno como
en este proyecto (nunca hardcodeada en el código).
