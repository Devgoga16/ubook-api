import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';
import { FieldCryptoService } from './field-crypto.service.js';

const config = (values: Partial<Env>) => ({ get: (k: keyof Env) => values[k] }) as unknown as ConfigService<Env, true>;
const key = randomBytes(32).toString('base64');

describe('FieldCryptoService', () => {
  it('cifra y descifra; el texto cifrado no revela el contenido y cambia en cada llamada', () => {
    const crypto = new FieldCryptoService(config({ RECORDS_ENCRYPTION_KEY: key, NODE_ENV: 'test' }));
    const secret = { motivo: 'Ansiedad por el trabajo', riesgo: 'Bajo' };
    const a = crypto.encryptJson(secret);
    const b = crypto.encryptJson(secret);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('Ansiedad');
    expect(a).not.toBe(b);
    expect(crypto.decryptJson(a)).toEqual(secret);
  });

  it('detecta alteraciones y claves equivocadas', () => {
    const crypto = new FieldCryptoService(config({ RECORDS_ENCRYPTION_KEY: key, NODE_ENV: 'test' }));
    const payload = crypto.encrypt('hola');
    const tampered = payload.slice(0, -4) + (payload.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => crypto.decrypt(tampered)).toThrow();
    const other = new FieldCryptoService(config({ RECORDS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), NODE_ENV: 'test' }));
    expect(() => other.decrypt(payload)).toThrow();
  });

  it('exige la clave en producción', () => {
    expect(() => new FieldCryptoService(config({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(40) }))).toThrow(/obligatoria/);
  });
});
