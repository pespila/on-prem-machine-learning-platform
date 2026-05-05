"""Filesystem layout helpers for the platform-data volume.

The named ``platform-data`` volume carries:

  * ``datasets/{id}/``        — uploaded CSV/Parquet + profile JSON.
  * ``runs/{run_id}/``        — trainer scratch dirs (logs, local
                                artifact staging before MLflow upload).
  * ``deployments/{dep_id}/`` — artifacts staged from MLflow at deploy
                                time so the serving container loads
                                locally without speaking to MLflow.
  * ``packages/{pkg_id}*``    — build scratch + final tar.gz.

Heavy artifacts (``model.pkl``, SHAP/bias reports, metrics.jsonl) are
owned by MLflow and live in MinIO under the ``mlflow-artifacts``
bucket — fetched via the tracking server, not written here.
"""

from __future__ import annotations

from pathlib import Path

import structlog

from aipacken.config import get_settings

_log = structlog.get_logger(__name__)


def _root() -> Path:
    return Path(get_settings().data_root)


def data_root() -> Path:
    """Public handle for the ``/var/platform-data`` bind-mount root."""
    return _root()


def ensure_base_dirs() -> None:
    """Create the top-level layout once at startup.

    The platform-data volume is shared between the api/worker (running as
    root inside the container) and the trainer containers (running as uid
    10001 with no shared GID configured). Until there is a shared group
    (tracked follow-up: introduce an aipacken-data GID + switch to 2770),
    the only portable permission that lets both containers write into the
    per-run subdirectories is 0o777. S103 is suppressed inline because
    tightening this is a deploy-time choice, not a code change.
    """
    import os as _os

    root = _root()
    root.mkdir(parents=True, exist_ok=True)
    try:
        _os.chmod(root, 0o777)  # noqa: S103
    except OSError as exc:
        _log.warning("storage.chmod_failed", path=str(root), error=str(exc))
    for sub in ("datasets", "runs", "models", "packages"):
        p = root / sub
        p.mkdir(parents=True, exist_ok=True)
        try:
            _os.chmod(p, 0o777)  # noqa: S103
        except OSError as exc:
            _log.warning("storage.chmod_failed", path=str(p), error=str(exc))


# ---- dataset ----


def dataset_dir(dataset_id: str) -> Path:
    return _root() / "datasets" / dataset_id


def dataset_raw_dir(dataset_id: str) -> Path:
    return dataset_dir(dataset_id) / "raw"


def dataset_raw_path(dataset_id: str, filename: str) -> Path:
    return dataset_raw_dir(dataset_id) / filename


def dataset_profile_path(dataset_id: str) -> Path:
    return dataset_dir(dataset_id) / "profile.json"


# ---- run ----


def run_dir(run_id: str) -> Path:
    return _root() / "runs" / run_id


def deployment_dir(deployment_id: str) -> Path:
    """Staged-artifacts directory for a deployment.

    Single source of truth shared by ``deploy_model`` (which writes here)
    and the trash/purge endpoints (which size + delete it).
    """
    return _root() / "deployments" / deployment_id


def run_artifacts_dir(run_id: str) -> Path:
    return run_dir(run_id) / "artifacts"


def run_reports_dir(run_id: str) -> Path:
    return run_dir(run_id) / "reports"


def run_metrics_path(run_id: str) -> Path:
    return run_dir(run_id) / "metrics.jsonl"


def run_logs_path(run_id: str) -> Path:
    return run_dir(run_id) / "logs.jsonl"


def ensure_run_dirs(run_id: str) -> None:
    import os as _os

    for p in (run_dir(run_id), run_artifacts_dir(run_id), run_reports_dir(run_id)):
        p.mkdir(parents=True, exist_ok=True)
        try:
            _os.chmod(p, 0o777)  # noqa: S103 — see ensure_base_dirs() for rationale
        except OSError as exc:
            _log.warning("storage.chmod_failed", path=str(p), error=str(exc))


# ---- package ----


def package_dir(package_id: str) -> Path:
    """Scratch build directory for a single package under construction."""
    return _root() / "packages" / package_id


def package_tar_path(package_id: str) -> Path:
    """Final downloadable tar.gz lives next to the scratch dir so the DB's
    ``storage_path`` points at a single file the download endpoint streams."""
    return _root() / "packages" / f"{package_id}.tar.gz"


# ---- generic ----


def to_absolute(storage_path: str) -> Path:
    """Resolve a stored relative path (e.g. `runs/{id}/artifacts/model.pkl`) to disk."""
    p = Path(storage_path)
    if p.is_absolute():
        # Keep absolute paths inside the data_root; reject escapes.
        rooted = Path(get_settings().data_root).resolve()
        resolved = p.resolve()
        resolved.relative_to(rooted)  # raises ValueError if outside
        return resolved
    return (_root() / p).resolve()


def to_relative(absolute_path: Path) -> str:
    """Turn an in-volume absolute path into a stored relative path."""
    return str(absolute_path.relative_to(_root()))
