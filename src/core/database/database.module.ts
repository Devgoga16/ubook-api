import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import mongoose from 'mongoose';
import type { Env } from '../../config/env.js';
import { ReplicaSetCheck } from './replica-set.check.js';

// Respuestas JSON con `id` en lugar de `_id` y sin `__v`.
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret._id;
    return ret;
  },
});
mongoose.set('strictQuery', true);

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        autoIndex: true,
      }),
    }),
  ],
  providers: [ReplicaSetCheck],
})
export class DatabaseModule {}
