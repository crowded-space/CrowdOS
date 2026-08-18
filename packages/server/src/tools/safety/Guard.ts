import path from "node:path";

export class Guard {
  static getWorkspaceDir(customRoot?: string): string {
    return path.resolve(customRoot || process.env.WORKSPACE_DIR || process.cwd());
  }

  /**
   * Validates if a path stays safely inside the workspace directory
   */
  static validatePath(targetPath: string, workspaceRoot?: string): string {
    const root = Guard.getWorkspaceDir(workspaceRoot);
    const absolutePath = path.resolve(root, targetPath);

    // Prevent directory traversal
    const normalizedRoot = path.normalize(root).toLowerCase();
    const normalizedTarget = path.normalize(absolutePath).toLowerCase();

    if (!normalizedTarget.startsWith(normalizedRoot)) {
      throw new Error(`Access Denied: Path "${targetPath}" breaks out of workspace directory.`);
    }

    // Blacklist sensitive files
    const filename = path.basename(absolutePath).toLowerCase();
    const blacklistedFiles = [".env", "credentials.json", "package-lock.json", ".git"];
    if (blacklistedFiles.some(bf => filename === bf || normalizedTarget.includes(`${path.sep}${bf}${path.sep}`))) {
      throw new Error(`Access Denied: File "${filename}" is in the system blacklist.`);
    }

    return absolutePath;
  }

  /**
   * Validates if a bash command is safe to execute
   */
  static validateCommand(command: string): void {
    const cmdLower = command.toLowerCase();

    // Static dangerous blacklist
    const blacklist = [
      "rm -rf", "shutdown", "format", "drop database", "drop table", "truncate",
      "del /s", "rd /s", "mkfs", "dd ", "chmod -r", "chown -r"
    ];

    if (blacklist.some(term => cmdLower.includes(term))) {
      throw new Error(`Safety Alert: Command contains dangerous blocked instruction.`);
    }
  }

  /**
   * Validates if command is in safe whitelist
   */
  static isCommandWhitelisted(command: string): boolean {
    const whitelist = [
      "npm run test", "node -v", "git status", "npm run build", "ls", "dir", "echo", "npm test"
    ];
    const cmdLower = command.toLowerCase().trim();
    return whitelist.some(term => cmdLower.startsWith(term));
  }
}
