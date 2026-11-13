import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessTokenGuard, AuthOriginGuard } from '../auth/auth.guards';
import { AuthRequest } from '../auth/auth.types';
import { TrashService } from '../retention/trash.service';
import { CreateFolderDto, UpdateFolderDto } from './folders.dto';
import { FoldersService } from './folders.service';
import { FolderResult, FolderTree } from './folders.types';

const folderSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, parentId: { type: 'string', format: 'uuid', nullable: true },
    name: { type: 'string' }, purpose: { type: 'string', nullable: true }, documentCount: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const resultSchema = {
  type: 'object',
  properties: { folder: folderSchema, renamed: { type: 'boolean', description: 'Tên đã có ở cùng cấp nên được thêm hậu tố (2), (3)…' } },
};
const treeSchema = {
  type: 'object',
  properties: { folders: { type: 'array', items: folderSchema }, unfiledCount: { type: 'integer' }, totalCount: { type: 'integer' } },
};

@ApiTags('Folders')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('folders')
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class FoldersController {
  constructor(
    @Inject(FoldersService) private readonly folders: FoldersService,
    @Inject(TrashService) private readonly trash: TrashService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Toàn bộ thư mục của người dùng (danh sách phẳng, dựng cây theo parentId) kèm số tài liệu.' })
  @ApiOkResponse({ schema: treeSchema })
  tree(@Req() request: AuthRequest): Promise<FolderTree> {
    return this.folders.tree(request.auth!.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Tạo thư mục (tối đa 5 cấp). Trùng tên cùng cấp → tự thêm hậu tố.' })
  @ApiCreatedResponse({ schema: resultSchema })
  @ApiBadRequestResponse({ description: 'Tên không hợp lệ hoặc vượt 5 cấp (fieldErrors).' })
  @ApiNotFoundResponse({ description: 'Thư mục cha không phải của bạn.' })
  create(@Req() request: AuthRequest, @Body() body: CreateFolderDto): Promise<FolderResult> {
    return this.folders.create(request.auth!.user.id, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Đổi tên, sửa mục đích hoặc chuyển thư mục.' })
  @ApiOkResponse({ schema: resultSchema })
  @ApiBadRequestResponse({ description: 'Tên không hợp lệ, chuyển vào chính nó/thư mục con, hoặc vượt 5 cấp (fieldErrors).' })
  @ApiNotFoundResponse()
  update(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest, @Body() body: UpdateFolderDto): Promise<FolderResult> {
    return this.folders.update(request.auth!.user.id, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Đưa thư mục cùng mọi thư mục con và tài liệu bên trong vào thùng rác như một mục.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { documentCount: { type: 'integer' }, folderCount: { type: 'integer' } } } })
  @ApiNotFoundResponse()
  remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<{ documentCount: number; folderCount: number }> {
    return this.trash.trashFolder(request.auth!.user.id, id);
  }
}
