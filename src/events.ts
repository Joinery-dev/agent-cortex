import { EventEmitter } from "node:events";

export interface CortexEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

class CortexEventBus extends EventEmitter {
  emitCortex(payload: CortexEvent): boolean {
    return super.emit("cortex", payload);
  }

  onCortex(listener: (payload: CortexEvent) => void): this {
    return super.on("cortex", listener);
  }
}

export const bus = new CortexEventBus();

export function emit(type: string, data: Record<string, unknown> = {}): void {
  bus.emitCortex({
    type,
    timestamp: new Date().toISOString(),
    data,
  });
}
