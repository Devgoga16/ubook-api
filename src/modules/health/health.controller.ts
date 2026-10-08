import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { Public } from '../../core/auth/decorators.js';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Public()
  @SkipThrottle()
  @Get()
  check() {
    return { status: 'ok', database: this.connection.readyState === 1 ? 'up' : 'down' };
  }
}
