import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { WhatsAppService } from './whatsapp.service.js';

@Global()
@Module({
  providers: [MailService, WhatsAppService],
  exports: [MailService, WhatsAppService],
})
export class MailModule {}
