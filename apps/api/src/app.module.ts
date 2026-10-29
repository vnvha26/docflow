import { Controller, Get, Module } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthModule } from './auth/auth.module';
import { SettingsModule } from './config';

@ApiTags('Health')
@Controller('health')
class HealthController {
  @Get()
  @ApiOkResponse({ schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } })
  health() { return { status: 'ok' }; }
}

@Module({ imports: [SettingsModule, AuthModule], controllers: [HealthController] })
export class AppModule {}
