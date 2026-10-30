import os from 'node:os';
import path from 'node:path';

// Klaude's per-user directory: sessions, memory and global instructions.
export function klaudeHome() {
  return process.env.KLAUDE_HOME || path.join(os.homedir(), '.klaude');
}
