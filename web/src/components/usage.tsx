import { useEffect, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/16/solid";
import { usage, type UsageReport } from "../lib/api";
import { ago, duration } from "../lib/time";

const names = { "openai-codex": "ChatGPT", anthropic: "Claude" } as const;

/** Per-account limit bars: 5h / 7d (and model-specific) windows with reset times. */
export function UsageLimits() {
  const [reports, setReports] = useState<readonly UsageReport[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function load(refresh: boolean) {
    setPending(true);
    setError("");

    try {
      setReports(await usage(refresh));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load usage.");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, []);

  const connected = reports?.filter((report) => report.connected) ?? [];

  return (
    <div className="usage">
      <div className="usage-header">
        <h2>Usage limits</h2>
        <button
          type="button"
          className="secondary-button"
          disabled={pending}
          onClick={() => void load(true)}
        >
          <ArrowPathIcon width={14} className={pending ? "spin" : undefined} />
          Refresh usage
        </button>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {reports && connected.length === 0 && (
        <p className="muted">Sign in to a subscription to see its limits.</p>
      )}
      {connected.map((report) => (
        <div key={report.providerId} className="usage-account">
          <div className="usage-account-name">
            {names[report.providerId]}
            <span className="muted">
              {report.usage
                ? `${report.usage.source === "live" ? "Updated" : "Seen on last run"} ${ago(report.usage.observedAt)} ago`
                : (report.error ?? "No usage reported yet")}
            </span>
          </div>
          {report.usage && (
            <div className="usage-bars">
              {report.usage.windows.map((window) => (
                <UsageBar key={window.label} {...window} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function UsageBar({
  label,
  usedPercent,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}) {
  const percent = Math.round(usedPercent);
  const level = percent >= 90 ? "critical" : percent >= 70 ? "warning" : "";

  return (
    <div className="usage-bar">
      <div className="usage-bar-label">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div
        className={`usage-bar-track ${level}`}
        role="progressbar"
        aria-label={`${label} limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }} />
      </div>
      {resetsAt !== null && (
        <span className="usage-bar-reset">
          {resetsAt > Date.now() ? `resets in ${duration(resetsAt - Date.now())}` : "reset"}
        </span>
      )}
    </div>
  );
}
