import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export const adbPaths = sqliteTable(
  "adb_paths",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull(),
    path: text("path").notNull(),
    pathKey: text("path_key").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [
    uniqueIndex("adb_path_owner_key").on(t.userId, t.machineId, t.pathKey),
  ],
);
export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    endpointKey: text("endpoint_key").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    mode: text("mode").notNull(),
    label: text("label").notNull().default(""),
    deviceId: text("device_id"),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (t) => [uniqueIndex("connection_owner_key").on(t.userId, t.endpointKey)],
);
export const deviceProfiles = sqliteTable("device_profiles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const deviceBindings = sqliteTable(
  "device_bindings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => deviceProfiles.id, { onDelete: "cascade" }),
    bindingKey: text("binding_key").notNull(),
  },
  (t) => [uniqueIndex("device_binding_owner_key").on(t.userId, t.bindingKey)],
);
export const preferences = sqliteTable(
  "preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    machineId: text("machine_id").notNull(),
    mode: text("mode").notNull(),
    lastPath: text("last_path"),
  },
  (t) => [uniqueIndex("preference_owner_machine").on(t.userId, t.machineId)],
);
