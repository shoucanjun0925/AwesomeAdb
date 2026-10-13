import { z } from "zod";
import type { Device, DeviceData, NamedDevice } from "./contracts";

export const deviceLabelSchema = z
  .string()
  .trim()
  .min(1, "请填写设备备注")
  .max(100, "备注最多 100 个字符");
const bindingKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(usb|tcp|emulator|hardware)\|/);
export const deviceMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save"),
    id: z.string().min(1).max(100),
    label: deviceLabelSchema,
    bindingKeys: z.array(bindingKeySchema).max(6).default([]),
    reassign: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("link"),
    id: z.string().min(1).max(100),
    bindingKeys: z.array(bindingKeySchema).min(1).max(6),
    reassign: z.boolean().default(false),
  }),
]);
export type DeviceMutation = z.infer<typeof deviceMutationSchema>;
export const emptyDeviceData: DeviceData = { profiles: [], bindings: [] };
export function endpointBindingKey(host: string, port: number) {
  return `tcp|${host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase()}|${port}`;
}
export function transportBindingKey(
  device: Pick<Device, "serial" | "transport">,
) {
  if (device.transport === "tcp") {
    const match = /^(?:\[([^\]]+)\]|(.+)):(\d+)$/.exec(device.serial);
    if (match)
      return endpointBindingKey(match[1] || match[2], Number(match[3]));
  }
  return `${device.transport}|${device.serial}`;
}
export function nameDevices(
  devices: Device[],
  data: DeviceData,
  identities: Record<string, string | null>,
  pendingIds: Set<string> = new Set(),
): NamedDevice[] {
  const bindings = new Map(
    data.bindings.map((b) => [b.bindingKey, b.profileId]),
  );
  const profiles = new Map(data.profiles.map((p) => [p.id, p]));
  return devices.map((device) => {
    const identityKey = identities[device.serial] || null;
    const bindingKeys = [
      transportBindingKey(device),
      ...(identityKey ? [identityKey] : []),
    ];
    const matches = [
      ...new Set(
        bindingKeys
          .map((k) => bindings.get(k))
          .filter((v): v is string => !!v && profiles.has(v)),
      ),
    ];
    const conflict = matches.length > 1;
    const profile =
      !conflict && matches.length === 1 ? profiles.get(matches[0]) : undefined;
    return {
      ...device,
      identityKey,
      bindingKeys,
      conflict,
      profileId: profile?.id || null,
      label: profile?.label || "",
      pending: !!profile && pendingIds.has(profile.id),
    };
  });
}
export function setupStep(
  connected: boolean,
  adbValid: boolean,
  devices: NamedDevice[],
) {
  if (!connected) return 1;
  if (!adbValid) return 2;
  return devices.some((d) => d.state === "device" && d.label && !d.conflict)
    ? 0
    : 3;
}
export function applyDeviceMutation(
  data: DeviceData,
  input: DeviceMutation,
  now = Date.now(),
): DeviceData {
  const existing = data.profiles.find((p) => p.id === input.id);
  if (input.kind === "link" && !existing) throw new Error("请先保存设备备注");
  if (
    !input.reassign &&
    data.bindings.some(
      (b) =>
        input.bindingKeys.includes(b.bindingKey) && b.profileId !== input.id,
    )
  )
    throw new Error("此连接已关联其他设备，请确认后重新关联");
  return {
    profiles:
      input.kind === "save"
        ? [
            {
              id: input.id,
              label: input.label,
              createdAt: existing?.createdAt || now,
              updatedAt: now,
            },
            ...data.profiles.filter((p) => p.id !== input.id),
          ]
        : data.profiles,
    bindings: [
      ...data.bindings.filter((b) => !input.bindingKeys.includes(b.bindingKey)),
      ...[...new Set(input.bindingKeys)].map((bindingKey) => ({
        bindingKey,
        profileId: input.id,
      })),
    ],
  };
}
