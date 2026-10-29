import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanInterface, cleanSsid, cleanWifiPassword, normalizeHostname } from "../apps/hub/src/network.ts";

const script = path.join(import.meta.dirname, "../deploy/bin/engineroom-network");

function run(args: string[]) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8" });
}

test("network names drop a trailing .local and reject localhost", () => {
  assert.equal(normalizeHostname("Engineroom.local"), "engineroom");
  assert.equal(normalizeHostname("  ENGINEROOM.LOCAL  "), "engineroom");
  assert.equal(normalizeHostname("engineroom"), "engineroom");
  assert.equal(normalizeHostname("a"), "a");
  assert.equal(normalizeHostname(`${"a".repeat(63)}`), "a".repeat(63));
  assert.equal(normalizeHostname(`a${"-".repeat(61)}b`), `a${"-".repeat(61)}b`);
  for (const value of ["", "localhost", "localhost.local", "a-", "-a", "has space", "under_score", "a".repeat(64), "engineroom.local.extra", 12]) {
    assert.throws(() => normalizeHostname(value), /invalid hostname/);
  }
});

test("wifi fields reject unsafe names and short passwords", () => {
  assert.equal(cleanInterface("wlan0"), "wlan0");
  assert.equal(cleanInterface("wlp2s0"), "wlp2s0");
  assert.throws(() => cleanInterface("wlan0 extra"), /invalid interface/);
  assert.throws(() => cleanInterface("../wlan0"), /invalid interface/);
  assert.equal(cleanSsid("Office Wi-Fi"), "Office Wi-Fi");
  assert.throws(() => cleanSsid(""), /invalid network/);
  assert.throws(() => cleanSsid("-hidden"), /invalid network/);
  assert.throws(() => cleanSsid("bad\nname"), /invalid network/);
  assert.throws(() => cleanSsid("x".repeat(33)), /invalid network/);
  assert.equal(cleanWifiPassword(undefined), "");
  assert.equal(cleanWifiPassword(""), "");
  assert.equal(cleanWifiPassword("12345678"), "12345678");
  assert.equal(cleanWifiPassword("ab".repeat(32)), "ab".repeat(32));
  assert.throws(() => cleanWifiPassword("short"), /invalid password/);
  assert.throws(() => cleanWifiPassword("nope\n"), /invalid password/);
  assert.throws(() => cleanWifiPassword("z".repeat(64)), /invalid password/);
});

test("engineroom-network rejects bad names before it changes the host", () => {
  const before = readFileSync("/etc/hostname", "utf8");
  const invalid = run(["hostname", "../bad"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid hostname/);

  const local = run(["hostname", "localhost.local"]);
  assert.match(local.stderr, /invalid hostname/);

  const tooLong = run(["hostname", "a".repeat(64)]);
  assert.match(tooLong.stderr, /invalid hostname/);

  const iface = run(["scan", "bad name"]);
  assert.match(iface.stderr, /invalid interface/);

  const wired = run(["scan", "lo"]);
  assert.match(wired.stderr, /not a wireless interface/);

  const connect = run(["connect", "lo", "Office"]);
  assert.match(connect.stderr, /not a wireless interface/);

  const disconnect = run(["disconnect", "notreal0"]);
  assert.match(disconnect.stderr, /not a wireless interface/);

  assert.equal(readFileSync("/etc/hostname", "utf8"), before);

  if ((process.getuid?.() ?? 0) === 0) return;
  const accepted = run(["hostname", "Engineroom.local"]);
  assert.notEqual(accepted.status, 0);
  assert.match(accepted.stderr, /must run as root/);
  assert.equal(readFileSync("/etc/hostname", "utf8"), before);
});
