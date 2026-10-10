import { useEffect, useState } from "react";
import { useOsTheme } from "./theme";
import { getStatus, listConnections, onSessionExpired, checkForUpdateNow, installUpdateNow, type PendingUpdate } from "./apiClient";
import { Pairing } from "./screens/Pairing";
import { ConnectDatabase } from "./screens/ConnectDatabase";
import { DatabaseBrowser } from "./screens/DatabaseBrowser";
import { Home } from "./screens/Home";
import { Workflows } from "./screens/Workflows";
import { WorkflowDetail } from "./screens/WorkflowDetail";
import { Logs } from "./screens/Logs";
import { Settings } from "./screens/Settings";

export type Screen = "pairing" | "connect" | "browse" | "home" | "workflows" | "logs" | "settings";

const NAV_ITEMS: { screen: Screen; label: string }[] = [
  { screen: "home", label: "Home" },
  { screen: "connect", label: "Connect database" },
  { screen: "browse", label: "Browse" },
  { screen: "workflows", label: "Workflows" },
  { screen: "pairing", label: "Pairing" },
  { screen: "logs", label: "Logs" },
  { screen: "settings", label: "Settings" },
];

interface AppProps {
  /** Set by main.tsx when the OTC-for-session exchange failed -- nothing else in this app can work without a session, so this replaces the whole shell. */
  bootError?: string;
}

export function App({ bootError }: AppProps) {
  useOsTheme();
  const [screen, setScreen] = useState<Screen>("home");
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [browseConnectionId, setBrowseConnectionId] = useState<string | undefined>(undefined);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | undefined>(undefined);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | undefined>(undefined);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  useEffect(() => onSessionExpired(() => setSessionExpired(true)), []);

  async function handleUpdateNow() {
    setInstallingUpdate(true);
    try {
      const result = await installUpdateNow();
      if (result.started && pendingUpdate) setPendingUpdate({ ...pendingUpdate, readyToInstall: true });
    } finally {
      setInstallingUpdate(false);
    }
  }

  // First run: paired:false -> Pairing; paired but no saved connections -> Connect DB; otherwise Home.
  useEffect(() => {
    if (bootError) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const status = await getStatus();
        if (!status.paired) {
          setScreen("pairing");
          return;
        }
        // On-open update check (manual flow) -- fire-and-forget, never blocks navigation below.
        checkForUpdateNow()
          .then((result) => setPendingUpdate(result.available ? { version: result.version, readyToInstall: false } : undefined))
          .catch(() => undefined);
        const { connections } = await listConnections();
        if (connections.length === 0) {
          setScreen("connect");
        } else {
          setBrowseConnectionId(connections[0]!.id);
          setScreen("home");
        }
      } catch {
        // A failing first-run check is itself informative on the Home screen -- land there and let it show the problem.
        setScreen("home");
      } finally {
        setLoading(false);
      }
    })();
  }, [bootError]);

  if (bootError) {
    return (
      <div className="agent-boot-error">
        <p>{bootError}</p>
      </div>
    );
  }

  return (
    <div className="agent-shell">
      {sessionExpired && <div className="agent-session-banner">Open Nia Agent again from the Start menu / Applications.</div>}
      {pendingUpdate && !pendingUpdate.readyToInstall && (
        <div className="agent-session-banner">
          Version {pendingUpdate.version} is available.{" "}
          <button className="agent-button agent-button--small" onClick={handleUpdateNow} disabled={installingUpdate}>
            {installingUpdate ? "Starting..." : "Update now"}
          </button>
        </div>
      )}
      {pendingUpdate?.readyToInstall && (
        <div className="agent-session-banner">
          Installer launched for version {pendingUpdate.version} — finish it in the window that opened.
        </div>
      )}
      <nav className="agent-sidebar">
        <div className="agent-sidebar-brand">
          <img src="/logo-mark.png" alt="" />
          <span>Nia Core Agent</span>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.screen}
            className={item.screen === screen ? "agent-nav-item agent-nav-item--active" : "agent-nav-item"}
            onClick={() => {
              setScreen(item.screen);
              if (item.screen !== "workflows") setSelectedWorkflowId(undefined);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main className="agent-main">
        {loading ? (
          <p>Loading...</p>
        ) : (
          <>
            {screen === "pairing" && <Pairing onPaired={() => setScreen("connect")} />}
            {screen === "connect" && (
              <ConnectDatabase
                onConnected={(connectionId) => {
                  setBrowseConnectionId(connectionId);
                  setScreen("home");
                }}
              />
            )}
            {screen === "browse" && <DatabaseBrowser connectionId={browseConnectionId} />}
            {screen === "home" && <Home />}
            {screen === "workflows" &&
              (selectedWorkflowId ? (
                <WorkflowDetail workflowId={selectedWorkflowId} onBack={() => setSelectedWorkflowId(undefined)} />
              ) : (
                <Workflows onOpen={setSelectedWorkflowId} />
              ))}
            {screen === "logs" && <Logs />}
            {screen === "settings" && <Settings />}
          </>
        )}
      </main>
    </div>
  );
}
