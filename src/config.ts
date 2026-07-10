import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface JarvisConfig {
  vaultPath: string;
  dbPath: string;
  worker: {
    command: string;
    baseArgs: string[];
  };
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = JSON.parse(
  readFileSync(resolve(projectRoot, 'jarvis.config.json'), 'utf8'),
) as JarvisConfig;

export const config: JarvisConfig = {
  ...raw,
  vaultPath: resolve(projectRoot, raw.vaultPath),
  dbPath: resolve(projectRoot, raw.dbPath),
};
