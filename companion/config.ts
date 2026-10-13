import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AdbMode } from "../shared/contracts";
export interface LocalConfig {
  machineId: string;
  mode: AdbMode;
  customPath: string | null;
  adbVersion?: string | null;
  previousAdbVersion?: string | null;
}
export const dataDirectory =
  process.env.AWESOME_ADB_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), "AwesomeAdb");
mkdirSync(dataDirectory, { recursive: true });
const configFile = path.join(dataDirectory, "config-v2.json");
export function loadConfig(): LocalConfig {
  let previousMachineId: string | null = null;
  try {
    const v = JSON.parse(readFileSync(configFile, "utf8"));
    if (typeof v.machineId === "string" && v.machineId.length > 0 && v.machineId.length <= 100)
      previousMachineId = v.machineId;
    if (
      typeof v.machineId === "string" &&
      v.mode === "managed"
    )
      return v;
  } catch {
    /* First run or interrupted settings write. */
  }
  try {
    const old = JSON.parse(readFileSync(path.join(dataDirectory, "config.json"), "utf8"));
    if (!previousMachineId && typeof old.machineId === "string" && old.machineId.length > 0 && old.machineId.length <= 100)
      previousMachineId = old.machineId;
  } catch { /* Fresh installation. */ }
  const v: LocalConfig = {
    machineId: previousMachineId || randomUUID(),
    mode: "managed",
    customPath: null,
    adbVersion: null,
    previousAdbVersion: null,
  };
  saveConfig(v);
  return v;
}
export function saveConfig(value: LocalConfig) {
  const temp = configFile + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, configFile);
}
export function environmentAdb(): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ""), "adb.exe");
    if (existsSync(p)) return p;
  }
  return null;
}
