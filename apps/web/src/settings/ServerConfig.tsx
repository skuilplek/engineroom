import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  connectServerWifi,
  disconnectServerWifi,
  getServerNetwork,
  saveServerHostname,
  scanServerWifi,
  startUpdate,
  updateStatus,
  type ServerNetwork,
  type ServerWifiInterface,
  type UpdateRun,
  type WifiNetwork,
} from "../api.ts";
import { useReportError } from "../errors.tsx";

export function ServerConfig() {
  const report = useReportError();
  const [status, setStatus] = useState<ServerNetwork | null>(null);
  const [hostname, setHostname] = useState("engineroom");
  const [iface, setIface] = useState("");
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [nameNote, setNameNote] = useState("");
  const [wifiNote, setWifiNote] = useState("");

  const applyStatus = useCallback((next: ServerNetwork, keepName = false) => {
    setStatus(next);
    if (!keepName) setHostname(next.hostname);
    setIface((current) => (
      current && next.wifi.interfaces.some((item) => item.name === current)
        ? current
        : next.wifi.interfaces[0]?.name ?? ""
    ));
  }, []);

  useEffect(() => {
    let cancel = false;
    setBusy(true);
    getServerNetwork().then((next) => {
      if (!cancel) applyStatus(next);
    }).catch((error) => {
      if (!cancel) report("Server", error);
    }).finally(() => {
      if (!cancel) {
        setBusy(false);
        setChecked(true);
      }
    });
    return () => {
      cancel = true;
    };
  }, [applyStatus, report]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNameNote("");
    try {
      const next = await saveServerHostname(hostname);
      applyStatus(next);
      setNameNote("Network name saved");
    } catch (error) {
      report("Server", error);
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    if (!iface) return;
    setBusy(true);
    setWifiNote("");
    try {
      const result = await scanServerWifi(iface);
      setNetworks(result.networks);
      setWifiNote(result.networks.length === 0 ? "No networks found" : "");
    } catch (error) {
      report("Server", error);
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!iface || !ssid.trim()) return;
    setBusy(true);
    setWifiNote("");
    try {
      const next = await connectServerWifi(iface, ssid.trim(), password);
      applyStatus(next, true);
      setPassword("");
      const joined = next.wifi.interfaces.find((item) => item.name === iface)?.ssid;
      setWifiNote(joined ? `Connected to ${joined}` : "Wi-Fi saved");
    } catch (error) {
      report("Server", error);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!iface) return;
    setBusy(true);
    setWifiNote("");
    try {
      applyStatus(await disconnectServerWifi(iface), true);
      setPassword("");
      setWifiNote("Disconnected");
    } catch (error) {
      report("Server", error);
    } finally {
      setBusy(false);
    }
  }

  const current = status?.wifi.interfaces.find((item) => item.name === iface);
  const address = status?.url ?? "http://engineroom.local";
  const nameDirty = status ? hostname !== status.hostname : hostname !== "engineroom";

  return (
    <div className="agents-stack">
      <UpdateCard />
      <form className="agents-card" onSubmit={(event) => void saveName(event)}>
        <div className="agents-card-head">
          <h2>Network name</h2>
          <p className="muted">
            Other computers on this network can open <strong className="server-address">{address}</strong>.
          </p>
        </div>
        {!status && <p className="muted">{checked ? "This machine could not be checked." : "Checking this machine."}</p>}
        {status && (
          <label>
            Name
            <input
              value={hostname}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="engineroom"
              onChange={(event) => setHostname(event.target.value)}
              required
            />
          </label>
        )}
        {status && !status.port80 && (
          <p className="muted">This name resolves on the local network. Sign in on the HTTPS address for this site. The session cookie is only sent over HTTPS.</p>
        )}
        {status && !status.avahi && (
          <p className="muted">Avahi is not running. Saving the name starts it.</p>
        )}
        {nameNote && <p className="admin-note" role="status">{nameNote}</p>}
        <div className="row-actions">
          <button
            className="ghost"
            type="button"
            disabled={!status || !nameDirty || busy}
            onClick={() => {
              setHostname(status?.hostname ?? "engineroom");
              setNameNote("");
            }}
          >
            Discard
          </button>
          <button className="primary" type="submit" disabled={!status || busy}>Save</button>
        </div>
      </form>

      <section className="agents-card" aria-label="Wi-Fi">
        <div className="agents-card-head">
          <h2>Wi-Fi</h2>
          {!status && <p className="muted">{checked ? "This machine could not be checked." : "Checking this machine."}</p>}
          {status && !status.wifi.available && <p className="muted">No wireless adapter.</p>}
        </div>
        {status?.wifi.available && (
          <WifiForm
            interfaces={status.wifi.interfaces}
            iface={iface}
            current={current}
            backend={status.wifi.backend}
            networks={networks}
            ssid={ssid}
            password={password}
            busy={busy}
            onIface={setIface}
            onSsid={setSsid}
            onPassword={setPassword}
            onScan={() => void scan()}
            onConnect={(event) => void connect(event)}
            onDisconnect={() => void disconnect()}
          />
        )}
        {wifiNote && <p className="admin-note" role="status">{wifiNote}</p>}
      </section>
    </div>
  );
}

function UpdateCard() {
  const report = useReportError();
  const [ask, setAsk] = useState(false);
  const [password, setPassword] = useState("");
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<UpdateRun | null>(null);
  const [waiting, setWaiting] = useState(false);
  const watching = useRef(false);
  const shellRef = useRef<HTMLPreElement>(null);

  const poll = useCallback(async () => {
    try {
      const next = await updateStatus();
      watching.current = next.status === "running";
      setWaiting(false);
      setRun(next.status === "idle" && next.log.length === 0 ? null : next);
    } catch (err) {
      if (err instanceof ApiError) return;
      if (watching.current) setWaiting(true);
    }
  }, []);

  useEffect(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    if (run?.status !== "running" && !waiting) return undefined;
    const timer = window.setInterval(() => {
      void poll();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [poll, run?.status, waiting]);

  useEffect(() => {
    const node = shellRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [run?.log, waiting]);

  function closeAsk() {
    setPassword("");
    setAsk(false);
  }

  async function submitUpdate(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    try {
      const next = await startUpdate(password);
      setPassword("");
      setAsk(false);
      watching.current = true;
      setWaiting(false);
      setRun(next);
    } catch (err) {
      if (err instanceof ApiError) {
        report("Update", err);
      } else {
        setPassword("");
        setAsk(false);
        watching.current = true;
        setWaiting(true);
        setRun((current) => current?.status === "running" ? current : { status: "running", log: current?.log ?? "" });
      }
    } finally {
      setStarting(false);
    }
  }

  const updating = starting || waiting || run?.status === "running";
  const shellText = run?.log ? run.log : (run?.status === "running" && !waiting ? "Starting the update…" : "");
  const showShell = run !== null || waiting;

  return (
    <section className="agents-card" aria-label="Update">
      <div className="agents-card-head">
        <h2>Update</h2>
        <p className="muted">Pull this checkout, install it, and restart. This asks for the sudo password of the administrator account.</p>
      </div>
      <div className="row-actions">
        <button className="primary" type="button" disabled={updating} onClick={() => setAsk(true)}>{updating ? "Updating…" : "Update"}</button>
      </div>
      {showShell && (
        <div className="update-output">
          <pre className="update-shell" ref={shellRef} aria-label="Update output">{shellText}</pre>
          {waiting && <p className="update-waiting muted" role="status">Waiting for the server…</p>}
        </div>
      )}
      {ask && (
        <div className="modal-backdrop">
          <form className="confirm-dialog" role="dialog" aria-labelledby="update-title" aria-modal="true" onSubmit={(event) => void submitUpdate(event)}>
            <h2 id="update-title">Update Engineroom</h2>
            <p className="muted">Enter the sudo password for this account. The page shows the script output and waits while the server comes back.</p>
            <label>
              Sudo password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                autoFocus
                required
                disabled={starting}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div className="confirm-actions">
              <button type="button" onClick={closeAsk} disabled={starting}>Cancel</button>
              <button className="primary" type="submit" disabled={starting}>{starting ? "Updating…" : "Update"}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function WifiForm({
  interfaces,
  iface,
  current,
  backend,
  networks,
  ssid,
  password,
  busy,
  onIface,
  onSsid,
  onPassword,
  onScan,
  onConnect,
  onDisconnect,
}: {
  interfaces: ServerWifiInterface[];
  iface: string;
  current: ServerWifiInterface | undefined;
  backend: ServerNetwork["wifi"]["backend"];
  networks: WifiNetwork[];
  ssid: string;
  password: string;
  busy: boolean;
  onIface: (value: string) => void;
  onSsid: (value: string) => void;
  onPassword: (value: string) => void;
  onScan: () => void;
  onConnect: (event: FormEvent) => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      {interfaces.length > 1 && (
        <label>
          Adapter
          <select value={iface} onChange={(event) => onIface(event.target.value)}>
            {interfaces.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
      )}
      {interfaces.length === 1 && <p className="muted">Adapter {interfaces[0]?.name}</p>}
      <p className="muted">
        {current?.ssid
          ? `Connected to ${current.ssid}${current.signal == null ? "" : ` · ${current.signal}%`}`
          : "Not connected."}
      </p>
      {backend === "none" && <p className="muted">Saving a network needs NetworkManager or netplan.</p>}
      <div className="row-actions">
        <button className="ghost" type="button" disabled={busy || !iface} onClick={onScan}>Scan</button>
        <button className="ghost" type="button" disabled={busy || !iface || !current?.ssid} onClick={onDisconnect}>Disconnect</button>
      </div>
      {networks.length > 0 && (
        <ul className="wifi-list">
          {networks.map((network) => (
            <li key={network.ssid}>
              <button
                className={ssid === network.ssid ? "wifi-pick selected" : "wifi-pick"}
                type="button"
                aria-pressed={ssid === network.ssid}
                onClick={() => onSsid(network.ssid)}
              >
                <strong>{network.ssid}</strong>
                <span>{network.security ? `${network.security} · ${network.signal}%` : `${network.signal}%`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onConnect}>
        <label>
          Network
          <input
            value={ssid}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Hidden network"
            onChange={(event) => onSsid(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </label>
        <p className="muted">Leave the password blank for an open network.</p>
        <button className="primary" type="submit" disabled={busy || !iface || !ssid.trim()}>Connect</button>
      </form>
    </>
  );
}
