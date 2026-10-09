import { useEffect, useRef, useState } from "react";
import { getLogs, getDiagnostics, streamLogs, ApiClientError, type ParsedLogLine } from "../apiClient";

type LevelFilter = "all" | "info" | "warn" | "error";

export function Logs() {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getLogs({ level: level === "all" ? undefined : level, search: search || undefined })
      .then(({ entries }) => setLines(entries))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load logs."));
  }, [level, search]);

  useEffect(() => {
    const unsubscribe = streamLogs((line) => setLines((prev) => [...prev, line]));
    return unsubscribe;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  async function copyDiagnostics() {
    try {
      const diagnostics = await getDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't copy diagnostics.");
    }
  }

  return (
    <div className="agent-screen">
      <h1>Logs</h1>
      <div className="agent-button-row">
        {(["all", "info", "warn", "error"] as const).map((l) => (
          <button key={l} className={l === level ? "agent-button agent-button--primary" : "agent-button"} onClick={() => setLevel(l)}>
            {l}
          </button>
        ))}
        <input className="agent-input agent-input--inline" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="agent-button" onClick={copyDiagnostics}>
          {copied ? "Copied!" : "Copy diagnostics"}
        </button>
      </div>

      {error && <p className="agent-error">{error}</p>}

      <div className="agent-log-tail">
        {lines.map((line, i) => (
          <div key={i} className={`agent-log-line agent-log-line--${line.level}`}>
            <span className="agent-text-muted">{line.ts}</span> [{line.level}] {line.event}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
