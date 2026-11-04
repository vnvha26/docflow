import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessTokenGuard, AuthOriginGuard } from '../auth/auth.guards';
import { AuthRequest, PublicUser } from '../auth/auth.types';
import { UpdateAccountDto } from './account.dto';
import { AccountService } from './account.service';

const accountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' },
    displayName: { type: 'string', nullable: true }, timezone: { type: 'string', example: 'Asia/Ho_Chi_Minh' },
    privacyLevel: { type: 'string', enum: ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'] },
  },
  required: ['id', 'email', 'displayName', 'timezone', 'privacyLevel'],
};

@ApiTags('Account')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('account')
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy thông tin và cài đặt của tài khoản hiện tại.' })
  @ApiOkResponse({ schema: accountSchema })
  get(@Req() request: AuthRequest): Promise<PublicUser> {
    return this.account.get(request.auth!.user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Cập nhật tên hiển thị và/hoặc múi giờ (A6).' })
  @ApiOkResponse({ schema: accountSchema })
  @ApiBadRequestResponse({ description: 'Dữ liệu không hợp lệ hoặc không có trường nào để cập nhật.' })
  update(@Req() request: AuthRequest, @Body() body: UpdateAccountDto): Promise<PublicUser> {
    return this.account.update(request.auth!.user.id, body);
  }
}
