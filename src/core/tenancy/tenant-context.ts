import { ClsServiceManager } from 'nestjs-cls';
import type { StaffAccess } from '../authorization/access.types.js';

export type AuthContextType = 'account' | 'staff' | 'platform';
export type PlatformRole = 'super_admin' | 'support';

export interface Actor {
  userId: string;
  ctx: AuthContextType;
  sessionId: string;
  organizationId?: string;
  membershipId?: string;
  platformRole?: PlatformRole | null;
}

const ORG_KEY = 'tenant.organizationId';
const BYPASS_KEY = 'tenant.bypass';
const ACTOR_KEY = 'auth.actor';
const ACCESS_KEY = 'auth.access';

export class TenantContextMissingError extends Error {
  constructor() {
    super(
      'Operación sobre datos de tenant sin organización en contexto. ' +
        'Usa TenantContext.runForOrganization() o TenantContext.runAsSystem().',
    );
  }
}

function cls() {
  return ClsServiceManager.getClsService();
}

function safeGet<T>(key: string): T | undefined {
  const service = cls();
  return service.isActive() ? (service.get(key) as T | undefined) : undefined;
}

/**
 * Contexto por petición (AsyncLocalStorage) con la organización activa,
 * el actor autenticado y sus permisos. Lo usa el plugin de tenant de Mongoose
 * para filtrar automáticamente cada consulta.
 */
export const TenantContext = {
  getOrganizationId(): string | undefined {
    return safeGet<string>(ORG_KEY);
  },

  requireOrganizationId(): string {
    const id = this.getOrganizationId();
    if (!id) throw new TenantContextMissingError();
    return id;
  },

  setOrganizationId(id: string): void {
    cls().set(ORG_KEY, id);
  },

  isBypassed(): boolean {
    return safeGet<boolean>(BYPASS_KEY) === true;
  },

  getActor(): Actor | undefined {
    return safeGet<Actor>(ACTOR_KEY);
  },

  setActor(actor: Actor): void {
    cls().set(ACTOR_KEY, actor);
  },

  getAccess(): StaffAccess | undefined {
    return safeGet<StaffAccess>(ACCESS_KEY);
  },

  setAccess(access: StaffAccess): void {
    cls().set(ACCESS_KEY, access);
  },

  /** Ejecuta `fn` con la organización indicada como tenant activo. */
  runForOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return cls().run({ ifNested: 'inherit' }, () => {
      cls().set(ORG_KEY, organizationId);
      cls().set(BYPASS_KEY, false);
      return fn();
    });
  },

  /**
   * Ejecuta `fn` sin filtro de tenant. Solo para código de sistema o de
   * plataforma (login, super admin, jobs). Cada uso debe filtrar explícitamente.
   */
  runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
    return cls().run({ ifNested: 'inherit' }, () => {
      cls().set(BYPASS_KEY, true);
      return fn();
    });
  },
};
