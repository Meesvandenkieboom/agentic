/**
 * Background Process Manager
 * Manages background processes spawned outside SDK control
 */

import type { Subprocess } from "bun";

export interface BackgroundProcessInfo {
  bashId: string;
  command: string;
  description?: string;
  startedAt: number;
  sessionId: string;
  subprocess: Subprocess;
  workingDir: string;
  logFile: string;
  pid: number;
}

export class BackgroundProcessManager {
  private processes = new Map<string, BackgroundProcessInfo>();

  /**
   * Spawn a background process outside SDK control
   */
  async spawn(
    command: string,
    workingDir: string,
    bashId: string,
    sessionId: string,
    description?: string
  ): Promise<{ subprocess: Subprocess; pid: number }> {

    // Use nohup to fully detach and redirect output to log file
    // This prevents SIGPIPE when parent closes pipes
    const logFile = `/tmp/agentic-${bashId}.log`;
    const wrappedCommand = `nohup sh -c '${command.replace(/'/g, "'\"'\"'")}' > ${logFile} 2>&1 & echo $!`;

    const subprocess = Bun.spawn(['sh', '-c', wrappedCommand], {
      cwd: workingDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    // Read the PID from output
    const output = await new Response(subprocess.stdout).text();
    const actualPid = parseInt(output.trim());

    const processInfo: BackgroundProcessInfo = {
      bashId,
      command,
      description,
      startedAt: Date.now(),
      sessionId,
      subprocess,
      workingDir,
      logFile, // Store log file path for BashOutput
      pid: actualPid,
    };

    this.processes.set(bashId, processInfo);

    return { subprocess, pid: actualPid };
  }

  /**
   * Get a process by bashId
   */
  get(bashId: string): BackgroundProcessInfo | undefined {
    return this.processes.get(bashId);
  }

  /**
   * Check if a process exists
   */
  has(bashId: string): boolean {
    return this.processes.has(bashId);
  }

  /**
   * Get all processes for a session
   */
  getBySession(sessionId: string): BackgroundProcessInfo[] {
    return Array.from(this.processes.values()).filter(p => p.sessionId === sessionId);
  }

  /**
   * Get all process entries
   */
  entries(): [string, BackgroundProcessInfo][] {
    return Array.from(this.processes.entries());
  }

  /**
   * Get all process values
   */
  values(): BackgroundProcessInfo[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get registry size
   */
  get size(): number {
    return this.processes.size;
  }

  /**
   * Delete a process from registry
   */
  delete(bashId: string): boolean {
    return this.processes.delete(bashId);
  }

  /**
   * Kill a background process
   */
  async kill(bashId: string): Promise<boolean> {
    const processInfo = this.processes.get(bashId);
    if (!processInfo) {
      return false;
    }

    const pid = processInfo.subprocess.pid;

    if (pid) {
      try {
        // Kill the entire process group (setsid makes PID the process group leader)
        // Using negative PID targets the process group
        Bun.spawnSync(['kill', '-TERM', '--', `-${pid}`]);

        // Give processes a moment to terminate gracefully
        await new Promise(resolve => setTimeout(resolve, 100));

        // Force kill any remaining processes in the group
        Bun.spawnSync(['kill', '-KILL', '--', `-${pid}`]);

        // Also kill the subprocess reference
        processInfo.subprocess.kill();
      } catch {
        processInfo.subprocess.kill();
      }
    }

    // Remove from registry
    return this.processes.delete(bashId);
  }

  /**
   * Clean up all processes for a session
   */
  async cleanupSession(sessionId: string): Promise<number> {
    const processesToClean = this.getBySession(sessionId);

    if (processesToClean.length > 0) {
      for (const process of processesToClean) {
        const pid = process.subprocess.pid;

        if (pid) {
          try {
            // Kill the entire process group
            Bun.spawnSync(['kill', '-TERM', '--', `-${pid}`]);
            Bun.spawnSync(['kill', '-KILL', '--', `-${pid}`]);
            process.subprocess.kill();
          } catch {
            process.subprocess.kill();
          }
        }

        // Remove from registry
        this.processes.delete(process.bashId);
      }
    }

    return processesToClean.length;
  }

  /**
   * Find existing process for session with same command
   */
  findExistingProcess(sessionId: string, command: string): BackgroundProcessInfo | undefined {
    return this.values().find(p => p.sessionId === sessionId && p.command === command);
  }

  /**
   * Wait for a background process to complete with output streaming
   */
  async waitForCompletion(
    bashId: string,
    options: {
      onOutput?: (chunk: string) => void;
    } = {}
  ): Promise<{ exitCode: number; output: string }> {
    const processInfo = this.processes.get(bashId);
    if (!processInfo) {
      throw new Error(`Process ${bashId} not found`);
    }

    let lastOutputSize = 0;
    let fullOutput = '';

    // Poll for output and stream to callback
    const checkInterval = setInterval(async () => {
      try {
        const file = Bun.file(processInfo.logFile);
        const exists = await file.exists();

        if (exists) {
          const currentSize = file.size;

          if (currentSize > lastOutputSize) {
            const text = await file.text();
            const newOutput = text.slice(lastOutputSize);

            if (newOutput) {
              lastOutputSize = currentSize;
              fullOutput += newOutput;
              options.onOutput?.(newOutput);
            }
          }
        }

        // Check if process is still alive
        try {
          process.kill(processInfo.pid, 0);
        } catch {
          // Process is dead, stop polling
          clearInterval(checkInterval);
        }
      } catch {
        // Ignore polling errors, process exit will resolve the promise
      }
    }, 1000);

    // Wait for process to exit (no timeout - commands can run as long as needed)
    return new Promise((resolve, reject) => {
      const pollForExit = setInterval(() => {
        try {
          process.kill(processInfo.pid, 0);
          // Still alive, keep waiting
        } catch {
          // Process exited
          clearInterval(pollForExit);
          clearInterval(checkInterval);

          // Read final output after brief delay to ensure all output is flushed
          setTimeout(async () => {
            try {
              const file = Bun.file(processInfo.logFile);
              const exists = await file.exists();
              if (exists) {
                fullOutput = await file.text();
              }

              this.processes.delete(bashId);
              resolve({ exitCode: 0, output: fullOutput });
            } catch (error) {
              reject(error);
            }
          }, 500);
        }
      }, 1000);
    });
  }
}

// Export singleton instance
export const backgroundProcessManager = new BackgroundProcessManager();
