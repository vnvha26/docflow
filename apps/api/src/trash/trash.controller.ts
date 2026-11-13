import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AccessTokenGuard, AuthOriginGuard } from '../auth/auth.guards';
import { AuthRequest } from '../auth/auth.types';
import { RestoreResult, TrashEntry, TrashService } from '../retention/trash.service';

const KINDS = ['DOCUMENT', 'FOLDER', 'ORIGINAL'];
const entrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: KINDS }, name: { type: 'string' },
    documentId: { type: 'string', format: 'uuid', nullable: true }, folderId: { type: 'string', format: 'uuid', nullable: true },
    location: { type: 'string', nullable: true, description: 'Đường dẫn thư mục lúc xóa; null = cấp ngoài cùng / chưa phân loại.' },
    documentCount: { type: 'integer' }, folderCount: { type: 'integer' },
    deletedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
  },
};
const restoreSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS }, name: { type: 'string' },
    renamed: { type: 'boolean', description: 'Chỗ cũ đã có tên trùng nên được thêm hậu tố.' },
    moved: { type: 'boolean', description: 'Thư mục cũ không còn nên được đưa về thư mục cha gần nhất còn tồn tại.' },
    folderId: { type: 'string', format: 'uuid', nullable: true }, location: { type: 'string', nullable: true },
  },
};

@ApiTags('Trash')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('trash')
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class TrashController {
  constructor(@Inject(TrashService) private readonly trash: TrashService) {}

  @Get()
  @ApiOperation({ summary: 'Các mục trong thùng rác của người dùng, mới xóa trước.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { items: { type: 'array', items: entrySchema } } } })
  async list(@Req() request: AuthRequest): Promise<{ items: TrashEntry[] }> {
    return { items: await this.trash.list(request.auth!.user.id) };
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Khôi phục về chỗ cũ; thư mục cũ không còn thì về thư mục cha gần nhất còn tồn tại; trùng tên thì thêm hậu tố.' })
  @ApiOkResponse({ schema: restoreSchema })
  @ApiNotFoundResponse()
  restore(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<RestoreResult> {
    return this.trash.restore(request.auth!.user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Xóa vĩnh viễn một mục ngay; không khôi phục được.' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async purge(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<void> {
    await this.trash.purge(request.auth!.user.id, id);
  }

  @Delete()
  @ApiOperation({ summary: 'Dọn sạch thùng rác: xóa vĩnh viễn mọi mục.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { purged: { type: 'integer' } } } })
  async empty(@Req() request: AuthRequest): Promise<{ purged: number }> {
    return { purged: await this.trash.empty(request.auth!.user.id) };
  }
}
