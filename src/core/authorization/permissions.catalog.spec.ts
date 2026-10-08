import { DEFAULT_ROLE_TEMPLATES, isScopeAllowed, PERMISSION_KEYS } from './permissions.catalog.js';

describe('Catálogo de permisos', () => {
  it('las plantillas de roles solo usan alcances permitidos', () => {
    for (const role of DEFAULT_ROLE_TEMPLATES) {
      for (const p of role.permissions) {
        expect(isScopeAllowed(p.key, p.scope), `${role.key}: ${p.key}/${p.scope}`).toBe(true);
      }
    }
  });

  it('el Dueño tiene todos los permisos y el Administrador todos menos la suscripción', () => {
    const byKey = Object.fromEntries(DEFAULT_ROLE_TEMPLATES.map((r) => [r.key, r]));
    expect(byKey.owner.permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(byKey.admin.permissions.map((p) => p.key)).not.toContain('subscription.manage');
  });
});
