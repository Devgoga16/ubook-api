import { effectiveStatus } from './entitlements.service.js';
import { DEFAULT_PLANS } from './plans.seed.js';
import { FEATURE_KEYS, isValidFeatureValue } from './features.catalog.js';

describe('effectiveStatus', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const past = new Date('2026-10-01T00:00:00Z');
  const future = new Date('2026-11-01T00:00:00Z');

  it('una prueba gratis vencida pasa a expired', () => {
    expect(effectiveStatus({ status: 'trialing', trialEndsAt: past }, now)).toBe('expired');
    expect(effectiveStatus({ status: 'trialing', trialEndsAt: future }, now)).toBe('trialing');
  });

  it('un periodo pagado vencido pasa a expired', () => {
    expect(effectiveStatus({ status: 'active', currentPeriodEnd: past }, now)).toBe('expired');
    expect(effectiveStatus({ status: 'active', currentPeriodEnd: future }, now)).toBe('active');
  });
});

describe('Planes por defecto', () => {
  it('definen todas las funcionalidades con valores válidos', () => {
    for (const plan of DEFAULT_PLANS) {
      for (const key of FEATURE_KEYS) {
        expect(isValidFeatureValue(key, plan.features[key]), `${plan.code}.${key}`).toBe(true);
      }
    }
  });

  it('las fichas clínicas están en todos los planes', () => {
    expect(DEFAULT_PLANS.every((p) => p.features.client_records === true)).toBe(true);
  });
});
