export interface Task {
  id: string;
  description: string;
  context: Record<string, unknown>;
  parentTaskId?: string;
  status:
    | "pending"
    | "consulting"
    | "re-consulting"
    | "exploring"
    | "producing"
    | "evaluating"
    | "resolving"
    | "complete"
    | "failed";
  createdAt: Date;
  history: TaskEvent[];
}

export interface TaskEvent {
  timestamp: Date;
  type:
    | "status_change"
    | "consultation_result"
    | "work_produced"
    | "evaluation"
    | "tension_detected"
    | "resolution"
    | "cycle_back"
    | "cerebellum_prediction"
    | "explore_result"
    | "efference_copy";
  data: unknown;
}

export function createTask(
  id: string,
  description: string,
  context: Record<string, unknown> = {}
): Task {
  return {
    id,
    description,
    context,
    status: "pending",
    createdAt: new Date(),
    history: [],
  };
}

export function addEvent(task: Task, type: TaskEvent["type"], data: unknown): void {
  task.history.push({ timestamp: new Date(), type, data });
}
