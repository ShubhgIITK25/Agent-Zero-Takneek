/**
 * Small adapter around Electron's safeStorage API.
 *
 * Keeping this logic independent of the main process makes the failure modes
 * easy to test without starting an Electron app. The settings file stores
 * ciphertext as base64; the OS-backed keychain owns the encryption key.
 */
export type SecureStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

const unavailableMessage =
  "Secure storage is unavailable. Unlock your OS keychain or enable a keychain provider before saving API keys.";

export function encryptEnvVars(
  envVars: Record<string, string>,
  storage: SecureStorage,
): Record<string, string> {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return {};
  if (!storage.isEncryptionAvailable()) {
    throw new Error(unavailableMessage);
  }

  try {
    return Object.fromEntries(
      entries.map(([key, value]) => [
        key,
        storage.encryptString(value).toString("base64"),
      ]),
    );
  } catch {
    throw new Error("Could not encrypt API keys with OS secure storage.");
  }
}

export function decryptEnvVars(
  encryptedEnvVars: Record<string, string>,
  storage: SecureStorage,
): Record<string, string> {
  const entries = Object.entries(encryptedEnvVars);
  if (entries.length === 0) return {};
  if (!storage.isEncryptionAvailable()) {
    throw new Error(
      "Secure storage is unavailable. Unlock your OS keychain before opening saved API keys.",
    );
  }

  try {
    return Object.fromEntries(
      entries.map(([key, value]) => {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("invalid ciphertext");
        }
        return [key, storage.decryptString(Buffer.from(value, "base64"))];
      }),
    );
  } catch {
    throw new Error(
      "Could not decrypt saved API keys. Unlock the OS keychain and try again.",
    );
  }
}
