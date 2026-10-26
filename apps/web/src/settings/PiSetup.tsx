import { useState } from "react";
import { setupPi, type Session } from "../api.ts";
import { message } from "../format.ts";

export function PiSetupNotice({
  onReady,
}: {
  onReady: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const session = await setupPi();
      setDone("Pi is ready.");
      onReady(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pi-setup">
      <p className="muted">Install Pi for this account.</p>
      <button className="primary" type="button" disabled={busy} onClick={() => void run()}>Set up Pi</button>
      {done && <p className="muted">{done}</p>}
      {error && <p className="alert" role="alert">{error}</p>}
    </div>
  );
}
