import { safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ProviderCredentialInput } from '../../../src/shared/types';
import { getDataDir } from '../../db/database';
import { TranslationError } from './errors';

type CredentialProvider = ProviderCredentialInput['provider'];
type CredentialFile = Partial<Record<CredentialProvider, string>>;

function credentialPath(): string {
  return path.join(getDataDir(), 'config', 'translation-credentials.json');
}

function readFile(): CredentialFile {
  try {
    return JSON.parse(fs.readFileSync(credentialPath(), 'utf8')) as CredentialFile;
  } catch {
    return {};
  }
}

function writeFile(value: CredentialFile): void {
  const file = credentialPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export const credentialStore = {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  },

  has(provider: CredentialProvider): boolean {
    return Boolean(readFile()[provider]);
  },

  get(provider: CredentialProvider): string | null {
    const encoded = readFile()[provider];
    if (!encoded) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new TranslationError('PROVIDER_UNAVAILABLE', 'Secure credential storage is unavailable', false);
    }
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      throw new TranslationError('NOT_CONFIGURED', 'Saved API key cannot be decrypted; save it again', false);
    }
  },

  save(provider: CredentialProvider, apiKey: string): void {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new TranslationError('INVALID_REQUEST', 'API key cannot be empty', false);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new TranslationError('PROVIDER_UNAVAILABLE', 'Secure credential storage is unavailable', false);
    }
    const data = readFile();
    data[provider] = safeStorage.encryptString(trimmed).toString('base64');
    writeFile(data);
  },

  delete(provider: CredentialProvider): void {
    const data = readFile();
    delete data[provider];
    writeFile(data);
  },
};
