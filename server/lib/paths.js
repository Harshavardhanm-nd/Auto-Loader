import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const WEB_DIR = path.join(ROOT, 'web');

/** Runtime state. Gitignored — holds session ids and generated CSVs. */
export const DATA_DIR = path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const OUTPUT_DIR = path.join(DATA_DIR, 'output');
export const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json');

export function ensureDirs() {
  for (const dir of [DATA_DIR, SESSIONS_DIR, RUNS_DIR, OUTPUT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Write a file containing secrets — owner read/write only. */
export function writeSecret(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (err.code === 'ENOENT') throw new Error(`Missing file: ${file}`);
    throw new Error(`Could not parse ${file}: ${err.message}`);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
