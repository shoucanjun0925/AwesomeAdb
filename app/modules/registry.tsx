import type { ComponentType } from "react";
import { FolderOpen, type LucideIcon } from "lucide-react";
import { modules, type ModuleManifest } from "../../shared/contracts";
import type { ModuleContext } from "./types";
import FileManager from "./files/file-manager";

const views: Record<
  string,
  { Component: ComponentType<ModuleContext>; Icon: LucideIcon }
> = {
  files: { Component: FileManager, Icon: FolderOpen },
};

export const appModules: (ModuleManifest & {
  Component: ComponentType<ModuleContext>;
  Icon: LucideIcon;
})[] = modules.map((manifest) => {
  const view = views[manifest.id];
  if (!view) throw new Error(`模块 ${manifest.id} 尚未注册界面`);
  return { ...manifest, ...view };
});
