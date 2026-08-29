import fs from "node:fs";
import path from "node:path";

export type CommandDecision = "ALLOW" | "ASK" | "DENY";
export type RiskLevel = "low" | "medium" | "high";

export interface CommandVerdict {
  decision: CommandDecision;
  reason: string;
  riskLevel: RiskLevel;
}

const legacyGuardEnabled = (): boolean => process.env.LEGACY_GUARD === "true";

const INTERPRETERS = new Set([
  "python", "python3", "python2", "py", "node", "deno", "bun", "ruby", "perl",
  "php", "bash", "sh", "zsh", "ksh", "dash", "fish",
]);
const VERSION_FLAGS = new Set(["-v", "--version", "-h", "--help", "-?", "/?"]);
const SAFE_BASES = new Set([
  "ls", "dir", "cat", "head", "tail", "echo", "pwd", "whoami", "date",
  "wc", "sort", "uniq", "jq", "tree", "grep", "findstr", "type",
]);
const GIT_READONLY = new Set([
  "status", "log", "diff", "branch", "show", "rev-parse", "describe", "shortlog", "ls-files",
]);
const PKG_MANAGERS = new Set([
  "npm", "pnpm", "yarn", "npx", "pnpx", "bunx", "yarnpkg", "pip", "pip3", "uv", "cargo",
]);
const PKG_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const PKG_LIFECYCLE = new Set([
  "run", "run-script", "exec", "x", "test", "install", "i", "add", "update", "upgrade",
  "remove", "rm", "uninstall", "ci", "clean", "rebuild", "link", "unlink", "create",
  "init", "dlx", "publish", "pack", "audit", "outdated", "start", "stop", "restart",
]);

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: "Recursive delete (rm -rf) is destructive" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, reason: "System shutdown/reboot" },
  { pattern: /\bmkfs\b|\bdd\s+if=/, reason: "Filesystem destructive operation" },
  { pattern: /\bformat\b.*\b\/fs:/i, reason: "Disk format" },
  { pattern: /\bdrop\s+(database|table)\b/, reason: "Database drop" },
  { pattern: /\btruncate\b.*\btable\b/, reason: "Database truncate" },
  { pattern: /\bdel\s+\/s\b|\brd\s+\/s\b/, reason: "Recursive Windows delete" },
  { pattern: /\bchmod\s+-r\b|\bchown\s+-r\b/, reason: "Recursive permission change" },
  { pattern: /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, reason: "Pipe into shell is remote code execution" },
  { pattern: /\|\s*(powershell|pwsh|pwsh32)\b/i, reason: "Pipe into PowerShell is remote code execution" },
  { pattern: /\|\s*(iex|invoke-expression)\b/i, reason: "Pipe into Invoke-Expression is remote code execution" },
  { pattern: /\b(iex|invoke-expression)\b/i, reason: "Invoke-Expression executes arbitrary code" },
  { pattern: /:()\{\s*:\|:&\s*\};:/, reason: "Fork bomb" },
  { pattern: /\bpython3?\s+(-c|--command)\b/, reason: "Inline Python execution requires approval" },
  { pattern: /\bperl\s+(-e|--execute)\b/, reason: "Inline Perl execution requires approval" },
  { pattern: /\bruby\s+(-e|--eval)\b/, reason: "Inline Ruby execution requires approval" },
  { pattern: /\bphp\s+(-r|--run)\b/, reason: "Inline PHP execution requires approval" },
  { pattern: /\b(ba|z|da|k)?sh\s+-c\b/, reason: "Shell -c inline execution requires approval" },
  { pattern: /\bnode\s+(-e|--eval|-p|--print)\b/, reason: "Inline Node execution requires approval" },
  { pattern: /\bpowershell\b.*(-enc|-e\b|-command\b)/i, reason: "PowerShell inline/encoded command" },
  { pattern: /\$\(.+\)|\`.+\`/, reason: "Command substitution" },
  { pattern: />\s*\/etc\/|>\s*\/usr\//, reason: "Redirection to system directory" },
  { pattern: /\benv\s*=\s*|export\s+\w+=/, reason: "Environment manipulation" },
  { pattern: /^\s*\/\w+.*/, reason: "Absolute path execution requires approval" },
  { pattern: /\bnc\s+-l\b|\bnetcat\b/, reason: "Network listener" },
  { pattern: /\bnc(\.exe)?\b.*\s(-e)\b/i, reason: "netcat -e spawns shells" },
  { pattern: /\bchmod\s+777\b/, reason: "Overly permissive chmod" },
  { pattern: /\b(authorized_keys|known_hosts)\b/, reason: "SSH credential file access" },
  { pattern: /\bhistory\s+-c\b|\bbash_history\b|\bshred\b/, reason: "Audit/history tampering" },
  { pattern: /\breg\s+add\b|\bschtasks\s+\/create\b|\bat\s+\\\\/i, reason: "Persistence mechanism (registry/scheduled task)" },
];

const ASK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: "Elevated privilege (sudo)" },
  { pattern: /\bnpm\s+install\b|\byarn\s+add\b|\bpip3?\s+install\b/, reason: "Package installation" },
  { pattern: /\bgit\s+push\b|\bgit\s+pull\b/, reason: "Git remote operation" },
  { pattern: /\bdocker\b|\bpodman\b/, reason: "Container operation" },
  { pattern: /\bcurl\b|\bwget\b|\binvoke-webrequest\b/i, reason: "Network fetch" },
  { pattern: /\bssh\b|\bscp\b/, reason: "Remote access" },
  { pattern: /\bmake\b|\bcmake\b/, reason: "Build system" },
  { pattern: /\bkill\b|\bpkill\b|\btaskkill\b/, reason: "Process termination" },
  { pattern: /\benv\b|\bprintenv\b/, reason: "Environment inspection" },
  { pattern: />\s*\S+/, reason: "File redirection" },
  { pattern: /\|\s*\w+/, reason: "Shell pipeline" },
  { pattern: /\bchmod\b|\bchown\b|\bicacls\b/, reason: "Permission change" },
  { pattern: /\bcrontab\b/, reason: "Scheduled job modification" },
];

export class Guard {
  private static existsCache = new Map<string, { exists: boolean; at: number }>();
  private static cachedExistsSync(p: string): boolean {
    const now = Date.now();
    const cached = Guard.existsCache.get(p);
    if (cached && now - cached.at < 5000) return cached.exists;
    const exists = fs.existsSync(p);
    Guard.existsCache.set(p, { exists, at: now });
    if (Guard.existsCache.size > 200) {
      const oldest = Array.from(Guard.existsCache.entries()).sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) Guard.existsCache.delete(oldest);
    }
    return exists;
  }
  static getWorkspaceDir(customRoot?: string): string {
    if (customRoot) {
      if (Guard.cachedExistsSync(customRoot)) {
        return path.resolve(customRoot);
      }
      const sandboxPath = path.join(process.cwd(), "sandbox", customRoot);
      if (Guard.cachedExistsSync(sandboxPath)) {
        return path.resolve(sandboxPath);
      }
    }
    if (process.env.WORKSPACE_DIR && Guard.cachedExistsSync(process.env.WORKSPACE_DIR)) {
      return path.resolve(process.env.WORKSPACE_DIR);
    }
    return process.cwd();
  }

  static isInsideRoot(candidate: string, root: string): boolean {
    const norm = (p: string): string => {
      let n = p.replace(/\//g, path.sep);
      n = path.normalize(n);
      while (n.length > 1 && n.endsWith(path.sep)) n = n.slice(0, -1);
      if (process.platform === "win32") n = n.toLowerCase();
      return n;
    };
    const c = norm(candidate);
    const r = norm(root);
    if (!r) return false;
    if (c === r) return true;
    return c.startsWith(r + path.sep);
  }

  private static resolveRealDeep(target: string): string {
    try {
      return fs.realpathSync(target);
    } catch (err: any) {
      if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    }
    const segments: string[] = [];
    let current = path.resolve(target);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(current, ...segments);
      segments.unshift(path.basename(current));
      try {
        const base = fs.realpathSync(parent);
        return path.resolve(base, ...segments);
      } catch (err: any) {
        if (err && err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
        current = parent;
      }
    }
  }

  static validatePath(targetPath: string, workspaceRoot?: string): string {
    const root = Guard.getWorkspaceDir(workspaceRoot);

    if (legacyGuardEnabled()) {
      return Guard.legacyValidatePath(targetPath, root);
    }

    let rootReal: string;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      rootReal = path.resolve(root);
    }

    const absolutePath = path.resolve(rootReal, targetPath);

    const candidateReal = Guard.resolveRealDeep(absolutePath);

    if (!Guard.isInsideRoot(candidateReal, rootReal)) {
      throw new Error(`Access Denied: Path "${targetPath}" breaks out of workspace directory.`);
    }

    const filename = path.basename(candidateReal).toLowerCase();
    const blacklistedFiles = ["credentials.json", "package-lock.json", ".git"];
    const isEnvFile = filename === ".env" || filename.startsWith(".env.");
    const lowerCandidate =
      process.platform === "win32" ? candidateReal.toLowerCase() : candidateReal;
    if (
      isEnvFile ||
      blacklistedFiles.some((bf) => filename === bf || lowerCandidate.includes(`${path.sep}${bf}${path.sep}`))
    ) {
      throw new Error(`Access Denied: File "${filename}" is in the system blacklist.`);
    }

    return candidateReal;
  }

  private static legacyValidatePath(targetPath: string, root: string): string {
    const absolutePath = path.resolve(root, targetPath);

    const normalizedRoot = path.normalize(root).toLowerCase();
    const normalizedTarget = path.normalize(absolutePath).toLowerCase();

    if (!normalizedTarget.startsWith(normalizedRoot)) {
      throw new Error(`Access Denied: Path "${targetPath}" breaks out of workspace directory.`);
    }

    const filename = path.basename(absolutePath).toLowerCase();
    const blacklistedFiles = ["credentials.json", "package-lock.json", ".git"];
    const isEnvFile = filename === ".env" || filename.startsWith(".env.");
    if (
      isEnvFile ||
      blacklistedFiles.some((bf) => filename === bf || normalizedTarget.includes(`${path.sep}${bf}${path.sep}`))
    ) {
      throw new Error(`Access Denied: File "${filename}" is in the system blacklist.`);
    }

    return absolutePath;
  }

  static tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (const ch of command) {
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
  }

  private static splitSegments(command: string): string[] {
    return command
      .split(/&&|\|\||;|\||\n|\r\n/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private static baseName(token: string): string {
    const replaced = token.replace(/\\/g, "/");
    const base = replaced.slice(replaced.lastIndexOf("/") + 1).toLowerCase();
    return base.replace(/\.(exe|cmd|bat)$/, "");
  }

  private static isVersionOnly(args: string[]): boolean {
    return args.length > 0 && args.every((a) => VERSION_FLAGS.has(a.toLowerCase()));
  }

  private static classifySegment(tokens: string[]): string | null {
    if (tokens.length === 0) return null;
    const base = Guard.baseName(tokens[0]);
    const args = tokens.slice(1);

    if (INTERPRETERS.has(base)) {
      if (Guard.isVersionOnly(args)) return null;
      return `Interpreter execution (${base}) requires approval`;
    }

    if (base === "find") {
      const dangerFlags = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint"];
      if (args.some((a) => dangerFlags.includes(a.toLowerCase()))) {
        return "find with destructive/exec flags (-exec/-delete) requires approval";
      }
      return "find requires approval (SEC-3)";
    }

    if (PKG_MANAGERS.has(base)) {
      if (Guard.isVersionOnly(args)) return null;
      if (PKG_RUNNERS.has(base) && args.length > 0) {
        return `Package runner executes arbitrary packages (${base} ${args[0]}) requires approval`;
      }
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub) return `Package manager execution (${base}) requires approval`;
      if (PKG_LIFECYCLE.has(sub.toLowerCase())) {
        return `Package manager lifecycle (${base} ${sub}) requires approval`;
      }
      return null;
    }

    return null;
  }

  private static isAllowableSegment(tokens: string[]): boolean {
    if (tokens.length === 0) return false;
    const base = Guard.baseName(tokens[0]);
    const args = tokens.slice(1);

    if (SAFE_BASES.has(base)) return true;

    if (base === "git") {
      const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
      return !!sub && GIT_READONLY.has(sub);
    }

    if (INTERPRETERS.has(base) || PKG_MANAGERS.has(base)) {
      return Guard.isVersionOnly(args);
    }

    return false;
  }

  static evaluateCommand(command: string): CommandVerdict {
    if (legacyGuardEnabled()) {
      return Guard.legacyEvaluateCommand(command);
    }

    const cmdLower = command.toLowerCase().trim();
    const cmd = command.trim();

    for (const { pattern, reason } of DENY_PATTERNS) {
      if (pattern.test(cmdLower) || pattern.test(cmd)) {
        return { decision: "DENY", reason, riskLevel: "high" };
      }
    }

    for (const segment of Guard.splitSegments(cmd)) {
      const reason = Guard.classifySegment(Guard.tokenizeCommand(segment));
      if (reason) {
        return { decision: "ASK", reason, riskLevel: "medium" };
      }
    }

    for (const { pattern, reason } of ASK_PATTERNS) {
      if (pattern.test(cmdLower)) {
        return { decision: "ASK", reason, riskLevel: "medium" };
      }
    }

    const segments = Guard.splitSegments(cmd).map((s) => Guard.tokenizeCommand(s));
    if (segments.length > 0 && segments.every((t) => Guard.isAllowableSegment(t))) {
      return { decision: "ALLOW", reason: "Safe read/inspect command", riskLevel: "low" };
    }

    return { decision: "ASK", reason: "Unrecognized command requires approval", riskLevel: "medium" };
  }

  private static legacyEvaluateCommand(command: string): CommandVerdict {
    const cmdLower = command.toLowerCase().trim();
    const cmd = command.trim();

    for (const { pattern, reason } of DENY_PATTERNS) {
      if (pattern.test(cmdLower) || pattern.test(cmd)) {
        return { decision: "DENY", reason, riskLevel: "high" };
      }
    }

    for (const { pattern, reason } of ASK_PATTERNS.concat([
      { pattern: /\bnode\b(\s|$)|\bpython3?\b(\s|$)|\bruby\b(\s|$)|\bphp\b(\s|$)|\bgo\s+run\b/, reason: "Interpreter execution" },
    ])) {
      if (pattern.test(cmdLower)) {
        return { decision: "ASK", reason, riskLevel: "medium" };
      }
    }

    const allowPrefixes = [
      "ls", "dir", "cat ", "head ", "tail ", "echo ", "pwd", "whoami", "date", "node -v", "npm -v",
      "git status", "git diff", "git log", "git branch", "npm run build", "npm test", "npm run test",
      "grep ", "find ", "wc ", "sort ", "uniq ", "jq ", "tree ",
    ];
    if (allowPrefixes.some((p) => cmdLower.startsWith(p))) {
      return { decision: "ALLOW", reason: "Safe read/inspect command", riskLevel: "low" };
    }

    return { decision: "ASK", reason: "Unrecognized command requires approval", riskLevel: "medium" };
  }

  private static isApprovalsEnabled(): boolean {
    return process.env.APPROVALS_ENABLED === "true";
  }

  static validateCommand(command: string): void {
    const result = Guard.evaluateCommand(command);
    if (result.decision === "DENY") {
      throw new Error(`Safety DENY: ${result.reason}. Command blocked: "${command.slice(0, 120)}"`);
    }
    if (result.decision === "ASK") {
      if (!Guard.isApprovalsEnabled()) {
        // Rollback: APPROVALS_ENABLED=false → ASK behaves as DENY (today)
        throw new Error(
          `Safety ASK: ${result.reason}. Command requires approval (not yet granted): "${command.slice(0, 120)}"`
        );
      }
      // APR-1: approvals enabled → ASK is tri-state, caller (ToolExecutor) pauses
      // WAITING_FOR_APPROVAL and awaits grant/deny via Approvals domain.
      // validateCommand deliberately does NOT throw here; evaluateCommand already
      // classified risk. ToolExecutor will create approval_requests, emit
      // approval.requested, and block until decision.
    }
  }

  static isCommandWhitelisted(command: string): boolean {
    return Guard.evaluateCommand(command).decision === "ALLOW";
  }
}
