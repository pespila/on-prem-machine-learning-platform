from __future__ import annotations

import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from aipacken import storage
from aipacken.api.authz import (
    get_owned_deployment,
    get_owned_run,
    scope_deployment_by_user,
)
from aipacken.api.pagination import Pagination, pagination_params
from aipacken.api.ratelimit import PREDICT_LIMIT, rate_limit
from aipacken.api.schemas.deployments import (
    DeploymentCreate,
    DeploymentList,
    DeploymentRead,
    DeploymentUpdate,
    PredictResponse,
)
from aipacken.db import get_db
from aipacken.db.models import Deployment, Run, User
from aipacken.jobs.queue import enqueue
from aipacken.services import mlflow_client
from aipacken.services.auth import get_current_user
from aipacken.services.redis_client import publish

router = APIRouter(prefix="/deployments", tags=["deployments"])

_log = structlog.get_logger(__name__)


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"{s}-{uuid.uuid4().hex[:8]}" if s else f"model-{uuid.uuid4().hex[:8]}"


def _dir_size_bytes(path: Path) -> int | None:
    """Return the total bytes occupied by *path*, or None if missing.

    Best-effort: any unreadable child is skipped silently. Symlinks are
    not followed (the staged dir never contains them in practice and we'd
    rather under-count than escape the data root).
    """
    if not path.exists():
        return None
    total = 0
    try:
        for entry in path.rglob("*"):
            try:
                if entry.is_file() and not entry.is_symlink():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        return None
    return total


def _to_read(dep: Deployment, *, with_disk: bool = False) -> DeploymentRead:
    out = DeploymentRead.model_validate(dep)
    out.url = f"/api/deployments/{dep.id}/predict"
    if with_disk:
        out.disk_bytes = _dir_size_bytes(storage.deployment_dir(dep.id))
    return out


async def _stop_container_best_effort(dep: Deployment) -> None:
    """Stop + remove the serving container if one exists. Logs and
    swallows transport errors — a stale container shouldn't block the
    state transition that brought us here (trash, restore, purge)."""
    if not dep.container_id:
        return
    from aipacken.docker_client.builder_client import get_builder_client

    try:
        await get_builder_client().stop(dep.container_id, timeout=10)
    except (httpx.HTTPError, OSError) as exc:
        _log.warning(
            "deployment.stop_failed",
            deployment_id=dep.id,
            container_id=dep.container_id,
            error=str(exc),
        )


