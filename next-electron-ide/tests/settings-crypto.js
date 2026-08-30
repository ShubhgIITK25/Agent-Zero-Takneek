/**
 * Tests for the small adapter used to protect API-key values at rest.
 *
 * The fake provider keeps this test offline and verifies the contract without
 * starting Electron or depending on a particular desktop keychain.
 */
const assert = require('assert');
const path = require('path');

const { decryptEnvVars, encryptEnvVars } = require(path.join(
  __dirname,
  '..',
  'electron-dist',
  'settings-crypto',
));

const makeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`cipher:${value}`, 'utf8'),
  decryptString: (value) => {
    const decoded = value.toString('utf8');
    if (!decoded.startsWith('cipher:')) throw new Error('bad ciphertext');
    return decoded.slice('cipher:'.length);
  },
});

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log('  ok  ', name);
    pass++;
  } catch (e) {
    console.log('  FAIL', name, '\n       ', e.message);
    fail++;
  }
};

console.log('\n== settings crypto: API-key values are protected at rest ==');

t('encrypts and round-trips every environment value', () => {
  const values = { GROQ_API_KEY: 'secret-groq', CUSTOM_TOKEN: 'secret-custom' };
  const encrypted = encryptEnvVars(values, makeStorage());
  assert.notDeepStrictEqual(encrypted, values);
  assert.ok(!JSON.stringify(encrypted).includes('secret-groq'));
  assert.deepStrictEqual(decryptEnvVars(encrypted, makeStorage()), values);
});

t('fails closed when secure storage is unavailable', () => {
  assert.throws(
    () => encryptEnvVars({ GROQ_API_KEY: 'secret' }, makeStorage(false)),
    /Secure storage is unavailable/,
  );
});

t('allows an empty settings file without requiring a keychain', () => {
  assert.deepStrictEqual(encryptEnvVars({}, makeStorage(false)), {});
  assert.deepStrictEqual(decryptEnvVars({}, makeStorage(false)), {});
});

t('rejects ciphertext that cannot be decrypted', () => {
  assert.throws(
    () => decryptEnvVars({ GROQ_API_KEY: Buffer.from('wrong').toString('base64') }, makeStorage()),
    /Could not decrypt saved API keys/,
  );
});

if (fail) {
  console.error(`\n${fail} crypto test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} crypto tests passed`);
