import { Module } from '@nestjs/common';
import { AiGateway } from './ai-gateway';

@Module({
  providers: [AiGateway],
  exports: [AiGateway],
})
export class AiModule {}
