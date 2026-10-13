export const API_VERSION = 1;
export const HELPER_PORT = 27183;
export const APP_VERSION = "0.3.0";
export type AdbMode = "managed" | "environment" | "custom";
export interface AdbRuntimeState {
  installedVersion: string | null;
  latestVersion: string | null;
  previousVersion: string | null;
  status: "ready" | "checking" | "downloading" | "installing" | "error";
  completedBytes: number;
  totalBytes: number;
  error: string | null;
  checkedAt: number | null;
}
export type ConnectionMode = "tcp" | "paired";
export interface AdbConfiguration {
  mode: AdbMode;
  path: string | null;
  version: string | null;
  environmentPath: string | null;
  valid: boolean;
  server: "running" | "stopped";
  serverSource?: "managed" | "shared" | "unknown";
  serverVersion?: string | null;
  serviceError?: string | null;
  updatePendingRestart?: boolean;
}
export interface Device {
  serial: string;
  state: string;
  model: string;
  transport: "usb" | "tcp" | "emulator";
}
export interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  modifiedAt: number;
  mode: number;
}
export type JobState =
  "queued" | "running" | "conflict" | "succeeded" | "failed" | "cancelled";
export type ConflictAction = "overwrite" | "skip" | "keep-both";
export interface JobConflict {
  source: string;
  destination: string;
  directory: boolean;
}
export interface Job {
  id: string;
  kind: "upload" | "download" | "delete";
  label: string;
  serial: string;
  state: JobState;
  phase: string;
  createdAt: number;
  finishedAt?: number;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  speed: number;
  currentPath?: string;
  errors: { path: string; message: string }[];
  skipped: number;
  conflict?: JobConflict;
  retryable: boolean;
}
export interface HelperState {
  app: "AwesomeAdb";
  apiVersion: number;
  version: string;
  machineId: string;
  machineName: string;
  adb: AdbConfiguration;
  devices: Device[];
  jobs: Job[];
  capabilities: string[];
  adbRuntime?: AdbRuntimeState;
}
export interface AdbPathHistory {
  id: string;
  path: string;
  lastUsedAt: number;
}
export interface ConnectionHistory {
  id: string;
  host: string;
  port: number;
  mode: ConnectionMode;
  label: string;
  lastUsedAt: number;
  deviceId?: string | null;
}
export interface DeviceIdentity {
  identityKey: string | null;
}
export interface DeviceProfile {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}
export interface DeviceBinding {
  profileId: string;
  bindingKey: string;
}
export interface DeviceData {
  profiles: DeviceProfile[];
  bindings: DeviceBinding[];
}
export interface NamedDevice extends Device {
  profileId: string | null;
  label: string;
  identityKey: string | null;
  bindingKeys: string[];
  conflict: boolean;
  pending: boolean;
}
export interface Preferences {
  mode: AdbMode;
  lastPath: string | null;
}
export interface HistoryData {
  adbPaths: AdbPathHistory[];
  connections: ConnectionHistory[];
  preferences: Preferences | null;
}
export interface ModuleManifest {
  id: string;
  name: string;
  route: string;
  icon: "folder";
  requiredCapabilities: string[];
}
export const modules: ModuleManifest[] = [
  {
    id: "files",
    name: "文件管理",
    route: "/files",
    icon: "folder",
    requiredCapabilities: ["files"],
  },
];
export interface ApiFailure {
  error: { code: string; message: string };
}
