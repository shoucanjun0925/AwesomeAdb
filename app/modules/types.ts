import type { Dispatch, SetStateAction } from "react";
import type { useWorkspace } from "../use-workspace";

/** All modules share one authenticated helper connection, device and task panel. */
export interface ModuleContext {
  services: ReturnType<typeof useWorkspace>;
  serial: string;
  currentPath: string;
  setCurrentPath: Dispatch<SetStateAction<string>>;
  setTaskOpen: Dispatch<SetStateAction<boolean>>;
  onConfigure: () => void;
  onConnect: () => void;
}
