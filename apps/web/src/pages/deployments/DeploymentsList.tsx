import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { RunStatusBadge, type RunStatus } from "@/components/atoms/RunStatusBadge";
import { Button } from "@/components/atoms/Button";
import { GlassCard } from "@/components/molecules/GlassCard";
import { Modal } from "@/components/molecules/Modal";
import { useT } from "@/i18n";
import { api, type DeploymentRead } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { formatBytes, formatRelative } from "@/lib/format";

function mapStatus(status: DeploymentRead["status"]): RunStatus {
  switch (status) {
    case "provisioning":
    case "deploying":
      return "building";
    case "ready":
    case "active":
      return "running";
    case "failed":
    case "unhealthy":
      return "failed";
    case "stopping":
    case "stopped":
    case "tearing_down":
    case "trashed":
      return "cancelled";
    default:
      return "queued";
  }
}

function EndpointCell({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="flex items-center gap-2">
      <code className="max-w-[24rem] truncate font-mono text-xs text-teal-900">
        {url}
      </code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-fg2 hover:bg-bg-muted hover:text-fg1"
      >
        {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
      </button>
    </div>
  );
}

function NewDeploymentForm({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  // After Batch 35b the backend resolves (run_id → MLflow version) instead
  // of the old ModelVersion DB row, so the picker emits the platform run_id
  // attached to the chosen MLflow ModelVersion.
  const [runId, setRunId] = useState("");

  const models = useQuery({ queryKey: ["models"], queryFn: () => api.models.list() });
  const model = useQuery({
    queryKey: ["models", modelId],
    queryFn: () => api.models.get(modelId),
    enabled: Boolean(modelId),
  });

  const create = useMutation({
    mutationFn: () => api.deployments.create({ run_id: runId, name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
      onClose();
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (runId && name.trim()) create.mutate();
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
          Deployment name
        </span>
        <input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          placeholder="churn-prod"
          className="rounded border border-[color:var(--border)] bg-bg px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
          Model
        </span>
        <select
          value={modelId}
          onChange={(ev) => {
            setModelId(ev.target.value);
            setRunId("");
          }}
          className="rounded border border-[color:var(--border)] bg-bg px-3 py-2 text-sm focus:border-primary focus:outline-none"
        >
          <option value="">Select a model…</option>
          {(models.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
          Version
        </span>
        <select
          value={runId}
          onChange={(ev) => setRunId(ev.target.value)}
          disabled={!modelId || !model.data}
          className="rounded border border-[color:var(--border)] bg-bg px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
        >
          <option value="">Select a version…</option>
          {(model.data?.versions ?? []).map((v) => (
            <option key={v.id} value={v.run_id}>
              v{v.version} · {v.model_kind}
              {v.aliases?.length ? ` · @${v.aliases.join(",@")}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} type="button">
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={create.isPending || !runId || !name.trim()}>
          Deploy →
        </Button>
      </div>
    </form>
  );
}

function TrashRow({ d }: { d: DeploymentRead }) {
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api.deployments.restore(d.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deployments"] }),
  });
  const purge = useMutation({
    mutationFn: () => api.deployments.purge(d.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deployments"] }),
  });
  const onPurge = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    const size = formatBytes(d.disk_bytes ?? 0);
    if (
      confirm(
        `Delete "${d.name}" forever? This wipes the staged artifacts (${size}) and the database row. Cannot be undone.`,
      )
    ) {
      purge.mutate();
    }
  };
  const onRestore = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    restore.mutate();
  };
  return (
    <tr key={d.id} className="hover:bg-bg-muted/60">
      <td className="px-6 py-3 font-medium text-fg1">{d.name}</td>
      <td className="px-6 py-3 text-xs text-fg2">{formatRelative(d.trashed_at)}</td>
      <td className="px-6 py-3 text-xs font-mono text-fg2">
        {formatBytes(d.disk_bytes ?? 0)}
      </td>
      <td className="px-6 py-3">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onRestore}
            disabled={restore.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-2.5 py-1 text-xs font-semibold text-fg1 transition hover:border-primary hover:bg-[color:var(--primary-soft)] disabled:opacity-50"
            title="Re-deploy this model from the same staged artifacts"
          >
            <RotateCcw size={13} strokeWidth={2} />
            {restore.isPending ? "Restoring…" : "Restore"}
          </button>
          <button
            type="button"
            onClick={onPurge}
            disabled={purge.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-2.5 py-1 text-xs font-semibold text-danger transition hover:border-danger hover:bg-[color:var(--danger-soft,rgba(255,90,90,0.08))] disabled:opacity-50"
            title="Permanently delete the staged artifacts and DB row"
          >
            <Trash2 size={13} strokeWidth={2} />
            {purge.isPending ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function DeploymentsList() {
  const t = useT();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [view, setView] = useState<"active" | "trash">("active");

  const active = useQuery({
    queryKey: ["deployments", { trashed: false }],
    queryFn: () => api.deployments.list({ trashed: false }),
  });
  const trashed = useQuery({
    queryKey: ["deployments", { trashed: true }],
    queryFn: () => api.deployments.list({ trashed: true }),
  });

  const trashCount = trashed.data?.length ?? 0;
  const trashBytes = (trashed.data ?? []).reduce(
    (sum, d) => sum + (d.disk_bytes ?? 0),
    0,
  );

  const visible = view === "active" ? active : trashed;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-display-lg font-extrabold tracking-tight text-fg1">
            {t("deployments.title")}
          </h1>
          <p className="mt-2 max-w-xl text-fg2">{t("deployments.subtitle")}</p>
        </div>
        <Button leftIcon={<Plus size={16} strokeWidth={2} />} onClick={() => setNewOpen(true)}>
          {t("deployments.newCta")}
        </Button>
      </header>

      <div role="tablist" className="flex items-center gap-1 border-b border-[color:var(--border)]">
        <button
          type="button"
          role="tab"
          aria-selected={view === "active"}
          onClick={() => setView("active")}
          className={cn(
            "border-b-2 px-4 py-2 text-sm font-semibold transition-colors",
            view === "active"
              ? "border-primary text-primary"
              : "border-transparent text-fg2 hover:text-fg1",
          )}
        >
          Active
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "trash"}
          onClick={() => setView("trash")}
          className={cn(
            "inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors",
            view === "trash"
              ? "border-primary text-primary"
              : "border-transparent text-fg2 hover:text-fg1",
          )}
        >
          <Trash2 size={14} strokeWidth={2} />
          Trash
          {trashCount > 0 ? (
            <span className="inline-flex items-center rounded-pill bg-bg-muted px-2 py-0.5 text-[11px] font-mono text-fg2">
              {trashCount} · {formatBytes(trashBytes)}
            </span>
          ) : null}
        </button>
      </div>

      <GlassCard className="!p-0 overflow-hidden">
        {visible.isPending ? (
          <div className="p-6 text-sm text-fg3">{t("common.loading")}…</div>
        ) : visible.isError ? (
          <div className="p-6 text-sm text-danger">{t("common.error")}</div>
        ) : (visible.data ?? []).length === 0 ? (
          <div className="p-8 text-center text-sm text-fg3">
            {view === "trash" ? "Trash is empty." : t("deployments.empty")}
          </div>
        ) : view === "active" ? (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-bg-muted text-left">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  {t("deployments.columns.name")}
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  {t("deployments.columns.status")}
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  {t("deployments.columns.endpoint")}
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  {t("deployments.columns.lastCalled")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border)]">
              {(active.data ?? []).map((d) => (
                <tr
                  key={d.id}
                  className="cursor-pointer hover:bg-bg-muted/60"
                  onClick={() => navigate(`/deployments/${d.id}`)}
                >
                  <td className="px-6 py-3 font-medium text-fg1">{d.name}</td>
                  <td className="px-6 py-3">
                    <RunStatusBadge status={mapStatus(d.status)} />
                  </td>
                  <td className="px-6 py-3">
                    <EndpointCell url={d.url} />
                  </td>
                  <td className="px-6 py-3 text-xs text-fg2">
                    {formatRelative(d.last_called_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-bg-muted text-left">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Name
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Trashed
                </th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Disk
                </th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-[0.08em] text-fg2">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border)]">
              {(trashed.data ?? []).map((d) => (
                <TrashRow key={d.id} d={d} />
              ))}
            </tbody>
          </table>
        )}
      </GlassCard>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title={t("deployments.newCta")}>
        <NewDeploymentForm onClose={() => setNewOpen(false)} />
      </Modal>
    </div>
  );
}
