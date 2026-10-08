import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { UsersService } from '../identity/users.service.js';
import { PlansService } from '../platform/plans.service.js';

/** Al iniciar: crea los planes por defecto y el primer super admin si faltan. */
@Injectable()
export class PlatformBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformBootstrapService.name);

  constructor(
    private readonly plans: PlansService,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.plans.seedDefaults();
    await this.ensureSuperAdmin();
  }

  private async ensureSuperAdmin(): Promise<void> {
    if (await this.users.hasSuperAdmin()) return;

    const email = this.config.get('SUPERADMIN_EMAIL', { infer: true });
    const password = this.config.get('SUPERADMIN_PASSWORD', { infer: true });
    if (!email || !password) {
      this.logger.warn('No hay super admin. Define SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD para crearlo.');
      return;
    }
    if (await this.users.findByEmail(email)) {
      this.logger.warn(`SUPERADMIN_EMAIL (${email}) ya pertenece a una cuenta normal; no se modifica.`);
      return;
    }
    await this.users.create({
      email,
      password,
      firstName: 'Super',
      lastName: 'Admin',
      platformRole: 'super_admin',
    });
    this.logger.log(`Super admin creado: ${email}`);
  }
}
