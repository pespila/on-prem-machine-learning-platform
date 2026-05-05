import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { RunStatusBadge, type RunStatus } from "@/components/atoms/RunStatusBadge";
import { EditableHeading } from "@/components/molecules/EditableHeading";
import { GlassCard } from "@/components/molecules/GlassCard";
import { useT } from "@/i18n";
import { api, type DeploymentRead } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { formatBytes, formatRelative } from "@/lib/format";

import { LogsTab } from "./LogsTab";
import { OverviewTab } from "./OverviewTab";
import { PredictionsTab } from "./PredictionsTab";
import { TestTab } from "./TestTab";

type Tab = "overview" | "test" | "predictions" | "logs";

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

export function DeploymentDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");

  const deployment = useQuery({
    queryKey: ["deployments", id],
    queryFn: () => api.deployments.get(id),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });

  const rename = useMutation({
    mutationFn: (name: string) => api.deployments.update(id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments", id] });
      qc.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deployments.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
      navigate("/deployments");
    },
  });

  const restore = useMutation({
    mutationFn: () => api.deployments.restore(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  const purge = useMutation({
    mutationFn: () => api.deployments.purge(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments"] });
      navigate("/deployments");
    },
  });

  const isTrashed = Boolean(deployment.data?.trashed_at);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: t("deployments.tabs.overview") },
    { key: "test", label: t("deployments.tabs.test") },
    { key: "predictions", label: t("deployments.tabs.predictions") },
    { key: "logs", label: t("deployments.tabs.logs") },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {deployment.data ? (
            <RunStatusBadge status={mapStatus(deployment.data.status)} />
          ) : null}
          <EditableHeading
            className="flex-1"
            value={deployment.data?.name ?? "Deployment"}
            onSave={async (next) => {
              await rename.mutateAsync(next);
            }}
            // EditableHeading owns its delete confirm — disable it when the
            // row is already trashed so the trash banner below is the only
            // path to "Delete forever". (Avoids two competing destructive
            // affordances on one screen.)
            onDelete={
              isTrashed
                ? undefined
                : async () => {
                    await remove.mutateAsync();
                  }
            }
            deleteConfirm="Move this deployment to Trash? The container is stopped and the route freed; the staged artifacts stay on disk so you can restore later."
            saving={rename.isPending}
            deleting={remove.isPending}
          />
        </div>
        {isTrashed && deployment.data ? (
          <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--border)] bg-bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-fg2">
              <div className="font-semibold text-fg1">In Trash</div>
              <div className="mt-0.5 text-xs">
                Trashed {formatRelative(deployment.data.trashed_at)}
                {deployment.data.disk_bytes != null
                  ? ` · ${formatBytes(deployment.data.disk_bytes)} on disk`
                  : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => restore.mutate()}
                disabled={restore.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-3 py-1.5 text-xs font-semibold text-fg1 transition hover:border-primary hover:bg-[color:var(--primary-soft)] disabled:opacity-50"
              >
                <RotateCcw size={13} strokeWidth={2} />
                {restore.isPending ? "Restoring…" : "Restore"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const size = formatBytes(deployment.data?.disk_bytes ?? 0);
                  if (
                    confirm(
                      `Delete "${deployment.data?.name}" forever? This wipes the staged artifacts (${size}) and the database row. Cannot be undone.`,
                    )
                  ) {
                    purge.mutate();
                  }
                }}
                disabled={purge.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-bg px-3 py-1.5 text-xs font-semibold text-danger transition hover:border-danger hover:bg-[color:var(--danger-soft,rgba(255,90,90,0.08))] disabled:opacity-50"
              >
                <Trash2 size={13} strokeWidth={2} />
                {purge.isPending ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div
        role="tablist"
        className="flex gap-1 overflow-x-auto border-b border-[color:var(--border)]"
      >
        {tabs.map((tabDef) => (
          <button
            key={tabDef.key}
            type="button"
            role="tab"
            aria-selected={tab === tabDef.key}
            onClick={() => setTab(tabDef.key)}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-semibold transition-colors",
              tab === tabDef.key
                ? "border-primary text-primary"
                : "border-transparent text-fg2 hover:text-fg1",
            )}
          >
            {tabDef.label}
          </button>
        ))}
      </div>

      {deployment.isPending || !deployment.data ? (
        <GlassCard>
          <p className="text-sm text-fg3">{t("common.loading")}…</p>
        </GlassCard>
      ) : tab === "overview" ? (
        <OverviewTab deployment={deployment.data} />
      ) : tab === "test" ? (
        <TestTab deploymentId={id} />
      ) : tab === "predictions" ? (
        <PredictionsTab deploymentId={id} />
      ) : (
        <LogsTab deploymentId={id} />
      )}
    </div>
  );
}
