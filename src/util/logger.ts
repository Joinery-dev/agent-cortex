import {
  emitWarn as busEmitWarn,
  emitError as busEmitError,
} from "../events.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

let minLevel: LogLevel = "info";
let bridgeEnabled = true;

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Disable the logger→event bus bridge. Used in tests or bootstrap
 * to prevent circular initialization issues.
 */
export function disableBusBridge(): void {
  bridgeEnabled = false;
}

export function enableBusBridge(): void {
  bridgeEnabled = true;
}

function writeToConsole(entry: LogEntry): void {
  if (levelOrder[entry.level] < levelOrder[minLevel]) return;

  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}]`;
  const line = `${prefix} ${entry.message}`;

  if (entry.data !== undefined) {
    console.log(line, JSON.stringify(entry.data, null, 2));
  } else {
    console.log(line);
  }
}

/** Bridge warn/error log entries to the event bus so they're persisted and visible on the dashboard. */
function bridgeToEventBus(entry: LogEntry): void {
  if (!bridgeEnabled) return;

  const diagnostic = {
    component: entry.component,
    snapshot: entry.data != null ? { logData: entry.data } : undefined,
  };

  if (entry.level === "warn") {
    busEmitWarn(
      `log:warn:${entry.component}`,
      { message: entry.message },
      diagnostic,
    );
  } else if (entry.level === "error") {
    busEmitError(
      `log:error:${entry.component}`,
      { message: entry.message },
      diagnostic,
    );
  }
}

export function createLogger(component: string) {
  const log = (level: LogLevel, message: string, data?: unknown) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      data,
    };
    writeToConsole(entry);
    bridgeToEventBus(entry);
  };

  return {
    debug: (msg: string, data?: unknown) => log("debug", msg, data),
    info: (msg: string, data?: unknown) => log("info", msg, data),
    warn: (msg: string, data?: unknown) => log("warn", msg, data),
    error: (msg: string, data?: unknown) => log("error", msg, data),
  };
}
