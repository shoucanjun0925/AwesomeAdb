"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDeviceProfiles } from "./use-device-profiles";
import {
  API_VERSION,
  HELPER_PORT,
  type HelperState,
  type HistoryData,
  type ApiFailure,
  type ConnectionHistory,
} from "../shared/contracts";
const base = `http://127.0.0.1:${HELPER_PORT}/v1`;
const emptyHistory: HistoryData = {
  adbPaths: [],
  connections: [],
  preferences: null,
};
export function useWorkspace() {
  const [helper, setHelper] = useState<HelperState | null>(null),
    [connected, setConnected] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [token, setToken] = useState<string | null>(null),
    tokenRef = useRef<string | null>(null);
  const [history, setHistory] = useState<HistoryData>(emptyHistory),
    [historyError, setHistoryError] = useState("");
  const [toast, setToast] = useState<{
      message: string;
      error: boolean;
    } | null>(null),
    [helperError, setHelperError] = useState("");
  const pending = useRef<object[]>([]),
    machineRef = useRef("");
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  const bridge = useCallback(
    async <T>(route: string, input?: unknown): Promise<T> => {
      if (!tokenRef.current) throw new Error("请先连接本地助手");
      const response = await fetch(base + route, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${tokenRef.current}`,
          ...(input === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: AbortSignal.timeout(180000),
      });
      const value = (await response.json()) as T & ApiFailure;
      if (!response.ok) {
        if (response.status === 401) {
          setConnected(false);
          setToken(null);
          tokenRef.current = null;
          sessionStorage.removeItem("awesomeadb.session");
        }
        throw new Error(value.error?.message || "操作失败");
      }
      return value as T;
    },
    [],
  );
  const loadHistory = useCallback(async (machineId: string) => {
    try {
      const r = await fetch(
        `/api/history?machineId=${encodeURIComponent(machineId)}`,
        { cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      const data = (await r.json()) as HistoryData & ApiFailure;
      if (!r.ok) throw new Error(data.error?.message || "历史同步失败");
      setHistory(data);
      if (!pending.current.length) setHistoryError("");
    } catch (e) {
      setHistoryError((e as Error).message);
    }
  }, []);
  const applyState = useCallback(
    (s: HelperState) => {
      setHelper(s);
      setConnected(true);
      setHelperError("");
      if (machineRef.current !== s.machineId) {
        machineRef.current = s.machineId;
        void loadHistory(s.machineId);
      }
    },
    [loadHistory],
  );
  const connect = useCallback(
    async (restore = false) => {
      setConnecting(true);
      setHelperError("");
      try {
        const health = (await fetch(base + "/health", {
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.json())) as { apiVersion: number };
        if (health.apiVersion !== API_VERSION)
          throw new Error("助手版本与网页不兼容，请更新 Windows 助手");
        const saved = sessionStorage.getItem("awesomeadb.session");
        if (saved) {
          tokenRef.current = saved;
          try {
            const s = await bridge<HelperState>("/state");
            setToken(saved);
            applyState(s);
            return;
          } catch {
            tokenRef.current = null;
            sessionStorage.removeItem("awesomeadb.session");
          }
        }
        if (restore) return;
        const response = await fetch(base + "/session", {
          method: "POST",
          signal: AbortSignal.timeout(180000),
        });
        const value = (await response.json()) as {
          token: string;
          state: HelperState;
        } & ApiFailure;
        if (!response.ok)
          throw new Error(value.error?.message || "本机授权失败");
        tokenRef.current = value.token;
        sessionStorage.setItem("awesomeadb.session", value.token);
        setToken(value.token);
        applyState(value.state);
        notify("本地助手已连接");
      } catch (e) {
        setConnected(false);
        const message = (e as Error).message;
        setHelperError(
          /fetch|network|timeout/i.test(message)
            ? "无法连接助手。请先启动 AwesomeAdb 助手，并允许浏览器访问本地网络。"
            : message,
        );
        if (!restore)
          notify("请检查助手是否启动，以及浏览器的本地网络权限", true);
      } finally {
        setConnecting(false);
        setInitialized(true);
      }
    },
    [applyState, bridge, notify],
  );
  useEffect(() => {
    void connect(true);
  }, [connect]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const stream = async () => {
      try {
        const r = await fetch(base + "/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (!r.ok) throw new Error("事件连接中断");
        const reader = r.body!.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!abort.signal.aborted) {
            const part = await reader.read();
            if (part.done) throw new Error("助手连接中断");
            buffer += decoder.decode(part.value, { stream: true });
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (event.startsWith("data: "))
                applyState(JSON.parse(event.slice(6)));
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        if (!abort.signal.aborted) {
          setConnected(false);
          setHelperError("本地助手连接已中断，请检查助手或重新连接");
          retry = setTimeout(stream, 3000);
        }
      }
    };
    void stream();
    return () => {
      abort.abort();
      clearTimeout(retry);
    };
  }, [token, applyState]);
  const saveHistory = useCallback(
    async (input: object, defer = false) => {
      if (defer) {
        pending.current.push(input);
        setHistoryError("连接记录等待设备备注同步后保存");
        return;
      }
      try {
        const r = await fetch("/api/history", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!r.ok) {
          const value = (await r.json()) as ApiFailure;
          const e = Object.assign(
            new Error(value.error?.message || "历史记录未同步，本机操作已完成"),
            { status: r.status },
          );
          throw e;
        }
        await loadHistory(machineRef.current);
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        if (status && status < 500 && ![408, 429].includes(status)) throw e;
        pending.current.push(input);
        if (pending.current.length > 50) pending.current.shift();
        setHistoryError((e as Error).message);
      }
    },
    [loadHistory],
  );
  const managedPreference = useRef("");
  useEffect(() => {
    if (!connected || helper?.adb.mode !== "managed" || managedPreference.current === helper.machineId) return;
    managedPreference.current = helper.machineId;
    void saveHistory({kind:"preferences",machineId:helper.machineId,mode:"managed",lastPath:null})
      .catch(e => setHistoryError((e as Error).message));
  }, [connected,helper?.machineId,helper?.adb.mode,saveHistory]);
  const retrySync = useCallback(async () => {
    const items = pending.current.splice(0);
    let invalid = "";
    for (const item of items) {
      try {
        await saveHistory(item);
      } catch (e) {
        invalid = (e as Error).message;
      }
    }
    await loadHistory(machineRef.current);
    if (invalid) setHistoryError(invalid);
  }, [saveHistory, loadHistory]);
  const deleteHistory = useCallback(
    async (kind: "adb" | "connection", id?: string) => {
      const r = await fetch("/api/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id, machineId: machineRef.current }),
      });
      if (!r.ok) throw new Error("清理历史记录失败，请稍后重试");
      await loadHistory(machineRef.current);
    },
    [loadHistory],
  );
  const configure = useCallback(
    async (mode: "environment" | "custom", path?: string) => {
      const s = await bridge<HelperState>("/adb/configure", { mode, path });
      applyState(s);
      await saveHistory({
        kind: "preferences",
        machineId: s.machineId,
        mode,
        lastPath: s.adb.path,
      });
      if (mode === "custom")
        await saveHistory({
          kind: "adb",
          machineId: s.machineId,
          path: s.adb.path,
        });
      notify("ADB 配置已保存");
    },
    [bridge, applyState, saveHistory, notify],
  );
  const devices = useDeviceProfiles(helper, connected, bridge);
  const removeSavedDevice = useCallback(
    async (id: string) => {
      await devices.deleteDevice(id);
      pending.current = pending.current.filter(
        (item) => (item as { deviceId?: string }).deviceId !== id,
      );
      await loadHistory(machineRef.current);
    },
    [devices.deleteDevice, loadHistory],
  );
  const connectSaved = useCallback(
    async (item: ConnectionHistory) => {
      const label =
        devices.deviceData.profiles.find((p) => p.id === item.deviceId)
          ?.label || item.label.trim();
      if (!label) throw new Error("请先在连接与设置中补充设备备注");
      const result = await bridge<{ state: HelperState }>("/devices/connect", {
        host: item.host,
        port: item.port,
      });
      applyState(result.state);
      await saveHistory({
        kind: "connection",
        host: item.host,
        port: item.port,
        mode: item.mode,
        label,
        ...(item.deviceId ? { deviceId: item.deviceId } : {}),
      });
      await devices.loadDevices();
    },
    [
      bridge,
      applyState,
      saveHistory,
      devices.deviceData.profiles,
      devices.loadDevices,
    ],
  );
  return {
    ...devices,
    removeSavedDevice,
    initialized,
    connectSaved,
    helper,
    connected,
    connecting,
    connect,
    bridge,
    applyState,
    history,
    historyError,
    helperError,
    saveHistory,
    retrySync,
    deleteHistory,
    configure,
    toast,
    notify,
  };
}
