import type { SensePerspective } from "./sense.js";

export interface Council {
  taskId: string;
  perspectives: SensePerspective[];
  producedAt: Date;
  inputSummary: {
    intentSlice: string;
    tasteSlice: string;
    taskDescription: string;
  };
}
