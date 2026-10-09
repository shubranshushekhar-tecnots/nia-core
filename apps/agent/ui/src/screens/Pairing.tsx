import { useState } from "react";
import { pair, ApiClientError } from "../apiClient";

interface PairingProps {
  onPaired: () => void;
}

/**
 * One textarea accepts either a bare composite pairing code or a whole
 * pasted `nia-agent pair --code ... --url ...` command -- the backend's
 * `parsePairingInput` (via `POST /ui/api/pair`) handles both, so this
 * screen never needs to parse the text itself.
 */
export function Pairing({ onPaired }: PairingProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  async function handleConnect() {
    if (!code.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await pair(code.trim());
      setDone(true);
      setTimeout(onPaired, 600);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong -- try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agent-screen agent-screen--narrow">
      <h1>Pair this agent</h1>
      <p className="agent-text-muted">Paste the code from Nia Core &rarr; Agents &rarr; Add agent.</p>
      <textarea
        className="agent-input"
        rows={4}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="nia-agent pair --code ... --url ..."
        disabled={busy || done}
      />
      {error && <p className="agent-error">{error}</p>}
      {done ? (
        <p className="agent-success">Paired &#10003;</p>
      ) : (
        <button className="agent-button agent-button--primary" onClick={handleConnect} disabled={busy || !code.trim()}>
          {busy ? "Connecting..." : "Connect"}
        </button>
      )}
    </div>
  );
}
