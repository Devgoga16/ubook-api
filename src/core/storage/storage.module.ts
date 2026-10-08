import { Controller, Get, Global, Module, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { StorageService } from './storage.service.js';

/** Archivos locales (solo sin R2): el enlace firmado es la autorización. */
@Public()
@Controller('files')
class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  async file(@Param('token') token: string, @Res() res: Response) {
    const file = await this.storage.readLocal(token);
    if (!file) throw new NotFoundException();
    res.setHeader('Content-Type', file.type);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.buffer);
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
