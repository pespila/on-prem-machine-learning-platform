"""Deploy worker — stages MLflow artifacts to platform-data, starts the serving container.

The Deployment row carries every field the serving container needs
(``model_kind``, ``serving_image_uri``, and after the snapshot copy
``storage_path``). MLflow owns the artifact blob; this worker pulls it
down into ``/var/platform-data/deployments/{deployment_id}/`` so the
serving container keeps its existing read-only bind-mount loader path.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import structlog

from aipacken import storage
from aipacken.config import get_settings
from aipacken.db.models import Deployment
from aipacken.docker_client.builder_client import get_builder_client
from aipacken.docker_client.traefik_sync import sync_model_routes
from aipacken.services import mlflow_client
from aipacken.services.redis_client import publish

logger = structlog.get_logger(__name__)


def _stage_artifacts(
    deployment_id: str,
    platform_run_id: str,
    model_kind: str,
) -> tuple[str | None, dict[str, Any] | None]:
    """Pull the MLflow run's ``artifacts/`` tree down to platform-data.

    Returns ``(relative_model_path, input_schema_dict)``:
      * ``relative_model_path`` — the file (or dir, for AutoGluon) the
        serving container should load via MODEL_STORAGE_PATH.
      * ``input_schema_dict`` — the parsed input_schema.json so the
        deployments router's /schema endpoint can serve it without a
        disk read or a live probe.
    """
    dst = storage.deployment_dir(deployment_id)
    dst.mkdir(parents=True, exist_ok=True)

    # ``artifact_path="artifacts"`` pulls the whole subtree in one shot;
    # MLflow lands it at ``<dst>/artifacts/...`` on disk.
    local = mlflow_client.download_run_artifacts(
        platform_run_id=platform_run_id,
        dst_dir=str(dst),
        artifact_path="artifacts",
    )
    if local is None:
        return None, None

    artifacts_dir = Path(local)
    if not artifacts_dir.exists():
        return None, None

    # Model file / dir: for sklearn-flavored runs there's ``model.pkl`` +
    # its ``.sig`` alongside; for AutoGluon there's a directory.
    model_rel: str | None = None
    if model_kind.lower() == "autogluon":
        for child in artifacts_dir.iterdir():
            if child.is_dir():
                model_rel = storage.to_relative(child)
                break
    else:
        pkl = artifacts_dir / "model.pkl"
        if pkl.exists():
            model_rel = storage.to_relative(pkl)

    # Input schema is small — parse it so the router doesn't have to.
    schema_obj: dict[str, Any] | None = None
    schema_path = artifacts_dir / "input_schema.json"
    if schema_path.exists():
        try:
            schema_obj = json.loads(schema_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            logger.info(
                "deploy_model.schema_parse_failed",
                deployment_id=deployment_id,
                error=str(exc),
            )
    return model_rel, schema_obj


async def deploy_model(ctx: dict[str, Any], deployment_id: str) -> dict[str, Any]:
    session_factory = ctx["session_factory"]
    settings = get_settings()

    async with session_factory() as db:
        dep = await db.get(Deployment, deployment_id)
        if dep is None:
            return {"status": "missing"}
        if not dep.run_id:
            dep.status = "failed"
            await db.commit()
            return {"status": "failed", "reason": "deployment_missing_run_id"}

        dep.status = "deploying"
        await db.commit()
        await publish(f"deployment:{deployment_id}:events", {"status": "deploying"})

        # Stage artifacts from MLflow into the read-only volume the
        # serving container mounts. Idempotent — re-deploys can rerun
        # this safely; download_artifacts overwrites existing files.
        try:
            model_rel, input_schema = await asyncio.to_thread(
                _stage_artifacts, dep.id, dep.run_id, dep.model_kind
            )
        except Exception as exc:
            logger.exception("deploy_model.stage_failed")
            dep.status = "failed"
            await db.commit()
            return {"status": "failed", "error": f"stage_failed:{exc}"}

        if model_rel is None:
            dep.status = "failed"
            await db.commit()
            return {"status": "failed", "reason": "model_artifact_not_found"}

        dep.storage_path = model_rel
        if input_schema is not None:
            dep.input_schema_json = input_schema
        await db.commit()

        # AutoGluon ships its own serving image (pinned sklearn / numpy
        # / pandas don't match the base serving pyproject); route by kind.
        if dep.serving_image_uri:
            image = dep.serving_image_uri
        elif (dep.model_kind or "").lower() == "autogluon":
            image = settings.serving_base_autogluon_image
        else:
            image = settings.serving_base_image
        env = {
            "MODEL_STORAGE_PATH": dep.storage_path,
            "MODEL_KIND": dep.model_kind,
            "DATA_ROOT": settings.data_root,
            "DEPLOYMENT_ID": dep.id,
            "INTERNAL_INGEST_URL": "http://api:8000/api/internal/predictions",
            "INTERNAL_HMAC_TOKEN": settings.internal_hmac_token,
        }
        labels = {"platform.deployment_id": dep.id}

        builder = get_builder_client()
        container_name = f"model-{dep.slug}"
        try:
            res = await builder.run(
                image=image,
                env=env,
                memory_bytes=2 * 1024 * 1024 * 1024,
                nano_cpus=1_000_000_000,
                network=settings.models_network,
                labels=labels,
                mounts=[
                    {
                        "source": "platform-data",
                        "target": settings.data_root,
                        "read_only": True,
                    }
                ],
                name=container_name,
                hostname=container_name,
            )
        except Exception as exc:
            logger.exception("deploy_model.run_failed")
            dep.status = "failed"
            # Best-effort clean-up of the staged dir so a retry starts fresh.
            try:
                shutil.rmtree(storage.deployment_dir(dep.id), ignore_errors=True)
            except OSError as cleanup_exc:
                logger.info(
                    "deploy_model.cleanup_failed",
                    deployment_id=dep.id,
                    error=str(cleanup_exc),
                )
            await db.commit()
            return {"status": "failed", "error": str(exc)}

        container_id = res["container_id"]
        internal_url = f"http://model-{dep.slug}:8000"

        ready = False
        async with httpx.AsyncClient(timeout=5.0) as client:
            for _ in range(30):
                try:
                    r = await client.get(f"{internal_url}/ready")
                    if r.status_code == 200:
                        ready = True
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(2)

        dep.container_id = container_id
        dep.internal_url = internal_url
        dep.endpoint_url = f"/models/{dep.slug}"
        dep.status = "active" if ready else "unhealthy"
        dep.last_health_at = datetime.now(UTC)
        await db.commit()

        try:
            await sync_model_routes(db)
        except Exception:
            logger.exception("deploy_model.traefik_sync_failed")

        await publish(f"deployment:{deployment_id}:events", {"status": dep.status})
        return {"status": dep.status, "container_id": container_id}
