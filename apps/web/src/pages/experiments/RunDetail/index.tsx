import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { RunStatusBadge } from "@/components/atoms/RunStatusBadge";
import { EditableHeading } from "@/components/molecules/EditableHeading";
import { GlassCard } from "@/components/molecules/GlassCard";
import { LineageChip } from "@/components/molecules/LineageChip";
import { MetricCard } from "@/components/molecules/MetricCard";
import { BiasGroupTable } from "@/components/organisms/BiasGroupTable";
import { RunMetricsChart } from "@/components/organisms/RunMetricsChart";
import { SHAPGlobalBars } from "@/components/organisms/SHAPGlobalBars";
import { TrainingLogStream } from "@/components/organisms/TrainingLogStream";
import { api, errorMessage } from "@/lib/api/client";
import { formatNumber, formatRelative } from "@/lib/format";

export function RunDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [logsOpen, setLogsOpen] = useState(true);

  const run = useQuery({
    queryKey: ["runs", id],
    queryFn: () => api.runs.get(id),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });

  // Post-training artifacts (SHAP / bias / selected_hp / artifact rows) land
  // only after the container exits. While the run is still queued, polling
  // them is pure waste — 7 concurrent 5s polls had been stacking up and
  // amplifying any perceived "UI stuck" behaviour on slow backends. Gate
  // them here so we drop from 7 concurrent polls to 2 during `queued`.
  const status = run.data?.status;
  const isQueued = status === "queued";
  const isTerminal =
    status === "succeeded" || status === "failed" || status === "cancelled";

  const rename = useMutation({
    mutationFn: (name: string) => api.runs.update(id, { display_name: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", id] }),
  });

  const remove = useMutation({
    mutationFn: () => api.runs.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["models"] });
      const expId = run.data?.experiment_id;
      navigate(expId ? `/experiments/${expId}` : "/experiments");
    },
  });

  const metrics = useQuery({
    queryKey: ["runs", id, "metrics"],
    queryFn: () => api.runs.metrics(id),
    enabled: Boolean(id),
    // AutoGluon / HPO can stream per-step metrics during `running`, so we
    // poll then. Nothing to see during `queued`. After terminal, MLflow may
    // still be flushing the final batch; keep polling fast until data shows
    // up so the user doesn't have to refresh to see metrics + the chart.
    refetchInterval: (q) => {
      if (isQueued) return false;
      if (isTerminal) {
        return (q.state.data?.length ?? 0) > 0 ? false : 3_000;
      }
      return 5_000;
    },
  });

  const artifacts = useQuery({
    queryKey: ["runs", id, "artifacts"],
    queryFn: () => api.runs.artifacts(id),
    enabled: Boolean(id),
    // Artifact rows land after the container exits — don't poll during
    // queued; poll while running, and poll a bit faster on terminal until
    // the rows show up. Stop once we have any.
    refetchInterval: (q) => {
      if ((q.state.data?.length ?? 0) > 0) return false;
      if (isQueued) return false;
      if (isTerminal) return 3_000;
      return 5_000;
    },
  });

  const explanations = useQuery({
    queryKey: ["runs", id, "explanations"],
    queryFn: () => api.runs.explanations(id),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      if (q.state.data && q.state.data.length > 0) return false;
      if (isQueued) return false;
      return 5_000;
    },
  });

  const bias = useQuery({
    queryKey: ["runs", id, "bias"],
    queryFn: () => api.runs.bias(id),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      if (q.state.data && q.state.data.length > 0) return false;
      if (isQueued) return false;
      return 5_000;
    },
  });

  const selectedHp = useQuery({
    queryKey: ["runs", id, "selected_hyperparams"],
    queryFn: () => api.runs.selectedHyperparams(id),
    enabled: Boolean(id),
    // Poll until the artifact lands; once we have non-legacy data, stop.
    refetchInterval: (q) => {
      if (q.state.data && q.state.data.source !== "legacy") return false;
      if (isQueued) return false;
      return 5_000;
    },
  });

  const logHistory = useQuery({
    queryKey: ["runs", id, "logs"],
    queryFn: () => api.runs.logs(id),
    enabled: Boolean(id),
    // Keep polling the persisted transcript until the run finishes so the
    // "Closed" SSE state still shows a complete log after a refresh.
    refetchInterval: (q) => {
      if (isTerminal) {
        return (q.state.data?.length ?? 0) > 0 ? false : 3_000;
      }
      return 5_000;
    },
  });

  const shapBars = useMemo(() => {
    const first = explanations.data?.[0];
    if (!first) return [] as { feature: string; importance: number }[];
    return Object.entries(first.feature_importance ?? {}).map(([feature, importance]) => ({
      feature,
      importance: Number(importance) || 0,
    }));
  }, [explanations.data]);

  const biasRows = useMemo(() => {
    const first = bias.data?.[0];
    if (!first) return [] as { group: string; support: number; metric: number; baseline: number }[];
    const groups = first.group_values?.groups ?? {};
    const overall =
      typeof first.overall_value === "number" ? first.overall_value : 0;
    return Object.entries(groups).map(([group, val]) => {
      const metric =
        typeof val === "number"
          ? val
          : typeof val === "object" && val !== null
            ? Number(Object.values(val)[0] ?? 0)
            : 0;
      return {
        group,
        support: 0,
        metric,
        baseline: overall,
      };
    });
  }, [bias.data]);

  const biasMetricLabel = bias.data?.[0]?.metric_name ?? "Metric";

  const finalMetrics = useMemo(() => {
    if (!metrics.data) return [];
    const byName = new Map<string, number>();
    for (const m of metrics.data) {
      byName.set(m.name, m.value);
    }
    return Array.from(byName.entries()).slice(0, 4);
  }, [metrics.data]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <RunStatusBadge status={run.data?.status ?? "queued"} />
          <EditableHeading
            className="flex-1"
            value={run.data?.display_name || `Run ${id.slice(0, 8)}`}
            onSave={async (next) => {
              await rename.mutateAsync(next);
            }}
            onDelete={async () => {
              await remove.mutateAsync();
            }}
            deleteConfirm="Delete this run, its metrics, artifacts, and any model versions it produced?"
            saving={rename.isPending}
            deleting={remove.isPending}
          />
        </div>
        {remove.isError ? (
          <p className="max-w-xl text-sm text-danger">{errorMessage(remove.error)}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg2">
          {run.data ? (
            <>
              <LineageChip
                kind="dataset"
                id={run.data.dataset_id}
                to={`/datasets/${run.data.dataset_id}`}
                label="dataset"
              />
              <span>Started {formatRelative(run.data.started_at)}</span>
              {run.data.finished_at ? (
                <span>· Finished {formatRelative(run.data.finished_at)}</span>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {finalMetrics.length === 0 ? (
          <GlassCard className="md:col-span-4">
            <p className="text-sm text-fg3">No metrics recorded yet.</p>
          </GlassCard>
        ) : (
          finalMetrics.map(([name, value]) => (
            <MetricCard key={name} eyebrow={name} value={formatNumber(value, 3)} />
          ))
        )}
      </section>

      <GlassCard>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-xl font-bold text-fg1">Model</h2>
          {selectedHp.data ? (
            <HpSourcePill source={selectedHp.data.source} />
          ) : null}
        </div>
        <p className="mt-1 text-sm text-fg2">
          Estimator{" "}
          <span className="font-mono text-fg1">
            {selectedHp.data?.model_name ?? "—"}
          </span>
          {selectedHp.data?.task ? (
            <>
              {" · "}
              <span className="font-mono text-fg1">
                {selectedHp.data.task.replace(/_/g, " ")}
              </span>
            </>
          ) : null}
        </p>
        <div className="mt-4">
          <HyperparamTable hp={selectedHp.data?.hyperparameters ?? {}} />
        </div>
        {selectedHp.data?.hpo_summary ? (
          <div className="mt-4 rounded-lg border border-[color:var(--border)] bg-bg-muted/40 p-4 text-sm">
            <div className="font-semibold text-fg1">HPO summary</div>
            <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-fg2 md:grid-cols-4">
              <div>
                trials:{" "}
                <span className="font-mono text-fg1">
                  {selectedHp.data.hpo_summary.n_trials_completed ?? "—"}
                </span>
              </div>
              <div>
                metric:{" "}
                <span className="font-mono text-fg1">
                  {selectedHp.data.hpo_summary.metric ?? "—"}
                </span>
              </div>
              <div>
                best:{" "}
                <span className="font-mono text-fg1">
                  {typeof selectedHp.data.hpo_summary.best_value === "number"
                    ? formatNumber(selectedHp.data.hpo_summary.best_value, 4)
                    : "—"}
                </span>
              </div>
              <div>
                direction:{" "}
                <span className="font-mono text-fg1">
                  {selectedHp.data.hpo_summary.direction ?? "—"}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </GlassCard>

      <GlassCard>
        <h2 className="font-display text-xl font-bold text-fg1">Metrics over time</h2>
        <p className="mt-1 text-sm text-fg2">Per-step loss and evaluation metrics.</p>
        <div className="mt-4">
          <RunMetricsChart metrics={metrics.data ?? []} />
        </div>
      </GlassCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GlassCard>
          <h2 className="font-display text-xl font-bold text-fg1">Global feature importance</h2>
          <p className="mt-1 text-sm text-fg2">SHAP-derived, averaged across the validation split.</p>
          <div className="mt-4">
            <SHAPGlobalBars data={shapBars} />
          </div>
        </GlassCard>
        <GlassCard>
          <h2 className="font-display text-xl font-bold text-fg1">Bias analysis</h2>
          <p className="mt-1 text-sm text-fg2">Per-group metric deltas vs. the baseline.</p>
          <div className="mt-4">
            <BiasGroupTable rows={biasRows} metricLabel={biasMetricLabel} />
          </div>
        </GlassCard>
      </div>

      <GlassCard className="!p-0 overflow-hidden">
        <div className="border-b border-[color:var(--border)] px-6 py-4">
          <h2 className="font-display text-xl font-bold text-fg1">Artifacts</h2>
        </div>
        {artifacts.data && artifacts.data.length > 0 ? (
          <ul className="divide-y divide-[color:var(--border)]">
            {artifacts.data.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-6 py-3 text-sm">
                <div>
                  <div className="font-medium text-fg1">{a.name}</div>
                  <div className="text-xs text-fg3">{a.kind}</div>
                </div>
                <a
                  href={a.download_url}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                >
                  <Download size={14} strokeWidth={2} /> Download
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-6 py-4 text-sm text-fg3">No artifacts yet.</p>
        )}
      </GlassCard>

      <GlassCard className="!p-0 overflow-hidden">
        <button
          type="button"
          onClick={() => setLogsOpen((v) => !v)}
          className="flex w-full items-center justify-between border-b border-[color:var(--border)] px-6 py-4 text-left hover:bg-bg-muted/60"
        >
          <h2 className="font-display text-xl font-bold text-fg1">Training logs</h2>
          {logsOpen ? (
            <ChevronDown size={18} strokeWidth={2} />
          ) : (
            <ChevronRight size={18} strokeWidth={2} />
          )}
        </button>
        {logsOpen ? (
          <div className="p-4">
            <TrainingLogStream
              url={`/sse/runs/${id}/logs`}
              enabled
              history={(logHistory.data ?? []).map((l) => ({
                ts: l.ts,
                level: (l.level as "debug" | "info" | "warn" | "error") ?? "info",
                message: l.message,
              }))}
            />
          </div>
        ) : null}
      </GlassCard>
    </div>
  );
}

function HpSourcePill({ source }: { source: "user" | "hpo" | "legacy" }) {
  const label = source === "hpo" ? "HPO" : source === "legacy" ? "Legacy" : "User";
  const tone =
    source === "hpo"
      ? "bg-primary/15 text-primary"
      : source === "legacy"
        ? "bg-bg-muted text-fg3"
        : "bg-success/15 text-success";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}

function HyperparamTable({ hp }: { hp: Record<string, unknown> }) {
  const entries = Object.entries(hp);
  if (entries.length === 0) {
    return <p className="text-sm text-fg3">No hyperparameters recorded.</p>;
  }
  return (
    <table className="w-full border-collapse text-sm">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="border-b border-[color:var(--border)] last:border-0">
            <td className="py-1.5 pr-4 font-mono text-fg2">{key}</td>
            <td className="py-1.5 font-mono text-fg1">{formatHpValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
