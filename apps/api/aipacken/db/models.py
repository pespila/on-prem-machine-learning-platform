from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from aipacken.db.base import Base, IdMixin, TimestampsMixin

# Portable JSON column type: JSONB on Postgres (GIN-indexable, compact
# binary), plain JSON on SQLite (test-only). Having one definition keeps
# the test env from needing the JSONB → JSON monkey-patch that lived in
# tests/conftest.py.
JsonColumn = JSON().with_variant(JSONB, "postgresql")


class User(Base, IdMixin, TimestampsMixin):
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    # Default is 'member', not 'admin'. A freshly-created user should have
    # the least privilege that still lets them log in; the seeded platform
    # admin is assigned 'admin' explicitly by seed_admin.py. Previously
    # defaulting to 'admin' meant any bug that bypassed seed_admin would
    # mint a privileged account.
    role: Mapped[str] = mapped_column(String(32), default="member", nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)


class Dataset(Base, IdMixin, TimestampsMixin):
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(512), nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    col_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    checksum: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="uploaded", nullable=False)
    profile_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    profile_summary_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)


class FeatureSchema(Base, IdMixin, TimestampsMixin):
    dataset_id: Mapped[str] = mapped_column(
        ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    column_name: Mapped[str] = mapped_column(String(255), nullable=False)
    inferred_type: Mapped[str] = mapped_column(String(64), nullable=False)
    semantic_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stats_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)
    missing_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    unique_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        UniqueConstraint("dataset_id", "column_name", name="uq_feature_schema_dataset_column"),
    )


class TransformConfig(Base, IdMixin, TimestampsMixin):
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    target_column: Mapped[str] = mapped_column(String(255), nullable=False)
    transforms_json: Mapped[dict[str, Any]] = mapped_column(
        JsonColumn, nullable=False, default=dict
    )
    split_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn, nullable=False, default=dict)
    sensitive_features: Mapped[list[str] | None] = mapped_column(JsonColumn, nullable=True)


class ModelCatalogEntry(Base, IdMixin, TimestampsMixin):
    kind: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    framework: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    signature_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn, nullable=False, default=dict)
    origin: Mapped[str] = mapped_column(String(64), default="builtin", nullable=False)
    image_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)


class Experiment(Base, IdMixin, TimestampsMixin):
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class Run(Base, IdMixin, TimestampsMixin):
    experiment_id: Mapped[str] = mapped_column(
        ForeignKey("experiments.id"), nullable=False, index=True
    )
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), nullable=False)
    transform_config_id: Mapped[str] = mapped_column(
        ForeignKey("transform_configs.id"), nullable=False
    )
    model_catalog_id: Mapped[str] = mapped_column(
        ForeignKey("model_catalog_entrys.id"), nullable=False
    )
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    container_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False, index=True)
    hyperparams_json: Mapped[dict[str, Any]] = mapped_column(
        JsonColumn, nullable=False, default=dict
    )
    resource_limits_json: Mapped[dict[str, Any]] = mapped_column(
        JsonColumn, nullable=False, default=dict
    )
    # First-class fields that used to live under reserved keys inside
    # hyperparams_json (_task / _hpo / _roles). Nullable for back-compat
    # with existing rows; see migration 0004_run_task_hpo_roles.
    task: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hpo_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)
    roles_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# Metric + Artifact tables were dropped in migration 0007_mlflow_a — MLflow
# owns run metrics (with full step-series) and artifact storage (via MinIO).
# Reads: aipacken.services.mlflow_client.get_run_metrics / list_run_artifacts.
# Writes: trainer_base/platform_trainer/mlflow_sink.py.


# RegisteredModel + ModelVersion were dropped in migration 0008_mlflow_b.
# MLflow's built-in Model Registry is the source of truth for registered
# models, versions, and alias-based promotion (staging/production/…).
# Reads: aipacken.services.mlflow_client.list_registered_models / get_*.
# Writes: trainer_base (on training success) + promotion endpoint.


class Deployment(Base, IdMixin, TimestampsMixin):
    # run_id is the authoritative owner-chain anchor — everything else is
    # snapshotted off the MLflow ModelVersion that was active at deploy-time
    # so neither the worker nor the serving loader needs to round-trip to
    # MLflow to figure out where the artifact lives.
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    registered_model_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    version_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_kind: Mapped[str] = mapped_column(String(64), default="sklearn", nullable=False)
    # Local cache of the MLflow artifact under /var/platform-data so the
    # serving container keeps its existing MODEL_STORAGE_PATH bind-mount
    # contract — deploy_model downloads from MLflow into this path on first
    # run and reuses it on subsequent starts.
    storage_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    serving_image_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    input_schema_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    slug: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    container_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    host_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    endpoint_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    internal_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    replicas: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    api_key_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    audit_payloads: Mapped[bool] = mapped_column(default=False, nullable=False)
    last_health_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Soft-delete marker. NULL = active. NOT NULL = the row is in Trash:
    # the container has been stopped + Traefik route freed, but the staged
    # artifacts dir is kept on disk so Restore can re-deploy without
    # re-staging from MLflow. Hard purge wipes the dir + row.
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Prediction(Base, IdMixin):
    deployment_id: Mapped[str] = mapped_column(
        ForeignKey("deployments.id", ondelete="CASCADE"), nullable=False
    )
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    mode: Mapped[str] = mapped_column(String(32), default="online", nullable=False)
    input_ref: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    output_ref: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    input_preview_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)
    output_preview_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)

    __table_args__ = (Index("ix_prediction_deployment_received", "deployment_id", "received_at"),)


# DataLineage, BiasReport, ExplanationArtifact were dropped in migration
# 0007_mlflow_a. DataLineage was dead schema (never populated). Bias and
# SHAP are emitted by the trainer as JSON artifacts (reports/bias.json /
# reports/shap.json) and read back via mlflow_client helpers, avoiding
# the duplication the code review flagged.


class ModelPackage(Base, IdMixin, TimestampsMixin):
    """A downloadable bundle for a ModelVersion.

    Populated asynchronously by the ``build_package`` worker job: bundles the
    serving docker image (``docker save``), the model artifacts, a README,
    a minimal Dockerfile to rebuild the image, and a standalone ``predict.py``
    into a tar.gz living under ``packages/{id}.tar.gz`` on platform-data.
    """

    # Authoritative owner-chain anchor — every package ties back to the Run
    # that produced it, so authz walks Run → Experiment.user_id exactly like
    # Deployment. MLflow-side identifiers are snapshotted below for the
    # build worker's artifact-fetch step.
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), nullable=False, index=True)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    registered_model_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    version_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_kind: Mapped[str] = mapped_column(String(64), default="sklearn", nullable=False)
    serving_image_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    input_schema_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn, nullable=True)

    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    # Local path to the built tar.gz under /var/platform-data/packages/.
    storage_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


# BuildJob was dropped in migration 0007_mlflow_a — dead schema, never
# populated by any code path.
