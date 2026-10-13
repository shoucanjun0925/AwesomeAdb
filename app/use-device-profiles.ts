"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiFailure,
  DeviceData,
  DeviceIdentity,
  HelperState,
} from "../shared/contracts";
import {
  applyDeviceMutation,
  deviceMutationSchema,
  emptyDeviceData,
  nameDevices,
  type DeviceMutation,
} from "../shared/devices";

class CloudError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function cloud<T>(method: string, input?: unknown): Promise<T> {
  const response = await fetch("/api/devices", {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: input ? { "Content-Type": "application/json" } : undefined,
    body: input ? JSON.stringify(input) : undefined,
  });
  const data = (await response.json()) as T & ApiFailure;
  if (!response.ok)
    throw new CloudError(
      data.error?.message || "设备备注同步失败",
      response.status,
    );
  return data;
}
export function useDeviceProfiles(
  helper: HelperState | null,
  connected: boolean,
  bridge: <T>(route: string, input?: unknown) => Promise<T>,
) {
  const [data, setData] = useState<DeviceData>(emptyDeviceData),
    dataRef = useRef(data);
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const [identities, setIdentities] = useState<Record<string, string | null>>(
    {},
  );
  const [pendingIds, setPendingIds] = useState(new Set<string>());
  const pending = useRef<DeviceMutation[]>([]),
    remote = useRef<DeviceData>(emptyDeviceData);
  const syncing = useRef<Promise<Map<DeviceMutation, Error>> | null>(null);
  const identifying = useRef(new Set<string>()),
    automaticLinks = useRef(new Set<string>());
  const update = useCallback((value: DeviceData) => {
    dataRef.current = value;
    setData(value);
  }, []);
  const overlay = useCallback(() => {
    let value = remote.current;
    for (const item of pending.current) {
      try {
        value = applyDeviceMutation(value, item);
      } catch {
        /* Conflicts are shown when sync is retried. */
      }
    }
    update(value);
    setPendingIds(new Set(pending.current.map((p) => p.id)));
  }, [update]);
  const loadDevices = useCallback(async () => {
    try {
      remote.current = await cloud<DeviceData>("GET");
      overlay();
      if (!pending.current.length) setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [overlay]);
  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);
  const flushDevices = useCallback(async () => {
    if (syncing.current) return syncing.current;
    const work = async () => {
      const rejected = new Map<DeviceMutation, Error>();
      let offline = false;
      do {
        while (pending.current.length) {
          const item = pending.current[0];
          try {
            await cloud("POST", item);
            remote.current = applyDeviceMutation(remote.current, item);
            pending.current.shift();
          } catch (e) {
            if (
              e instanceof CloudError &&
              e.status < 500 &&
              ![408, 429].includes(e.status)
            ) {
              pending.current.shift();
              rejected.set(item, e);
            } else {
              offline = true;
              break;
            }
          }
          overlay();
        }
        await loadDevices();
        // A second edit may have arrived while the latest cloud data was loading.
      } while (!offline && pending.current.length);
      if (offline)
        setError("设备备注未同步，当前页面仍可操作。关闭网页前请重试同步。");
      else if (rejected.size) setError([...rejected.values()].at(-1)!.message);
      return rejected;
    };
    const running = work();
    syncing.current = running;
    try {
      return await running;
    } finally {
      syncing.current = null;
    }
  }, [loadDevices, overlay]);
  const saveDevice = useCallback(
    async (raw: DeviceMutation) => {
      const input = deviceMutationSchema.parse(raw);
      // Invalid values never reach the optimistic state or retry queue.
      applyDeviceMutation(dataRef.current, input);
      pending.current.push(input);
      overlay();
      const rejected = await flushDevices();
      if (rejected.has(input)) throw rejected.get(input)!;
      return { id: input.id, synced: !pending.current.includes(input) };
    },
    [flushDevices, overlay],
  );
  const retryDeviceSync = useCallback(async () => {
    const rejected = await flushDevices();
    return !rejected.size && !pending.current.length;
  }, [flushDevices]);
  const deleteDevice = useCallback(
    async (id: string) => {
      if (syncing.current) await syncing.current;
      await cloud("DELETE", { id });
      pending.current = pending.current.filter((p) => p.id !== id);
      await loadDevices();
    },
    [loadDevices],
  );
  const context = `${helper?.machineId || ""}|${helper?.adb.path || ""}`;
  const online =
    helper?.devices
      .filter((d) => d.state === "device")
      .map((d) => d.serial)
      .sort()
      .join("\n") || "";
  const identitySupported = !!helper?.capabilities.includes("device-identity");
  useEffect(() => {
    identifying.current.clear();
    automaticLinks.current.clear();
    setIdentities({});
  }, [context]);
  useEffect(() => {
    if (!connected || helper?.adb.server !== "running") return;
    let cancelled = false;
    const requested: string[] = [];
    const serials = online ? online.split("\n") : [];
    setIdentities((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => serials.includes(key)),
      ),
    );
    for (const serial of serials) {
      const key = `${context}|${serial}`;
      if (identifying.current.has(key)) continue;
      identifying.current.add(key);
      requested.push(key);
      if (!identitySupported) continue;
      void bridge<DeviceIdentity>(
        `/devices/identity?serial=${encodeURIComponent(serial)}`,
      )
        .then((value) => {
          if (!cancelled)
            setIdentities((old) => ({ ...old, [serial]: value.identityKey }));
        })
        .catch(() => {
          /* Manual association is available for older or restricted devices. */
        });
    }
    for (const key of identifying.current)
      if (!serials.some((s) => key === `${context}|${s}`))
        identifying.current.delete(key);
    return () => {
      cancelled = true;
      for (const key of requested) identifying.current.delete(key);
    };
  }, [
    online,
    context,
    connected,
    helper?.adb.server,
    identitySupported,
    bridge,
  ]);
  const namedDevices = useMemo(
    () => nameDevices(helper?.devices || [], data, identities, pendingIds),
    [helper?.devices, data, identities, pendingIds],
  );
  useEffect(() => {
    if (!loaded) return;
    for (const device of namedDevices) {
      if (!device.profileId || device.conflict) continue;
      const missing = device.bindingKeys.filter(
        (key) =>
          !data.bindings.some(
            (b) => b.bindingKey === key && b.profileId === device.profileId,
          ),
      );
      if (!missing.length) continue;
      const key = `${device.profileId}|${missing.join(";")}`;
      if (automaticLinks.current.has(key)) continue;
      automaticLinks.current.add(key);
      void saveDevice({
        kind: "link",
        id: device.profileId,
        bindingKeys: missing,
        reassign: false,
      }).catch((e) => setError((e as Error).message));
    }
  }, [namedDevices, data.bindings, loaded, saveDevice]);
  return {
    deviceData: data,
    devicesLoaded: loaded,
    deviceError: error,
    namedDevices,
    pendingDeviceIds: pendingIds,
    loadDevices,
    saveDevice,
    retryDeviceSync,
    deleteDevice,
  };
}
