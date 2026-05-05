/**
 * Typed API client for the AIpacken backend.
 *
 * All endpoints live on the same origin behind Traefik, so we use relative
 * paths and `credentials: "include"` for cookie-based auth.
 *
 * The fetcher throws a typed `ApiError` on non-2xx responses; callers (mostly
 * TanStack Query) can inspect `.status` to drive 401 redirects.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API ${status} ${statusText}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * Extract a human-readable message from an unknown error value. Knows how to
 * dig into the FastAPI {detail: {...}} shape our 409 responses use, and falls
 * back to the generic Error message otherwise.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | null | undefined;
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const msg = (detail as { message?: unknown }).message;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

interface ApiFetchInit extends Omit<RequestInit, "body"> {
  // `object` accepts any structural interface (CreateRunInput, CreateDeploymentInput,
  // plain Records, arrays). Narrower aliases like `Record<string, unknown>` reject
  // interfaces without an index signature, which every codegen'd input type has.
  body?: BodyInit | object | null;
  /** If false, skip the default JSON content-type header. */
  json?: boolean;
}

export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { body, json = true, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = { ...(headers as Record<string, string> | undefined) };

  let finalBody: BodyInit | null | undefined;
  if (body === undefined || body === null) {
    finalBody = body ?? undefined;
  } else if (body instanceof FormData || body instanceof Blob || typeof body === "string") {
    finalBody = body;
  } else {
    finalBody = JSON.stringify(body);
    if (json && !finalHeaders["Content-Type"]) {
      finalHeaders["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    headers: finalHeaders,
    body: finalBody,
    ...rest,
  });

  if (!res.ok) {
    throw new ApiError(res.status, res.statusText, await parseBody(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrentUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

export type DatasetStatus = "uploading" | "profiling" | "ready" | "failed";

export interface DatasetRead {
  id: string;
  name: string;
  status: DatasetStatus;
  row_count: number | null;
  column_count: number | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface DatasetProfile {
  row_count: number;
  column_count: number;
  missing_cells: number;
  duplicate_rows: number;
  columns: DatasetProfileColumn[];
}

export interface DatasetProfileColumn {
  name: string;
  type: FeatureType;
  null_fraction: number;
  unique_count: number;
  histogram?: Array<{ bucket: string; count: number }>;
}

export type FeatureType = "numeric" | "categorical" | "datetime" | "boolean" | "text";

export interface FeatureSchema {
  name: string;
  type: FeatureType;
  nullable: boolean;
  unique_count: number;
  null_fraction: number;
  sample: Array<string | number | boolean | null>;
}

export type TaskKind =
  | "regression"
  | "binary_classification"
  | "multiclass_classification"
  | "forecasting"
  | "recommender"
  | "clustering";

export type TaskFamily = "supervised" | "forecasting" | "recommender" | "clustering";

export const SUPERVISED_TASKS: TaskKind[] = [
  "regression",
  "binary_classification",
  "multiclass_classification",
];

export function taskFamilyOf(task: TaskKind): TaskFamily {
  if (task === "forecasting" || task === "recommender" || task === "clustering") return task;
  return "supervised";
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  family: string;
  description: string;
  hyperparam_schema: JsonSchema;
  tags: string[];
  supported_tasks?: TaskKind[];
  framework?: string;
}

export interface SelectedHyperparams {
  source: "user" | "hpo" | "legacy";
  model_name: string | null;
  task: TaskKind | null;
  hyperparameters: Record<string, unknown>;
  hpo_summary?: {
    n_trials_completed?: number;
    best_value?: number;
    metric?: string;
    direction?: "maximize" | "minimize";
    search_space?: Record<string, unknown>;
  };
}

export interface ExperimentRead {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  run_count?: number;
}

export type RunStatusValue =
  | "queued"
  | "building"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunRead {
  id: string;
  experiment_id: string;
  dataset_id: string;
  model_catalog_id: string;
  display_name: string | null;
  status: RunStatusValue;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  transform_config?: Record<string, unknown>;
  hyperparams?: Record<string, unknown>;
  primary_metric?: { name: string; value: number } | null;
}

export interface RunMetric {
  name: string;
  step: number;
  value: number;
  ts: string;
}

export interface RunArtifact {
  id: string;
  name: string;
  kind: string;
  size_bytes: number;
  download_url: string;
}

export interface ModelVersionRead {
  id: string;
  registered_model_id: string;
  registered_model_name: string;
  version: number;
  run_id: string;
  stage: string;
  aliases: string[];
  model_kind: string;
  storage_path: string | null;
  created_at: string;
  metrics?: Record<string, number>;
  dataset_id?: string | null;
  dataset_name?: string | null;
  experiment_id?: string | null;
  model_catalog_name?: string | null;
}

export type DeploymentStatus =
  | "pending"
  | "provisioning"
  | "deploying"
  | "ready"
  | "active"
  | "unhealthy"
  | "failed"
  | "stopping"
  | "tearing_down"
  | "stopped"
  | "trashed";

export type ModelPackageStatus = "pending" | "building" | "ready" | "failed";

export interface ModelPackageRead {
  id: string;
  run_id: string;
  registered_model_name: string | null;
  version_number: number | null;
  model_kind: string;
  status: ModelPackageStatus;
  storage_path: string | null;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRead {
  id: string;
  name: string;
  slug: string;
  run_id: string;
  registered_model_name: string | null;
  version_number: number | null;
  model_kind: string;
  status: DeploymentStatus;
  /** Public-facing URL the external caller POSTs predictions to. */
  url: string;
  endpoint_url: string | null;
  internal_url: string | null;
  created_at: string;
  last_called_at: string | null;
  /** ISO-8601 timestamp when the row was moved to Trash, or null if active. */
  trashed_at: string | null;
  /**
   * Bytes occupied by the staged artifacts dir. Server-populated only on
   * the Trash listing and on the trashed detail view; null otherwise.
   */
  disk_bytes: number | null;
}

export interface PredictionResponse {
  prediction: unknown;
  prediction_label?: string | null;
  target_classes?: string[] | null;
  model_version: string;
  trace_id: string;
}

export interface PredictionLogEntry {
  id: string;
  deployment_id: string;
  received_at: string;
  latency_ms: number | null;
  mode: string;
  status_code: number;
  trace_id: string | null;
  input_preview_json: Record<string, unknown> | null;
  output_preview_json: Record<string, unknown> | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  format?: string;
}

// ---------------------------------------------------------------------------
// Endpoint bindings
// ---------------------------------------------------------------------------

export type HpoSearchEntryOnWire =
  | { type: "int"; low: number; high: number; step?: number; log?: boolean }
  | { type: "float"; low: number; high: number; log?: boolean }
  | { type: "categorical"; choices: Array<string | number | boolean> };

export interface HpoConfigOnWire {
  enabled: boolean;
  n_trials?: number;
  timeout_sec?: number;
  metric?: string | null;
  direction?: "maximize" | "minimize" | null;
  search_space?: Record<string, HpoSearchEntryOnWire>;
}

export interface CreateRunInput {
  experiment_id: string;
  dataset_id: string;
  transform_config: Record<string, unknown>;
  model_catalog_id: string;
  hyperparams: Record<string, unknown>;
  task?: TaskKind | null;
  hpo?: HpoConfigOnWire | null;
}

export interface CreateExperimentInput {
  name: string;
  description?: string;
}

export interface CreateDeploymentInput {
  run_id: string;
  name: string;
}

export const api = {
  health: () => apiFetch<HealthResponse>("/healthz"),

  auth: {
    login: (input: { email: string; password: string }) =>
      apiFetch<CurrentUser>("/auth/login", { method: "POST", body: input }),
    logout: () => apiFetch<void>("/auth/logout", { method: "POST" }),
    me: () => apiFetch<CurrentUser>("/auth/me"),
  },

  datasets: {
    list: () =>
      apiFetch<{ items: DatasetRead[] }>("/datasets").then((r) => r.items ?? []),
    get: (id: string) => apiFetch<DatasetRead>(`/datasets/${encodeURIComponent(id)}`),
    profile: (id: string) =>
      apiFetch<DatasetProfile>(`/datasets/${encodeURIComponent(id)}/profile`),
    schema: (id: string) =>
      apiFetch<FeatureSchema[]>(`/datasets/${encodeURIComponent(id)}/schema`),
    rename: (id: string, name: string) =>
      apiFetch<DatasetRead>(`/datasets/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { name },
      }),
    remove: (id: string) =>
      apiFetch<void>(`/datasets/${encodeURIComponent(id)}`, { method: "DELETE" }),
    patchColumnType: (id: string, columnName: string, type: FeatureType) =>
      apiFetch<FeatureSchema>(
        `/datasets/${encodeURIComponent(id)}/schema/${encodeURIComponent(columnName)}`,
        { method: "PATCH", body: { semantic_type: type } },
      ),
    upload: (file: File, onProgress?: (pct: number) => void): Promise<DatasetRead> =>
      new Promise((resolve, reject) => {
        const form = new FormData();
        form.append("file", file);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${BASE_URL}/datasets`);
        xhr.withCredentials = true;
        if (onProgress) {
          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
              onProgress(ev.loaded / ev.total);
            }
          };
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as DatasetRead);
            } catch (err) {
              reject(err as Error);
            }
          } else {
            reject(new ApiError(xhr.status, xhr.statusText, xhr.responseText));
          }
        };
        xhr.onerror = () => reject(new ApiError(0, "network error", null));
        xhr.send(form);
      }),
  },

  catalog: {
    models: () =>
      apiFetch<{ items: ModelCatalogEntry[] } | ModelCatalogEntry[]>("/catalog/models").then(
        (r) => (Array.isArray(r) ? r : (r.items ?? [])),
      ),
  },

  experiments: {
    list: () =>
      apiFetch<{ items: ExperimentRead[] }>("/experiments").then((r) => r.items ?? []),
    get: (id: string) => apiFetch<ExperimentRead>(`/experiments/${encodeURIComponent(id)}`),
    create: (input: CreateExperimentInput) =>
      apiFetch<ExperimentRead>("/experiments", { method: "POST", body: input }),
    update: (id: string, input: { name?: string; description?: string | null }) =>
      apiFetch<ExperimentRead>(`/experiments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      }),
    remove: (id: string) =>
      apiFetch<void>(`/experiments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  runs: {
    list: (experimentId?: string) =>
      apiFetch<{ items: RunRead[] }>(
        experimentId ? `/runs?experiment_id=${encodeURIComponent(experimentId)}` : "/runs",
      ).then((r) => r.items ?? []),
    create: (input: CreateRunInput) =>
      apiFetch<RunRead>("/runs", { method: "POST", body: input }),
    get: (id: string) => apiFetch<RunRead>(`/runs/${encodeURIComponent(id)}`),
    update: (id: string, input: { display_name?: string | null }) =>
      apiFetch<RunRead>(`/runs/${encodeURIComponent(id)}`, { method: "PATCH", body: input }),
    remove: (id: string) =>
      apiFetch<void>(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    metrics: (id: string) => apiFetch<RunMetric[]>(`/runs/${encodeURIComponent(id)}/metrics`),
    artifacts: (id: string) =>
      apiFetch<RunArtifact[]>(`/runs/${encodeURIComponent(id)}/artifacts`),
    logs: (id: string) =>
      apiFetch<Array<{ ts: string; level: string; message: string }>>(
        `/runs/${encodeURIComponent(id)}/logs`,
      ),
    explanations: (id: string) =>
      apiFetch<
        Array<{
          id: string;
          kind: string;
          feature_importance: Record<string, number>;
          artifact_path: string | null;
        }>
      >(`/runs/${encodeURIComponent(id)}/explanations`),
    bias: (id: string) =>
      apiFetch<
        Array<{
          id: string;
          sensitive_feature: string;
          metric_name: string;
          overall_value: number | null;
          group_values: {
            groups?: Record<string, number | Record<string, number>>;
            deltas?: Record<string, number>;
            overall?: number | Record<string, number>;
          };
        }>
      >(`/runs/${encodeURIComponent(id)}/bias`),
    selectedHyperparams: (id: string) =>
      apiFetch<SelectedHyperparams>(
        `/runs/${encodeURIComponent(id)}/selected_hyperparams`,
      ),
  },

  models: {
    list: () =>
      apiFetch<{
        items: Array<{ id: string; name: string; description: string | null; created_at: string }>;
      }>("/models").then((r) => r.items ?? []),
    get: (id: string) =>
      apiFetch<{
        id: string;
        name: string;
        description: string | null;
        versions: ModelVersionRead[];
      }>(`/models/${encodeURIComponent(id)}`),
    update: (id: string, input: { name?: string; description?: string | null }) =>
      apiFetch<{ id: string; name: string; description: string | null }>(
        `/models/${encodeURIComponent(id)}`,
        { method: "PATCH", body: input },
      ),
    remove: (id: string) =>
      apiFetch<void>(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  packages: {
    createFor: (runId: string) =>
      apiFetch<ModelPackageRead>(
        `/runs/${encodeURIComponent(runId)}/package`,
        { method: "POST" },
      ),
    listFor: (runId: string) =>
      apiFetch<ModelPackageRead[]>(
        `/runs/${encodeURIComponent(runId)}/packages`,
      ),
    get: (packageId: string) =>
      apiFetch<ModelPackageRead>(`/model-packages/${encodeURIComponent(packageId)}`),
    downloadUrl: (packageId: string) =>
      `/api/model-packages/${encodeURIComponent(packageId)}/download`,
  },

  deployments: {
    list: (opts?: { trashed?: boolean }) =>
      apiFetch<{ items: DeploymentRead[] }>(
        opts?.trashed ? "/deployments?trashed=true" : "/deployments",
      ).then((r) => r.items ?? []),
    get: (id: string) => apiFetch<DeploymentRead>(`/deployments/${encodeURIComponent(id)}`),
    create: (input: CreateDeploymentInput) =>
      apiFetch<DeploymentRead>("/deployments", { method: "POST", body: input }),
    update: (id: string, input: { name?: string; audit_payloads?: boolean }) =>
      apiFetch<DeploymentRead>(`/deployments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      }),
    /** Soft-delete: move to Trash. Container is stopped, route freed, row kept. */
    remove: (id: string) =>
      apiFetch<void>(`/deployments/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Bring a trashed deployment back online by re-enqueuing deploy_model. */
    restore: (id: string) =>
      apiFetch<DeploymentRead>(`/deployments/${encodeURIComponent(id)}/restore`, {
        method: "POST",
      }),
    /** Hard-delete: wipe the staged-artifacts dir and the DB row. Trash-only. */
    purge: (id: string) =>
      apiFetch<void>(`/deployments/${encodeURIComponent(id)}/purge`, { method: "DELETE" }),
    schema: (id: string) =>
      apiFetch<JsonSchema>(`/deployments/${encodeURIComponent(id)}/schema`),
    logs: (id: string, tail: number = 500) =>
      apiFetch<Array<{ ts: string; level: string; message: string }>>(
        `/deployments/${encodeURIComponent(id)}/logs?tail=${tail}`,
      ),
    predict: (id: string, body: Record<string, unknown>) =>
      apiFetch<PredictionResponse>(`/deployments/${encodeURIComponent(id)}/predict`, {
        method: "POST",
        body,
      }),
    predictions: (id: string, page: number = 1, pageSize: number = 20) =>
      apiFetch<Page<PredictionLogEntry>>(
        `/deployments/${encodeURIComponent(id)}/predictions?page=${page}&page_size=${pageSize}`,
      ),
  },
};

export type Api = typeof api;
