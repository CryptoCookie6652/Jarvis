import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface JarvisConfig {
  vaultPath: string;
  dbPath: string;
  server?: {
    port: number;
  };
  worker: {
    defaultProvider?: AgentProvider;
    providers?: Partial<Record<AgentProvider, AgentCommandConfig>>;
    // Legacy single-provider shape, kept so older configs still load.
    command?: string;
    baseArgs?: string[];
  };
  conductor?: {
    provider?: AgentProvider;
    defaultIdentity?: string;
    identities?: Record<string, ConductorIdentityConfig>;
  };
}

export type AgentProvider = 'claude' | 'codex';

export interface AgentCommandConfig {
  command: string;
  baseArgs: string[];
}

export interface ConductorIdentityConfig {
  label: string;
  provider: AgentProvider;
  model?: string;
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

export function defaultProvider(): AgentProvider {
  return config.worker.defaultProvider ?? 'claude';
}

export function conductorProvider(): AgentProvider {
  return config.conductor?.provider ?? defaultProvider();
}

export function conductorIdentities(): Record<string, ConductorIdentityConfig> {
  return config.conductor?.identities ?? {
    fable: { label: 'Fable / Opus', provider: 'claude', model: 'opus' },
    sol: { label: 'Sol', provider: 'codex' },
  };
}

export function defaultConductorIdentity(): string {
  const identities = conductorIdentities();
  const configured = config.conductor?.defaultIdentity;
  if (configured && identities[configured]) return configured;
  const provider = conductorProvider();
  return Object.keys(identities).find((id) => identities[id].provider === provider) ?? Object.keys(identities)[0];
}

export function agentCommand(provider = defaultProvider()): AgentCommandConfig {
  const configured = config.worker.providers?.[provider];
  if (configured) return configured;
  if (config.worker.command && config.worker.baseArgs) {
    return { command: config.worker.command, baseArgs: config.worker.baseArgs };
  }
  throw new Error(`No command configured for agent provider "${provider}"`);
}

export function availableProviders(): AgentProvider[] {
  const configured = Object.keys(config.worker.providers ?? {}) as AgentProvider[];
  return configured.length ? configured : [defaultProvider()];
}

export function serverPort(): number {
  const override = Number.parseInt(process.env.JARVIS_PORT ?? '', 10);
  return Number.isInteger(override) && override > 0 && override <= 65_535
    ? override
    : (config.server?.port ?? 4747);
}
