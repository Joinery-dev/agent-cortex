export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

let minLevel: LogLevel = "info";

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(entry: LogEntry): void {
  if (levelOrder[entry.level] < levelOrder[minLevel]) return;

  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}]`;
  const line = `${prefix} ${entry.message}`;

  if (entry.data !== undefined) {
    console.log(line, JSON.stringify(entry.data, null, 2));
  } else {
    console.log(line);
  }
}

export function createLogger(component: string) {
  const log = (level: LogLevel, message: string, data?: unknown) => {
    emit({
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      data,
    });
  };

  return {
    debug: (msg: string, data?: unknown) => log("debug", msg, data),
    info: (msg: string, data?: unknown) => log("info", msg, data),
    warn: (msg: string, data?: unknown) => log("warn", msg, data),
    error: (msg: string, data?: unknown) => log("error", msg, data),
  };
}
