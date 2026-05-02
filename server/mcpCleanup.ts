/**
 * MCP Process Cleanup Utility
 *
 * Handles cleanup of orphaned MCP server processes that may linger
 * between chat sessions or after crashes. This prevents port conflicts
 * when a new chat tries to spawn the same MCP server.
 *
 * Key scenarios handled:
 * 1. Server startup - kill any orphaned MCP processes from previous runs
 * 2. Session switch - kill MCP processes from the previous active session
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Known MCP process patterns that may use exclusive ports
const MCP_PROCESS_PATTERNS = [
  'robloxstudio-mcp',      // Roblox Studio MCP (port 3002)
  'mcp-remote',            // OAuth MCP proxy
  'mcp-server',            // Generic MCP servers
];

// Known ports used by MCP servers
const MCP_PORTS = [
  3002,  // Roblox Studio MCP
];

interface ProcessInfo {
  pid: number;
  name: string;
  port?: number;
}

/**
 * Find processes matching MCP patterns
 */
async function findMcpProcesses(): Promise<ProcessInfo[]> {
  const processes: ProcessInfo[] = [];

  try {
    // Cross-platform process search
    if (process.platform === 'win32') {
      // Windows: use WMIC to find processes
      for (const pattern of MCP_PROCESS_PATTERNS) {
        try {
          const { stdout } = await execAsync(`wmic process where "commandline like '%${pattern}%'" get processid,name /format:csv 2>nul`);
          const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.includes('Node,Name,ProcessId'));
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 3) {
              const pid = parseInt(parts[2], 10);
              if (!isNaN(pid)) {
                processes.push({ pid, name: pattern });
              }
            }
          }
        } catch {
          // Process not found, continue
        }
      }
    } else {
      // Unix/Mac/WSL: use pgrep and ps
      for (const pattern of MCP_PROCESS_PATTERNS) {
        try {
          const { stdout } = await execAsync(`pgrep -f "${pattern}" 2>/dev/null || true`);
          const pids = stdout.trim().split('\n').filter(p => p.trim());
          for (const pidStr of pids) {
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
              processes.push({ pid, name: pattern });
            }
          }
        } catch {
          // pgrep not found or no matches
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  Failed to search for MCP processes:', error);
  }

  return processes;
}

/**
 * Find processes listening on known MCP ports
 */
