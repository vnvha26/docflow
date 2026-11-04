import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } })
  health() { return { status: 'ok' }; }
}
