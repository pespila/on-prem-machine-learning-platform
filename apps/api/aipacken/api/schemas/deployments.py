from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class DeploymentCreate(BaseModel):
    """Pick a platform Run (or its MLflow ModelVersion) to deploy.

    After Batch 35b the API doesn't mint a separate DB ModelVersion row
    per train_run — MLflow's registry owns that. Clients send the
    platform ``run_id`` they want deployed; the server resolves the
    MLflow registered-model name + version number and snapshots both on
    the Deployment row so the worker can stage artifacts without another
    MLflow round-trip.
    """

    model_config = ConfigDict(protected_namespaces=())

    run_id: str
    name: str
    replicas: int = 1
    audit_payloads: bool = False


class DeploymentUpdate(BaseModel):
    name: str | None = None
    audit_payloads: bool | None = None


class DeploymentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: str
    run_id: str
    # mlflow_run_id stays on the DB column for worker lookups but is
    # NOT serialized — the UI has no use for it and exposing it leaks
    # the MLflow-side run identifier to clients.
    registered_model_name: str | None = None
    version_number: int | None = None
    model_kind: str = "sklearn"
    name: str
    slug: str
    status: str
    container_id: str | None = None
    host_port: int | None = None
    endpoint_url: str | None = None
    internal_url: str | None = None
    replicas: int
    audit_payloads: bool
    last_health_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    # NULL → active. NOT NULL → moved to Trash (container stopped, route
    # freed). The hard purge endpoint wipes the row + staged dir.
    trashed_at: datetime | None = None

    # UI-facing convenience field: the public URL external callers POST to.
    # Populated by the router; not stored on the table.
    url: str = ""
    last_called_at: datetime | None = None
    # Bytes occupied by the staged artifacts dir under
    # /var/platform-data/deployments/{id}/. Populated only on the trashed
    # listing and on the trashed detail view — du-style scan, skipped for
    # active rows where the value would just be operational noise.
    disk_bytes: int | None = None


class DeploymentList(BaseModel):
    items: list[DeploymentRead]
    total: int


class PredictRequest(BaseModel):
    inputs: dict[str, Any] | list[dict[str, Any]]


class PredictResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    prediction: Any
    prediction_label: str | None = None
    target_classes: list[str] | None = None
    model_version: str | None = None
    trace_id: str | None = None