async function findProcessesOnMcpPorts(): Promise<ProcessInfo[]> {
  const processes: ProcessInfo[] = [];

  try {
    for (const port of MCP_PORTS) {
      if (process.platform === 'win32') {
        // Windows: use netstat
        try {
          const { stdout } = await execAsync(`netstat -ano | findstr ":${port}" 2>nul`);
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[1].includes(`:${port}`)) {
              const pid = parseInt(parts[4], 10);
              if (!isNaN(pid) && pid !== 0) {
                processes.push({ pid, name: `port:${port}`, port });
              }
            }
          }
        } catch {
          // No process on this port
        }
      } else {
        // Unix/Mac/WSL: use lsof
        try {
          const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null || true`);
          const pids = stdout.trim().split('\n').filter(p => p.trim());
          for (const pidStr of pids) {
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
              processes.push({ pid, name: `port:${port}`, port });
            }
          }
        } catch {
          // lsof not found or no process on port
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  Failed to check MCP ports:', error);
  }

  return processes;
}

interface KillResult {
  success: boolean;
  reason?: 'killed' | 'already_dead' | 'permission_denied' | 'error';
}

/**
 * Kill a process by PID
 * Returns success=true if process is terminated OR was already dead
 */
async function killProcess(pid: number): Promise<KillResult> {
  try {
    process.kill(pid, 'SIGTERM');

    // Give it 500ms to exit gracefully
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if still alive, force kill if needed
    try {
      process.kill(pid, 0); // Check if alive (throws if dead)
      process.kill(pid, 'SIGKILL'); // Force kill

      // Wait and verify it's dead
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        process.kill(pid, 0);
        // Still alive after SIGKILL - rare but possible
        return { success: false, reason: 'error' };
      } catch {
        // Good - it's dead
        return { success: true, reason: 'killed' };
      }
    } catch {
      // Process already dead from SIGTERM
      return { success: true, reason: 'killed' };
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    // ESRCH = No such process (already dead) - this is SUCCESS, not failure
    if (error.code === 'ESRCH') {
      return { success: true, reason: 'already_dead' };
    }

    // EPERM = Permission denied
    if (error.code === 'EPERM') {
      return { success: false, reason: 'permission_denied' };
    }

    return { success: false, reason: 'error' };
  }
}

/**
 * Kill all orphaned MCP processes
 * Call this on server startup and optionally on session switch
 *
 * @returns Number of processes killed
 */
export async function cleanupOrphanedMcpProcesses(): Promise<number> {
  console.log('🧹 Checking for orphaned MCP processes...');

  // Find by process name patterns
  const processesByName = await findMcpProcesses();

  // Find by port usage
  const processesByPort = await findProcessesOnMcpPorts();

  // Deduplicate by PID
  const allProcesses = new Map<number, ProcessInfo>();
  for (const proc of [...processesByName, ...processesByPort]) {
    if (!allProcesses.has(proc.pid)) {
      allProcesses.set(proc.pid, proc);
    }
  }

  if (allProcesses.size === 0) {
    console.log('✅ No orphaned MCP processes found');
    return 0;
  }

  console.log(`🔍 Found ${allProcesses.size} MCP process(es) to clean up:`);
  for (const proc of allProcesses.values()) {
    console.log(`   - PID ${proc.pid}: ${proc.name}`);
  }

  let killed = 0;
  for (const proc of allProcesses.values()) {
    const result = await killProcess(proc.pid);
    if (result.success) {
      if (result.reason === 'already_dead') {
        console.log(`   ✓ PID ${proc.pid} (already terminated)`);
      } else {
        console.log(`   ✓ Killed PID ${proc.pid}`);
      }
      killed++;
    } else {
      const reasonText = result.reason === 'permission_denied' ? 'permission denied' : 'unknown error';
      console.warn(`   ✗ Failed to kill PID ${proc.pid}: ${reasonText}`);
    }
  }

  console.log(`🧹 Cleaned up ${killed}/${allProcesses.size} MCP processes`);
  return killed;
}

/**
 * Kill MCP processes on a specific port
 * Useful before spawning an MCP that uses that port
 *
 * @param port - The port to free up
 * @returns True if the port was freed
 */
export async function freePort(port: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`netstat -ano | findstr ":${port}" 2>nul`);
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].includes(`:${port}`)) {
          const pid = parseInt(parts[4], 10);
          if (!isNaN(pid) && pid !== 0) {
            await killProcess(pid);
            console.log(`🔓 Freed port ${port} (killed PID ${pid})`);
            return true;
          }
        }
      }
    } else {
      const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null || true`);
      const pidStr = stdout.trim().split('\n')[0];
      if (pidStr) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          await killProcess(pid);
          console.log(`🔓 Freed port ${port} (killed PID ${pid})`);
          return true;
        }
      }
    }

    return true; // Port was already free
  } catch {
    return false;
  }
}

/**
 * Find the PID currently listening on a port, or null if free.
 * Read-only — does not kill anything. Use this when you want to know
 * whether a port-bound MCP slot is already taken before deciding to
 * exclude it from a new SDK subprocess's MCP config.
 */
export async function getPortOwnerPid(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`netstat -ano | findstr ":${port}" 2>nul`);
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Only LISTENING sockets count as "owning" the port
        if (parts.length >= 5 && parts[1].includes(`:${port}`) && /LISTENING/i.test(parts[3] ?? '')) {
          const pid = parseInt(parts[4], 10);
          if (!isNaN(pid) && pid !== 0) return pid;
        }
      }
      return null;
    }

    // Unix/Mac/WSL: lsof -ti:PORT -sTCP:LISTEN restricts to the LISTEN socket
    // (not transient client connections to that port).
    const { stdout } = await execAsync(`lsof -ti:${port} -sTCP:LISTEN 2>/dev/null || true`);
    const pidStr = stdout.trim().split('\n')[0];
    if (!pidStr) return null;
    const pid = parseInt(pidStr, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Add a port to the list of known MCP ports to clean up
 * Call this when loading custom MCP server configs
 */
export function registerMcpPort(port: number): void {
  if (!MCP_PORTS.includes(port)) {
    MCP_PORTS.push(port);
  }
}

/**
 * Add a process pattern to look for during cleanup
 */
export function registerMcpPattern(pattern: string): void {
  if (!MCP_PROCESS_PATTERNS.includes(pattern)) {
    MCP_PROCESS_PATTERNS.push(pattern);
  }
}
