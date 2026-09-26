import { spawn, type ChildProcess } from "node:child_process";

const ALLOWED_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP",
  "HOME", "APPDATA", "LANG", "LC_ALL", "NODE_ENV",
]);

export interface HardenedExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface HardenedExecOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBufferChars?: number;
  onSpawn?: (child: ChildProcess) => void;
}

export function buildSandboxEnv(extra?: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED_ENV_KEYS.has(k) && v) filtered[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (/api[_-]?key|secret|token|password/i.test(k)) continue;
    if (v !== undefined) filtered[k] = v;
  }
  return filtered;
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        // spawn failures surface on 'error'; an unhandled one crashes the server
      }).on("error", () => {});
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export async function execHardened(options: HardenedExecOptions): Promise<HardenedExecResult> {
  const { command, cwd, signal, onSpawn } = options;
  const timeoutMs = options.timeoutMs ?? 300000;
  const maxBufferChars = options.maxBufferChars ?? 1024 * 1024;

  return await new Promise<HardenedExecResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        // POSIX: own process group so -pgid kill reaches grandchildren.
        // Windows: detached would give the child its own console and sever
        // stdio capture; taskkill /T handles the tree without detachment.
        detached: process.platform !== "win32",
        windowsHide: true,
        env: buildSandboxEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({ success: false, output: "", error: err?.message || String(err) });
      return;
    }

    onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let truncatedByCap = false;
    // Cap DURING accumulation: clipping only at finish lets `yes|cat /dev/zero`
    // OOM the server before the clip runs. Kill the tree on exceed.
    const onData = (chunk: Buffer, sink: "out" | "err") => {
      if (truncatedByCap) return;
      const text = chunk.toString("utf8");
      if (sink === "out") {
        stdout += text;
        if (stdout.length > maxBufferChars) {
          truncatedByCap = true;
          stdout = stdout.slice(0, maxBufferChars);
          killTree();
          finish({ success: false, output: stdout, error: `Output exceeded ${maxBufferChars} chars; process tree terminated.` });
        }
      } else {
        stderr += text;
        if (stderr.length > maxBufferChars) stderr = stderr.slice(0, maxBufferChars);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => onData(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => onData(chunk, "err"));

    let timer: NodeJS.Timeout | undefined;
    const finish = (result: HardenedExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const clipped =
        result.output.length > maxBufferChars
          ? result.output.slice(0, maxBufferChars) + "\n[output truncated]"
          : result.output;
      resolve({ ...result, output: clipped });
    };

    const killTree = () => {
      if (child.pid) killProcessTree(child.pid);
    };

    timer = setTimeout(() => {
      killTree();
      finish({
        success: false,
        output: stdout,
        error: `Command timed out after ${timeoutMs}ms and its process tree was terminated.`,
      });
    }, timeoutMs);

    const onAbort = () => {
      killTree();
      finish({
        success: false,
        output: stdout,
        error: "Command aborted before completion and its process tree was terminated.",
      });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      finish({ success: false, output: stdout, error: err.message });
    });

    child.on("close", (code, termSignal) => {
      if (termSignal === "SIGTERM" || termSignal === "SIGKILL") {
        finish({ success: false, output: stdout, error: `Command terminated (${termSignal}).` });
        return;
      }
      if (code === 0) {
        finish({ success: true, output: stdout || "(Command completed with no output)" });
      } else {
        finish({
          success: false,
          output: stdout,
          error: stderr || `Command exited with code ${code}`,
        });
      }
    });
  });
}
