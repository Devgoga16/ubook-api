import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

/**
 * Las transacciones (registro de negocios, etc.) requieren replica set o mongos.
 * Fallar al arrancar con un mensaje claro es mejor que fallar a mitad de un registro.
 */
@Injectable()
export class ReplicaSetCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Database');

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    const hello = await this.connection.db!.admin().command({ hello: 1 });
    const supportsTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    if (!supportsTransactions) {
      const message =
        'MongoDB no es un replica set y uBook necesita transacciones. ' +
        'En local: agrega "replication: replSetName: rs0" a mongod.cfg, reinicia MongoDB, ' +
        'ejecuta `pnpm db:init-rs` y usa MONGODB_URI=...?replicaSet=rs0. ' +
        'Alternativa sin instalar nada: `pnpm dev:memory`.';
      this.logger.error(message);
      throw new Error(message);
    }
  }
}
