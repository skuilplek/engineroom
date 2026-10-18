import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(tmpdir(), `engineroom-peercred-${process.pid}`);
const source = path.join(root, "deploy/pam/engineroom-peercred.c");
const built = spawnSync("gcc", ["-O2", "-Wall", "-o", helper, source], { encoding: "utf8" });
if (built.status !== 0) {
  throw new Error(built.stderr || built.stdout || "peercred helper failed to compile");
}
process.env.ENGINEROOM_PEERCRED = helper;
