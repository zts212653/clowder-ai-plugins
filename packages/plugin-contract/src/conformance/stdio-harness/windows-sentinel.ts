import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';

export interface WindowsSentinelOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WindowsSentinel {
  readonly root: ChildProcessWithoutNullStreams;
  readonly onTargetError: (listener: (error: Error) => void) => void;
  readonly onTargetExit: (
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
  readonly signalTarget: (signal: NodeJS.Signals) => void;
}

interface SentinelMessage {
  readonly type: 'target-error' | 'target-exit';
  readonly code?: number | string | null;
  readonly message?: string;
  readonly name?: string;
  readonly signal?: NodeJS.Signals | null;
}

const WINDOWS_SENTINEL_SOURCE = String.raw`
const { spawn } = require('node:child_process');

let target;
let targetExitSent = false;
const keepAlive = setInterval(() => {}, 0x3fffffff);

function send(message) {
  if (process.connected) {
    process.send(message, () => {});
  }
}

function sendError(error) {
  send({
    type: 'target-error',
    name: error && error.name ? String(error.name) : 'Error',
    message: error && error.message ? String(error.message) : String(error),
    code: error && error.code !== undefined ? String(error.code) : undefined,
  });
}

function sendExit(code, signal) {
  if (!targetExitSent) {
    targetExitSent = true;
    send({ type: 'target-exit', code, signal });
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'launch' && target === undefined) {
    try {
      target = spawn(message.command, message.args, {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      target.once('error', (error) => {
        sendError(error);
        sendExit(null, null);
      });
      target.once('exit', sendExit);
    } catch (error) {
      sendError(error);
      sendExit(null, null);
    }
    return;
  }
  if (message.type === 'signal' && target !== undefined) {
    try {
      target.kill(message.signal);
    } catch (error) {
      sendError(error);
    }
  }
});

process.on('disconnect', () => {
  clearInterval(keepAlive);
  if (process.platform === 'win32') {
    const cleanup = spawn(
      'taskkill',
      ['/pid', String(process.pid), '/t', '/f'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    cleanup.unref();
  } else if (target !== undefined) {
    target.kill('SIGKILL');
  }
});
`;

export function spawnWindowsSentinel(options: WindowsSentinelOptions): WindowsSentinel {
  const root = spawn(
    process.execPath,
    ['-e', WINDOWS_SENTINEL_SOURCE],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  let targetExit:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  let targetError: Error | undefined;
  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  const errorListeners: Array<(error: Error) => void> = [];

  const publishTargetError = (error: Error): void => {
    targetError ??= error;
    for (const listener of errorListeners.splice(0)) {
      listener(targetError);
    }
  };
  const publishTargetExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (targetExit !== undefined) {
      return;
    }
    targetExit = { code, signal };
    for (const listener of exitListeners.splice(0)) {
      listener(code, signal);
    }
  };

  root.on('message', (message: unknown) => {
    if (!isSentinelMessage(message)) {
      return;
    }
    if (message.type === 'target-error') {
      const error = new Error(message.message ?? 'Windows sentinel target failed');
      error.name = message.name ?? 'Error';
      if (message.code !== undefined) {
        Object.assign(error, { code: message.code });
      }
      publishTargetError(error);
      return;
    }
    publishTargetExit(
      typeof message.code === 'number' ? message.code : null,
      message.signal ?? null,
    );
  });
  root.once('error', publishTargetError);
  root.once('close', (code, signal) => publishTargetExit(code, signal));
  root.once('spawn', () => {
    root.send(
      { type: 'launch', command: options.command, args: [...options.args] },
      (error) => {
        if (error !== null) {
          publishTargetError(error);
          publishTargetExit(null, null);
        }
      },
    );
  });

  return {
    root,
    onTargetError: (listener) => {
      if (targetError === undefined) {
        errorListeners.push(listener);
      } else {
        const error = targetError;
        queueMicrotask(() => listener(error));
      }
    },
    onTargetExit: (listener) => {
      if (targetExit === undefined) {
        exitListeners.push(listener);
      } else {
        const exit = targetExit;
        queueMicrotask(() => listener(exit.code, exit.signal));
      }
    },
    signalTarget: (signal) => {
      if (root.connected) {
        root.send({ type: 'signal', signal }, (error) => {
          if (error !== null) {
            publishTargetError(error);
          }
        });
      }
    },
  };
}

function isSentinelMessage(message: unknown): message is SentinelMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message.type === 'target-error' || message.type === 'target-exit')
  );
}
