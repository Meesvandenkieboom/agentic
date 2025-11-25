/**
 * Import API Routes
 * Handles importing files/folders into chat working directories
 */

import * as fs from 'fs';
import * as path from 'path';
import { sessionDb } from '../database';

/**
 * Generate a random simple folder name (lowercase letters and numbers, 8 chars)
 */
function generateRandomFolderName(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Recursively copy directory contents
 */
function copyDirectory(source: string, destination: string): void {
  // Create destination directory
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  // Read source directory
  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      // Recursively copy subdirectory
      copyDirectory(sourcePath, destPath);
    } else {
      // Copy file
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

/**
 * Handle import-related API routes
 * Returns Response if route was handled, undefined otherwise
 */
export async function handleImportRoutes(
  req: Request,
  url: URL
): Promise<Response | undefined> {

  // POST /api/sessions/:id/import - Import files/folders into session
  if (url.pathname.match(/^\/api\/sessions\/[^/]+\/import$/) && req.method === 'POST') {
    const sessionId = url.pathname.split('/')[3];
    const body = await req.json() as { paths: string[] };

    console.log('📦 Import request:', {
      sessionId,
      paths: body.paths
    });

    try {
      // Get session to retrieve working directory
      const session = sessionDb.getSession(sessionId);
      if (!session) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Session not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate paths exist
      const invalidPaths = body.paths.filter(p => !fs.existsSync(p));
      if (invalidPaths.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: `Path(s) not found: ${invalidPaths.join(', ')}`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Generate random folder name for import
      const importFolderName = generateRandomFolderName();
      const importFolderPath = path.join(session.working_directory, importFolderName);

      console.log(`📂 Creating import folder: ${importFolderPath}`);

      // Create import folder
      fs.mkdirSync(importFolderPath, { recursive: true });

      // Copy each path into import folder
      let copiedCount = 0;
      const copiedItems: string[] = [];

      for (const sourcePath of body.paths) {
        const stats = fs.statSync(sourcePath);
        const itemName = path.basename(sourcePath);
        const destPath = path.join(importFolderPath, itemName);

        if (stats.isDirectory()) {
          console.log(`📁 Copying directory: ${itemName}`);
          copyDirectory(sourcePath, destPath);
        } else {
          console.log(`📄 Copying file: ${itemName}`);
          fs.copyFileSync(sourcePath, destPath);
        }

        copiedItems.push(itemName);
        copiedCount++;
      }

      console.log(`✅ Import complete: ${copiedCount} items copied to ${importFolderName}`);

      return new Response(JSON.stringify({
        success: true,
        importFolder: importFolderName,
        importPath: importFolderPath,
        copiedCount,
        copiedItems
      }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('❌ Import error:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to import: ${errorMsg}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/pick-import-items - Open native dialog to pick files/folders
  if (url.pathname === '/api/pick-import-items' && req.method === 'POST') {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Detect if running in WSL
      const isWSL = (() => {
        try {
          if (process.platform === 'linux' && fs.existsSync('/proc/version')) {
            const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
            return version.includes('microsoft') || version.includes('wsl');
          }
        } catch {
          // Ignore
        }
        return false;
      })();

      let command: string;
      let isWindowsDialog = false;

      // Cross-platform file/folder picker
      if (process.platform === 'darwin') {
        // macOS - AppleScript to allow multiple file/folder selection
        command = `osascript -e 'tell application "System Events" to activate' -e 'tell application "System Events" to set thePaths to choose file with prompt "Select files or folders to import" with multiple selections allowed' -e 'set text item delimiters to linefeed' -e 'thePaths as text'`;
      } else if (isWSL || process.platform === 'win32') {
        // WSL or Windows - use PowerShell with folder browser dialog
        isWindowsDialog = true;
        const powershellCmd = isWSL ? 'powershell.exe' : 'powershell';

        // Use FolderBrowserDialog which allows selecting folders, and we'll add file selection as an option
        command = `${powershellCmd} -NoProfile -Command "$paths = @(); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select a folder to import (or Cancel and use file picker)'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq 'OK') { $paths += $dialog.SelectedPath } else { $fileDialog = New-Object System.Windows.Forms.OpenFileDialog; $fileDialog.Multiselect = $true; $fileDialog.Title = 'Select files to import'; if ($fileDialog.ShowDialog() -eq 'OK') { $paths += $fileDialog.FileNames } } $paths | ForEach-Object { Write-Output $_ }"`;
      } else {
        // Linux (non-WSL) - zenity for file selection
        command = `zenity --file-selection --multiple --separator="\n" --title="Select files or folders to import"`;
      }

      console.log('🔍 Opening import picker dialog...');

      const { stdout, stderr } = await execAsync(command);

      if (stderr && !stdout) {
        throw new Error(stderr);
      }

      // Parse selected paths
      let selectedPaths: string[] = [];
      if (stdout.trim()) {
        if (process.platform === 'darwin') {
          // macOS returns paths with colons, convert to slash paths
          selectedPaths = stdout.trim().split('\n').map(p => {
            // Convert "Macintosh HD:Users:..." to "/Users/..."
            if (p.startsWith('alias ')) {
              p = p.substring(6);
            }
            // Remove "Macintosh HD:" prefix and convert colons to slashes
            return '/' + p.replace(/^[^:]+:/, '').replace(/:/g, '/');
          });
        } else if (isWindowsDialog) {
          // Windows/WSL: Convert Windows paths to WSL paths if needed
          selectedPaths = stdout.trim().split('\n')
            .map(p => p.trim().replace(/\r/g, ''))
            .filter(p => p.length > 0)
            .map(p => {
              // Convert Windows path to WSL path if in WSL
              if (isWSL && p.match(/^[A-Z]:\\/)) {
                const drive = p[0].toLowerCase();
                const pathPart = p.slice(3).replace(/\\/g, '/');
                return `/mnt/${drive}/${pathPart}`;
              }
              return p;
            });
        } else {
          // Linux: Clean paths and remove carriage returns
          selectedPaths = stdout.trim().split('\n')
            .map(p => p.trim().replace(/\r/g, ''))
            .filter(p => p.length > 0);
        }
      }

      console.log(`✅ Selected ${selectedPaths.length} items for import`);

      return new Response(JSON.stringify({
        success: true,
        paths: selectedPaths
      }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      // User cancelled or error
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      // Check if user just cancelled (not an actual error)
      if (errorMsg.includes('cancelled') || errorMsg.includes('User canceled')) {
        return new Response(JSON.stringify({
          success: false,
          cancelled: true
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      console.error('❌ Import picker error:', errorMsg);
      return new Response(JSON.stringify({
        success: false,
        error: errorMsg
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Route not handled by this module
  return undefined;
}