@router.post("", response_model=DeploymentRead, status_code=201)
async def create_deployment(
    payload: DeploymentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeploymentRead:
    """Deploy the MLflow model attached to a platform Run.

    Resolves the MLflow ModelVersion by looking up the Run's
    ``platform.run_id`` tag in the registry — the trainer registers
    exactly one version per successful run. The Deployment row
    snapshots ``(registered_model_name, version_number, mlflow_run_id,
    model_kind)`` so the serving worker can stage artifacts without a
    round-trip to MLflow.
    """
    run = await get_owned_run(db, payload.run_id, user)

    mlflow_run = mlflow_client.find_run_by_platform_id(run.id)
    if mlflow_run is None:
        raise HTTPException(status_code=404, detail="mlflow_run_not_found")

    # Find the MLflow ModelVersion produced by this run. The trainer
    # tags it with ``platform.run_id``; we search for matching versions
    # across every registered model (there's only one per run in practice).
    candidate_name: str | None = None
    candidate_version: int | None = None
    tags = dict(mlflow_run.data.tags or {})
    model_kind = tags.get("platform.model_kind") or "sklearn"
    registered_name_tag = tags.get("platform.registered_model_name")
    if registered_name_tag:
        mvs = mlflow_client.search_model_versions(registered_name_tag)
        for mv in mvs:
            if mv.run_id == mlflow_run.info.run_id:
                candidate_name = registered_name_tag
                candidate_version = int(mv.version)
                break
    if candidate_name is None:
        # Fall back to a wider scan.
        for rm in mlflow_client.list_registered_models():
            for mv in mlflow_client.search_model_versions(rm.name):
                if mv.run_id == mlflow_run.info.run_id:
                    candidate_name = rm.name
                    candidate_version = int(mv.version)
                    break
            if candidate_name is not None:
                break
    if candidate_name is None or candidate_version is None:
        raise HTTPException(status_code=409, detail="run_has_no_registered_model_version")

    dep = Deployment(
        run_id=run.id,
        mlflow_run_id=mlflow_run.info.run_id,
        registered_model_name=candidate_name,
        version_number=candidate_version,
        model_kind=model_kind,
        name=payload.name,
        slug=_slugify(payload.name),
        status="pending",
        replicas=payload.replicas,
        audit_payloads=payload.audit_payloads,
    )
    db.add(dep)
    await db.commit()
    await db.refresh(dep)
    await enqueue("deploy_model", dep.id)
    return _to_read(dep)


@router.get("", response_model=DeploymentList)
async def list_deployments(
    trashed: bool = False,
    pagination: Pagination = Depends(pagination_params),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeploymentList:
    """List deployments. ``trashed=false`` (default) returns active rows;
    ``trashed=true`` returns the Trash view (soft-deleted, awaiting
    restore or hard purge). The Trash view also computes per-row disk
    footprint so the UI can show how much disk a purge would free."""
    base = scope_deployment_by_user(select(Deployment), user)
    count_base = scope_deployment_by_user(select(func.count(Deployment.id)), user)
    if trashed:
        base = base.where(Deployment.trashed_at.is_not(None)).order_by(
            Deployment.trashed_at.desc()
        )
        count_base = count_base.where(Deployment.trashed_at.is_not(None))
    else:
        base = base.where(Deployment.trashed_at.is_(None)).order_by(
            Deployment.created_at.desc()
        )
        count_base = count_base.where(Deployment.trashed_at.is_(None))

    stmt = base.limit(pagination.limit).offset(pagination.offset)
    rows = (await db.execute(stmt)).scalars().all()
    total = (await db.execute(count_base)).scalar_one()
    return DeploymentList(
        items=[_to_read(r, with_disk=trashed) for r in rows], total=total
    )


@router.get("/{deployment_id}", response_model=DeploymentRead)
async def get_deployment(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeploymentRead:
    dep = await get_owned_deployment(db, deployment_id, user)
    # Compute disk footprint only when it matters (the row is in trash and
    # the UI is about to offer a "Delete forever / X MB" button). Active
    # rows skip the rglob to keep the detail endpoint cheap.
    return _to_read(dep, with_disk=dep.trashed_at is not None)


@router.patch("/{deployment_id}", response_model=DeploymentRead)
async def update_deployment(
    deployment_id: str,
    payload: DeploymentUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeploymentRead:
    dep = await get_owned_deployment(db, deployment_id, user)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="name_must_not_be_empty")
        dep.name = name
    if payload.audit_payloads is not None:
        dep.audit_payloads = payload.audit_payloads
    await db.commit()
    await db.refresh(dep)
    return _to_read(dep)


@router.delete("/{deployment_id}", status_code=204, response_class=Response)
async def delete_deployment(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Move a deployment to Trash.

    Stops the serving container (best-effort), syncs Traefik so the route
    is freed immediately, and flips ``trashed_at``. The DB row and the
    staged artifacts dir under ``/var/platform-data/deployments/{id}/``
    are preserved so Restore can re-deploy without re-staging from MLflow.

    To wipe disk + row, the client follows up with ``DELETE /{id}/purge``
    from the Trash view.
    """
    from aipacken.docker_client.traefik_sync import sync_model_routes

    dep = await get_owned_deployment(db, deployment_id, user)
    if dep.trashed_at is not None:
        # Already trashed — make the operation idempotent so a double-click
        # or a retry from a flaky network doesn't 404 the second time.
        return Response(status_code=204)

    await _stop_container_best_effort(dep)

    dep.status = "trashed"
    dep.trashed_at = datetime.now(UTC)
    dep.container_id = None
    dep.internal_url = None
    await db.commit()

    try:
        await sync_model_routes(db)
    except Exception:
        _log.exception("deployment.trash.traefik_sync_failed", deployment_id=dep.id)
    await publish(
        f"deployment:{dep.id}:events", {"status": "trashed"}
    )
    return Response(status_code=204)


@router.post("/{deployment_id}/restore", response_model=DeploymentRead)
async def restore_deployment(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeploymentRead:
    """Bring a trashed deployment back online.

    Clears ``trashed_at`` and re-enqueues ``deploy_model``. The worker is
    idempotent: if the staged dir is still present it'll reuse it; if it
    was hand-cleaned (or the dir was never staged), it'll re-pull from
    MLflow. Either way the user gets back a running container under the
    same slug, which means the same Traefik route.
    """
    dep = await get_owned_deployment(db, deployment_id, user)
    if dep.trashed_at is None:
        raise HTTPException(status_code=409, detail="deployment_not_trashed")

    dep.trashed_at = None
    dep.status = "pending"
    await db.commit()
    await db.refresh(dep)
    await enqueue("deploy_model", dep.id)
    return _to_read(dep)


@router.delete("/{deployment_id}/purge", status_code=204, response_class=Response)
async def purge_deployment(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Hard-delete a trashed deployment: wipe staged artifacts + row.

    Refuses to purge an active deployment — Trash is a deliberate two-step
    so a stray click can't take down a serving container *and* erase the
    artifacts behind it in a single request.
    """
    dep = await get_owned_deployment(db, deployment_id, user)
    if dep.trashed_at is None:
        raise HTTPException(status_code=409, detail="deployment_must_be_trashed_first")

    # Defensive: if a redeploy raced past the trashed_at check (shouldn't
    # happen, but a queued deploy_model could have flipped container_id
    # while the row was trashed by a concurrent request), make sure the
    # container is gone before we drop the row. Best-effort.
    await _stop_container_best_effort(dep)

    staged = storage.deployment_dir(dep.id)
    try:
        shutil.rmtree(staged, ignore_errors=True)
    except OSError as exc:
        # ignore_errors=True catches almost everything, but rmtree itself
        # can raise on racy fs unmounts. Log and continue — leaving the
        # row alive while the dir lingers is worse than the inverse.
        _log.warning(
            "deployment.purge.rmtree_failed",
            deployment_id=dep.id,
            path=str(staged),
            error=str(exc),
        )

    await db.delete(dep)
    await db.commit()
    return Response(status_code=204)


@router.get("/{deployment_id}/schema")
async def get_deployment_schema(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return the deployment's input schema.

    Prefers the live serving container's `/schema` when it's reachable,
    so any feature-name normalization it does shows up in the UI. Falls
    back to the trainer-produced `input_schema.json` on disk.
    """
    dep = await get_owned_deployment(db, deployment_id, user)

    if dep.status == "active" and dep.internal_url:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"{dep.internal_url}/schema")
                if r.status_code == 200:
                    body = r.json()
                    return body.get("input") if isinstance(body, dict) and "input" in body else body
        except httpx.HTTPError:
            pass

    if dep.input_schema_json:
        return dep.input_schema_json

    run = await db.get(Run, dep.run_id)
    if run is not None:
        schema_path = storage.run_artifacts_dir(run.id) / "input_schema.json"
        if schema_path.exists():
            import json as _json

            try:
                return _json.loads(schema_path.read_text())
            except (OSError, _json.JSONDecodeError):
                # Malformed / missing schema file — fall through to the
                # empty-object default. Logged elsewhere by the trainer.
                pass

    return {"type": "object", "properties": {}, "additionalProperties": True}


@router.get("/{deployment_id}/logs")
async def get_deployment_logs(
    deployment_id: str,
    tail: int = 500,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, str]]:
    """Tail of the serving container's stdout/stderr, shaped for the UI."""
    import json as _json
    from datetime import datetime as _dt

    dep = await get_owned_deployment(db, deployment_id, user)
    if not dep.container_id:
        return []

    from aipacken.docker_client.builder_client import get_builder_client

    try:
        res = await get_builder_client().logs(dep.container_id, tail=tail)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"builder_unreachable: {exc}") from exc

    out: list[dict[str, str]] = []
    for raw in res.get("lines", []):
        raw = str(raw).strip()
        if not raw:
            continue
        if raw.startswith("{"):
            try:
                parsed = _json.loads(raw)
                if isinstance(parsed, dict):
                    out.append(
                        {
                            "ts": str(
                                parsed.get("ts")
                                or parsed.get("timestamp")
                                or _dt.now(UTC).isoformat()
                            ),
                            "level": str(parsed.get("level") or "info").lower(),
                            "message": str(parsed.get("message") or parsed.get("event") or raw),
                        }
                    )
                    continue
            except _json.JSONDecodeError:
                pass
        upper = raw.upper()
        level = "error" if "ERROR" in upper else ("warn" if "WARN" in upper else "info")
        out.append({"ts": _dt.now(UTC).isoformat(), "level": level, "message": raw})
    return out


@router.post(
    "/{deployment_id}/predict",
    response_model=PredictResponse,
    dependencies=[Depends(rate_limit(PREDICT_LIMIT))],
)
async def predict(
    deployment_id: str,
    payload: dict[str, Any],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PredictResponse:
    dep = await get_owned_deployment(db, deployment_id, user)
    if dep.status != "active" or not dep.internal_url:
        raise HTTPException(status_code=409, detail="deployment_not_ready")

    # Accept either {inputs: {...}} or a flat {feature: value, ...} dict; the
    # serving container's schema-driven Pydantic model expects the flat form.
    forwarded: Any = payload.get("inputs") if "inputs" in payload else payload

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.post(f"{dep.internal_url}/predict", json=forwarded)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"serving_error: {exc}") from exc
        body = r.json()

    return PredictResponse(
        prediction=body.get("prediction"),
        prediction_label=body.get("prediction_label"),
        target_classes=body.get("target_classes"),
        model_version=body.get("model_version"),
        trace_id=body.get("trace_id"),
    )
