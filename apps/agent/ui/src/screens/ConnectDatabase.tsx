import { useEffect, useState } from "react";
import {
  listServers,
  testConnection,
  saveConnection,
  ApiClientError,
  type WindowsSqlInstance,
  type TestConnectionResult,
} from "../apiClient";

interface ConnectDatabaseProps {
  onConnected: (connectionId: string) => void;
}

type Step = "server" | "credentials" | "database";

/** 3-step wizard: pick a discovered server (or type a host) -> credentials -> pick a database to save. */
export function ConnectDatabase({ onConnected }: ConnectDatabaseProps) {
  const [step, setStep] = useState<Step>("server");
  const [servers, setServers] = useState<WindowsSqlInstance[]>([]);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [loginMode, setLoginMode] = useState<number | undefined>(undefined);

  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<TestConnectionResult | undefined>(undefined);

  const [database, setDatabase] = useState("");
  const [label, setLabel] = useState("");
  const [sourceTimeZone, setSourceTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    listServers()
      .then(({ instances }) => setServers(instances))
      .catch(() => setServers([]));
  }, []);

  function pickServer(instance: WindowsSqlInstance) {
    setHost("localhost");
    setInstanceName(instance.name);
    setPort(instance.port ? String(instance.port) : "");
    setLoginMode(instance.loginMode);
    setStep("credentials");
  }

  function continueManualHost() {
    if (!host.trim()) return;
    setLoginMode(undefined);
    setStep("credentials");
  }

  async function handleTest() {
    setTesting(true);
    setTestError(undefined);
    setTestResult(undefined);
    try {
      const result = await testConnection(
        {
          host,
          instanceName: instanceName || undefined,
          port: port ? Number(port) : undefined,
          user,
          password,
        },
        loginMode,
      );
      setTestResult(result);
      if (result.ok) {
        setLabel(instanceName ? `${host}\\${instanceName}` : host);
        setStep("database");
      }
    } catch (err) {
      setTestError(err instanceof ApiClientError ? err.message : "Something went wrong -- try again.");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!testResult?.ok || !database) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const entry = await saveConnection({
        id: crypto.randomUUID(),
        label: label || host,
        host,
        instanceName: instanceName || undefined,
        port: port ? Number(port) : undefined,
        database,
        user,
        password,
        sourceTimeZone,
        trustServerCertificate: testResult.autoTrustedCertificate || undefined,
        allowLegacyTls: testResult.autoAllowedLegacyTls || undefined,
      });
      onConnected(entry.id);
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : "Something went wrong -- try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-screen agent-screen--narrow">
      <h1>Connect a database</h1>

      {step === "server" && (
        <>
          {servers.length > 0 && (
            <div className="agent-list">
              {servers.map((instance) => (
                <button key={instance.instanceId} className="agent-list-item" onClick={() => pickServer(instance)}>
                  {instance.name}
                  {!instance.tcpEnabled && <span className="agent-text-muted"> (TCP/IP disabled)</span>}
                </button>
              ))}
            </div>
          )}
          <p className="agent-text-muted">Or enter a server manually:</p>
          <input className="agent-input" placeholder="Host" value={host} onChange={(e) => setHost(e.target.value)} />
          <input className="agent-input" placeholder="Named instance (optional)" value={instanceName} onChange={(e) => setInstanceName(e.target.value)} />
          <input className="agent-input" placeholder="Port (optional)" value={port} onChange={(e) => setPort(e.target.value)} />
          <button className="agent-button agent-button--primary" onClick={continueManualHost} disabled={!host.trim()}>
            Continue
          </button>
        </>
      )}

      {step === "credentials" && (
        <>
          <p className="agent-text-muted">{instanceName ? `${host}\\${instanceName}` : host}</p>
          <input className="agent-input" placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} />
          <input className="agent-input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {testError && <p className="agent-error">{testError}</p>}
          {testResult && !testResult.ok && <p className="agent-error">{testResult.reason}</p>}
          <div className="agent-button-row">
            <button className="agent-button" onClick={() => setStep("server")}>
              Back
            </button>
            <button className="agent-button agent-button--primary" onClick={handleTest} disabled={testing || !user || !password}>
              {testing ? "Testing..." : "Test connection"}
            </button>
          </div>
        </>
      )}

      {step === "database" && testResult?.ok && (
        <>
          {(testResult.autoTrustedCertificate || testResult.autoAllowedLegacyTls) && (
            <p className="agent-text-muted">
              Connected using a relaxed TLS setting for this server (
              {[testResult.autoTrustedCertificate && "untrusted certificate", testResult.autoAllowedLegacyTls && "legacy TLS"]
                .filter(Boolean)
                .join(", ")}
              ).
            </p>
          )}
          <label className="agent-label">
            Database
            <select className="agent-input" value={database} onChange={(e) => setDatabase(e.target.value)}>
              <option value="" disabled>
                Choose a database
              </option>
              {testResult.databases.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <input className="agent-input" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="agent-input" placeholder="Time zone" value={sourceTimeZone} onChange={(e) => setSourceTimeZone(e.target.value)} />
          {saveError && <p className="agent-error">{saveError}</p>}
          <div className="agent-button-row">
            <button className="agent-button" onClick={() => setStep("credentials")}>
              Back
            </button>
            <button className="agent-button agent-button--primary" onClick={handleSave} disabled={saving || !database}>
              {saving ? "Saving..." : "Save connection"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
