import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function installCommand(home: string, name: string) {
  const dir = path.join(home, ".local", "bin");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}
