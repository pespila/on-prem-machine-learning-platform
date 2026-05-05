import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Rocket } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { EditableHeading } from "@/components/molecules/EditableHeading";
import { GlassCard } from "@/components/molecules/GlassCard";
import { api, errorMessage, type ModelPackageRead, type ModelVersionRead } from "@/lib/api/client";
import { formatNumber, formatRelative } from "@/lib/format";

function formatHpValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function DownloadPackageButton({
  runId,
}: {
  runId: string;
}) {
  // Latest package for this run — lets the user re-download without
  // rebuilding if there's already a ready tar sitting on disk.
  const list = useQuery({
    queryKey: ["package-list", runId],
    queryFn: () => api.packages.listFor(runId),
    enabled: Boolean(runId),
  });
  const latest: ModelPackageRead | undefined = list.data?.[0];
  const [pollingId, setPollingId] = useState<string | null>(null);
  const active = pollingId ?? (latest && latest.status !== "ready" ? latest.id : null);

  const poll = useQuery({
    queryKey: ["package", active ?? "none"],
    queryFn: () => api.packages.get(active!),
    enabled: Boolean(active),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 2_000;
      return data.status === "ready" || data.status === "failed" ? false : 2_000;
    },
  });

  // When a fresh build reaches "ready", auto-trigger the download so the user
  // doesn't have to click a second time.
  useEffect(() => {
    if (!pollingId) return;
    const d = poll.data;
    if (d && d.id === pollingId && d.status === "ready") {
      window.location.href = api.packages.downloadUrl(d.id);
      setPollingId(null);
      list.refetch();
    }
    if (d && d.id === pollingId && d.status === "failed") {
      setPollingId(null);
    }
  }, [poll.data, pollingId, list]);

  const create = useMutation({
    mutationFn: () => api.packages.createFor(runId),
    onSuccess: (pkg) => {
      setPollingId(pkg.id);
    },
  });

  const currentStatus = poll.data?.status ?? latest?.status;
  const isReady = latest?.status === "ready";

  const label = (() => {
    if (create.isPending) return "Queuing…";
    if (pollingId) {
      if (currentStatus === "building") return "Building…";
      if (currentStatus === "pending") return "Pending…";
      if (currentStatus === "failed") return "Retry";
      return "Working…";
    }
    return isReady ? "Download" : "Build package";
  })();

  const onClick = () => {
    if (isReady && latest && !pollingId) {
      window.location.href = api.packages.downloadUrl(latest.id);
      return;
    }
    create.mutate();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={create.isPending || Boolean(pollingId) && currentStatus !== "failed"}
      className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-2.5 py-1 font-semibold text-fg1 transition hover:border-primary hover:bg-[color:var(--primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
      title={
        isReady
          ? "Download the packaged tar.gz"
          : "Build a tarball with the serving image, artifacts, Dockerfile, and README"
      }
    >
      <Download size={13} strokeWidth={2} />
      {label}
    </button>
  );
}

export function ModelDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const model = useQuery({
    queryKey: ["models", id],
    queryFn: () => api.models.get(id),
    enabled: Boolean(id),
  });

  const rename = useMutation({
    mutationFn: (name: string) => api.models.update(id, { name }),
    onSuccess: (updated) => {
      // The model's id IS its name, so a rename changes the route param.
      // Carry the previous detail (with versions[]) over to the new key so
      // the page renders instantly without a "Loading…" flash, drop the
      // now-404 old key, and swap the URL — otherwise the detail page keeps
      // refetching the old name and flashes red errors until the user
      // reopens it from the list. The PATCH response only carries
      // {id,name,description}, hence the merge.
      const nextId = updated.id;
      const prev = qc.getQueryData<{ versions?: ModelVersionRead[] }>(["models", id]);
      qc.setQueryData(["models", nextId], { ...prev, ...updated });
      qc.removeQueries({ queryKey: ["models", id], exact: true });
      qc.invalidateQueries({ queryKey: ["models"] });
      if (nextId !== id) {
        navigate(`/models/${encodeURIComponent(nextId)}`, { replace: true });
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.models.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
      navigate("/models");
    },
  });

  const [deployingVersionId, setDeployingVersionId] = useState<string | null>(null);

  const deploy = useMutation({
    mutationFn: async (runIdForVersion: string) => {
      const modelName = model.data?.name ?? "model";
      // Slug-friendly default name; user can rename on the deployment page.
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      return api.deployments.create({
        run_id: runIdForVersion,
        name: `${modelName}-${stamp}`,
      });
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
      navigate(`/deployments/${d.id}`);
    },
    onSettled: () => setDeployingVersionId(null),
  });

  // Fetch the hyperparameters for the most recent version's originating run so
  // the "Training hyperparameters" panel renders the same shape the RunDetail
  // Model section does. `versions` comes back sorted desc by version number.
  const latestRunId = model.data?.versions?.[0]?.run_id ?? "";
  const selectedHp = useQuery({
    queryKey: ["runs", latestRunId, "selected_hyperparams"],
    queryFn: () => api.runs.selectedHyperparams(latestRunId),
    enabled: Boolean(latestRunId),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <EditableHeading
          value={model.data?.name ?? "Model"}
          onSave={async (next) => {
            await rename.mutateAsync(next);
          }}
          onDelete={async () => {
            await remove.mutateAsync();
          }}
          deleteConfirm="Delete this model and every version under it? This cannot be undone."
          saving={rename.isPending}
          deleting={remove.isPending}
        />
        {model.data?.description ? (
          <p className="max-w-xl text-sm text-fg2">{model.data.description}</p>
        ) : null}
        {remove.isError ? (
          <p className="max-w-xl text-sm text-danger">{errorMessage(remove.error)}</p>
        ) : null}
        {deploy.isError ? (
          <p className="max-w-xl text-sm text-danger">
            Deploy failed: {errorMessage(deploy.error)}
          </p>
        ) : null}
      </header>

      <GlassCard className="!p-0 overflow-hidden">
        {model.isPending ? (
          <div className="p-6 text-sm text-fg3">Loading…</div>
        ) : model.isError ? (
          <div className="p-6 text-sm text-danger">Could not load model.</div>
        ) : (model.data?.versions ?? []).length === 0 ? (
          <div className="p-8 text-center text-sm text-fg3">
            No versions — the run that produced this model may have been deleted.
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-bg-muted text-left">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Version
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Kind
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Run
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Dataset
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Metrics
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Created
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border)]">
              {(model.data?.versions ?? []).map((v) => (
                <tr key={v.id} className="hover:bg-bg-muted/60">
                  <td className="px-6 py-3 font-mono text-xs text-fg1">v{v.version}</td>
                  <td className="px-6 py-3 text-xs text-fg2">
                    {v.model_catalog_name ?? v.model_kind}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs">
                    <Link
                      to={`/experiments/runs/${v.run_id}`}
                      className="text-primary hover:underline"
                    >
                      {v.run_id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-xs text-fg2">
                    {v.dataset_id ? (
                      <Link
                        to={`/datasets/${v.dataset_id}`}
                        className="hover:text-fg1 hover:underline"
                      >
                        {v.dataset_name ?? v.dataset_id.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-6 py-3 text-xs text-fg2">
                    {Object.keys(v.metrics ?? {}).length === 0 ? (
                      <span className="text-fg3">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(v.metrics ?? {}).map(([name, val]) => (
                          <span
                            key={name}
                            className="inline-flex items-center gap-1 rounded-pill bg-bg-muted px-2 py-0.5 font-mono text-[10px] text-fg1"
                            title={String(val)}
                          >
                            <span className="text-fg3">{name}</span>
                            <span>{formatNumber(val, 3)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-3 text-xs text-fg2">
                    {formatRelative(v.created_at)}
                  </td>
                  <td className="px-6 py-3 text-right text-xs">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDeployingVersionId(v.id);
                          deploy.mutate(v.run_id);
                        }}
                        disabled={deploy.isPending && deployingVersionId === v.id}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-2.5 py-1 font-semibold text-fg1 transition hover:border-primary hover:bg-[color:var(--primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                        title="Deploy this version to a live endpoint"
                      >
                        <Rocket size={13} strokeWidth={2} />
                        {deploy.isPending && deployingVersionId === v.id
                          ? "Deploying…"
                          : "Deploy"}
                      </button>
                      <DownloadPackageButton runId={v.run_id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassCard>

      {latestRunId ? (
        <GlassCard>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-xl font-bold text-fg1">
              Training hyperparameters
            </h2>
            <span className="text-xs text-fg3">
              latest version · source:{" "}
              <span className="font-mono text-fg2">
                {selectedHp.data?.source ?? "—"}
              </span>
            </span>
          </div>
          <div className="mt-4">
            {Object.keys(selectedHp.data?.hyperparameters ?? {}).length === 0 ? (
              <p className="text-sm text-fg3">No hyperparameters recorded.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {Object.entries(selectedHp.data?.hyperparameters ?? {}).map(
                    ([key, value]) => (
                      <tr
                        key={key}
                        className="border-b border-[color:var(--border)] last:border-0"
                      >
                        <td className="py-1.5 pr-4 font-mono text-fg2">{key}</td>
                        <td className="py-1.5 font-mono text-fg1">
                          {formatHpValue(value)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
