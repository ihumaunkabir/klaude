// Settings files:
//   <project>/.klaude/settings.json  permissions remembered for the project
//                                     { "permissions": { "allow": ["edit_file", "bash(npm test)"] } }
//   ~/.klaude/settings.json          your defaults { "provider": "ollama", "models": { "ollama": "..." },
//                                     "mode": "manual", "autoStartOllama": false }
//   ~/.klaude/credentials.json       API keys per provider, readable only by you (mode 600)

import fs from 'node:fs/promises';
import path from 'node:path';
import { klaudeHome } from './paths.js';

export const projectSettingsFile = (cwd) => path.join(cwd, '.klaude', 'settings.json');
export const userSettingsFile = () => path.join(klaudeHome(), 'settings.json');

export async function readSettings(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

// Reads, changes and writes a settings file, keeping any keys it doesn't know.
export async function updateSettings(file, change) {
  const settings = await readSettings(file);
  change(settings);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

export async function projectAllowRules(cwd) {
  const allow = (await readSettings(projectSettingsFile(cwd))).permissions?.allow;
  return Array.isArray(allow) ? allow.map(String) : [];
}

export async function addProjectAllowRule(cwd, rule) {
  await updateSettings(projectSettingsFile(cwd), (s) => {
    s.permissions ??= {};
    const allow = new Set(Array.isArray(s.permissions.allow) ? s.permissions.allow : []);
    allow.add(rule);
    s.permissions.allow = [...allow].sort();
  });
}

export const credentialsFile = () => path.join(klaudeHome(), 'credentials.json');

// Saves (or, with null, removes) a provider's { apiKey, baseUrl }, keeping the file private.
export async function saveCredentials(provider, credentials) {
  const file = credentialsFile();
  const all = await readSettings(file);
  if (credentials) all[provider] = credentials;
  else delete all[provider];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600); // also tighten a file that already existed
}

// A provider's credentials: the environment variable wins over the saved key.
export async function resolveCredentials(provider, envName) {
  const saved = (await readSettings(credentialsFile()))[provider] ?? {};
  return { ...saved, apiKey: (envName && process.env[envName]) || saved.apiKey };
}
