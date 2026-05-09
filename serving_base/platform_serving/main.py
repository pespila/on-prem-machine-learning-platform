"""Serving container FastAPI app.

Loads an MLflow model at startup, derives a Pydantic input model from the
captured JSON Schema and exposes JSON + batch prediction endpoints.
"""

from __future__ import annotations

import io
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import pandas as pd
import structlog
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

from platform_serving import __version__
from platform_serving.batch import iter_chunks
from platform_serving.loader import load as load_model
from platform_serving.logging_middleware import PredictionLogMiddleware
from platform_serving.schema import pydantic_from_schema


structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger("serving")


class PredictResponse(BaseModel):
    # `model_version` collides with Pydantic v2's reserved `model_` prefix;
    # opt out explicitly so container start-up doesn't spam a UserWarning.
    model_config = ConfigDict(protected_namespaces=())

    prediction: Any
    prediction_label: str | None = None
    target_classes: list[str] | None = None
    model_version: str
    trace_id: str


class HealthResponse(BaseModel):
    status: str
    version: str


class State:
    """Module-level mutable container; populated during lifespan startup."""

    model: Any = None
    input_schema: dict[str, Any] = {}
    output_schema: dict[str, Any] = {}
    input_model: type[BaseModel] | None = None
    sample_row: dict[str, Any] | None = None
    model_uri: str = ""
    target_classes: list[str] | None = None
    target_encoded: bool = False


state = State()


def _sample_row_from_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal valid row so /ready can do a real inference."""
    sample: dict[str, Any] = {}
    for name, spec in (schema.get("properties") or {}).items():
        if not isinstance(spec, dict):
            sample[name] = ""
            continue
        t = spec.get("type", "string")
        if isinstance(t, list):
            t = next((x for x in t if x != "null"), "string")
        if "enum" in spec and spec["enum"]:
            sample[name] = spec["enum"][0]
        elif t == "integer":
            sample[name] = 0
        elif t == "number":
            sample[name] = 0.0
        elif t == "boolean":
            sample[name] = False
        else:
            sample[name] = ""
    return sample


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    storage_path = os.environ.get("MODEL_STORAGE_PATH", "")
    state.model_uri = storage_path
    log.info("serving.startup", storage_path=storage_path)

    if not storage_path:
        # Allow the container to boot for /health checks even without a model,
        # so operators can diagnose misconfiguration.
        log.error("serving.no_storage_path")
        yield
        return

    try:
        model, input_schema, output_schema = load_model()
    except Exception as exc:
        log.error("serving.load_failed", error=str(exc))
        raise

    state.model = model
    state.input_schema = input_schema
    state.output_schema = output_schema
    state.input_model = pydantic_from_schema(input_schema, model_name="ModelInput")
    state.sample_row = _sample_row_from_schema(input_schema)
    raw_classes = input_schema.get("target_classes") if isinstance(input_schema, dict) else None
    if isinstance(raw_classes, list):
        state.target_classes = [str(c) for c in raw_classes]
    state.target_encoded = bool(input_schema.get("target_encoded")) if isinstance(input_schema, dict) else False
    log.info(
        "serving.ready",
        features=len(input_schema.get("properties") or {}),
        target_classes=len(state.target_classes or []),
    )
    yield
    log.info("serving.shutdown")


app = FastAPI(title="AIpacken Serving", version=__version__, lifespan=lifespan)
app.add_middleware(PredictionLogMiddleware)


def _predict_df(df: pd.DataFrame) -> pd.DataFrame:
    if state.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    preds = state.model.predict(df)
    if isinstance(preds, pd.DataFrame):
        return preds
    if isinstance(preds, pd.Series):
        return preds.to_frame(name="prediction")
    return pd.DataFrame({"prediction": list(preds)})


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@app.get("/ready", response_model=HealthResponse)
async def ready() -> HealthResponse:
    # Readiness only asserts the model deserialized and the FastAPI app is up.
    # We deliberately don't do a sample inference here: a trained model may
    # only accept a post-transform feature shape, and /ready must not fail
    # when a valid, deployable model can't be exercised with synthetic data.
    if state.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return HealthResponse(status="ready", version=__version__)


@app.get("/schema")
async def schema() -> dict[str, Any]:
    return {"input": state.input_schema, "output": state.output_schema}


@app.post("/predict", response_model=PredictResponse)
async def predict(request: Request) -> PredictResponse:
    if state.input_model is None or state.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    raw = await request.json()
    try:
        parsed = state.input_model(**(raw if isinstance(raw, dict) else {}))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    df = pd.DataFrame([parsed.model_dump()])
    result = _predict_df(df)
    prediction_value = result.iloc[0].to_dict() if result.shape[1] > 1 else result.iloc[0, 0]
    coerced = _coerce_json(prediction_value)

    # Decode integer class indices to the original label when the trainer
    # stashed a class list. We apply this when `target_encoded` is set, OR
    # when a class list is present and the class labels themselves look
    # non-numeric (so a legacy schema missing the flag still round-trips).
    prediction_label: str | None = None
    if state.target_classes and isinstance(coerced, (int, float)):
        apply = state.target_encoded
        if not apply:
            non_numeric = any(
                not (c.replace(".", "", 1).lstrip("-").isdigit())
                for c in state.target_classes
            )
            apply = non_numeric
        if apply:
            try:
                idx = int(coerced)
                if 0 <= idx < len(state.target_classes):
                    prediction_label = state.target_classes[idx]
            except (TypeError, ValueError):
                prediction_label = None

    return PredictResponse(
        prediction=coerced,
        prediction_label=prediction_label,
        target_classes=state.target_classes,
        model_version=state.model_uri,
        trace_id=request.headers.get("x-trace-id", str(uuid.uuid4())),
    )


@app.post("/predict/batch")
async def predict_batch(file: UploadFile = File(...)) -> StreamingResponse:
    if state.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    async def _stream() -> AsyncIterator[bytes]:
        first = True
        try:
            for chunk in iter_chunks(file, chunk_size=1000):
                preds = _predict_df(chunk)
                merged = chunk.reset_index(drop=True).join(preds.reset_index(drop=True), rsuffix="_pred")
                buf = io.StringIO()
                merged.to_csv(buf, index=False, header=first)
                yield buf.getvalue().encode("utf-8")
                first = False
        except ValueError as exc:
            # Uncaught ValueErrors here usually come from an unknown file type.
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    headers = {"content-disposition": "attachment; filename=predictions.csv"}
    return StreamingResponse(_stream(), media_type="text/csv", headers=headers)


@app.exception_handler(HTTPException)
async def _http_exc_handler(request: Request, exc: HTTPException) -> JSONResponse:  # noqa: ARG001
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


def _coerce_json(value: Any) -> Any:
    """Ensure numpy/pandas scalars serialize cleanly."""
    try:
        import numpy as np

        if isinstance(value, (np.generic,)):
            return value.item()
    except Exception:
        pass
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    return value
