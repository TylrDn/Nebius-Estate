import { Config } from '@backstage/config';
import { HUGGING_FACE, TOKEN_FACTORY_API } from '@internal/nebius-domain';
import { EstateConfigError } from '../lib/config';

/**
 * `nebiusEstate.ai`: which environment variables hold the Token Factory API key and the Hugging Face
 * token (names only, never values). A block that is absent, or a variable that is empty, leaves the
 * connector `not-configured`, and it is never called. Endpoints are the documented ones; a loopback
 * override is accepted only on a loopback-only backend (the e2e stub).
 */
export interface AiConfig {
  tokenFactory?: { apiKeyEnv: string; endpoint: string };
  huggingface?: { tokenEnv: string; endpoint: string; maxModels: number };
  syncIntervalMinutes: number;
  timeoutMs: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

function endpoint(value: string | undefined, documented: string, key: string, localOnly: boolean): string {
  if (!value || value === documented) return documented;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new EstateConfigError(`${key} is not a URL`);
  }
  if (!localOnly || !LOOPBACK.includes(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new EstateConfigError(`${key} may differ from ${documented} only for a loopback endpoint on a loopback-only backend (tests)`);
  }
  return u.origin;
}

function envName(v: string, key: string): string {
  if (!ENV_NAME.test(v)) throw new EstateConfigError(`${key} must be an environment variable name`);
  return v;
}

export function readAiConfig(root: Config): AiConfig {
  const c = root.getOptionalConfig('nebiusEstate.ai');
  const localOnly = LOOPBACK.includes(root.getOptionalString('backend.listen.host') ?? '');
  const tf = c?.getOptionalConfig('tokenFactory');
  const hf = c?.getOptionalConfig('huggingface');
  return {
    tokenFactory: tf
      ? { apiKeyEnv: envName(tf.getString('apiKeyEnv'), 'ai.tokenFactory.apiKeyEnv'), endpoint: endpoint(tf.getOptionalString('endpoint'), TOKEN_FACTORY_API, 'ai.tokenFactory.endpoint', localOnly) }
      : undefined,
    huggingface: hf
      ? {
          tokenEnv: envName(hf.getString('tokenEnv'), 'ai.huggingface.tokenEnv'),
          endpoint: endpoint(hf.getOptionalString('endpoint'), HUGGING_FACE, 'ai.huggingface.endpoint', localOnly),
          maxModels: Math.min(50, Math.max(1, hf.getOptionalNumber('maxModels') ?? 20)),
        }
      : undefined,
    syncIntervalMinutes: Math.max(5, root.getOptionalNumber('nebiusEstate.nebius.syncIntervalMinutes') ?? 15),
    timeoutMs: Math.min(60_000, root.getOptionalNumber('nebiusEstate.nebius.timeoutMs') ?? 15_000),
  };
}
