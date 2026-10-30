import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  connectServerWifi,
  disconnectServerWifi,
  getServerNetwork,
  saveServerHostname,
  scanServerWifi,
  type ServerNetwork,
  type ServerWifiInterface,
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
