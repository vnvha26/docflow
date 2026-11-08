import {
  Body, Controller, Delete, Get, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile,
  UseFilters, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiConsumes, ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse,
  ApiOkResponse, ApiOperation, ApiPayloadTooLargeResponse, ApiProduces, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse, ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { pipeline } from 'node:stream/promises';
import { AccessTokenGuard, AuthOriginGuard } from '../auth/auth.guards';
import { AuthRequest } from '../auth/auth.types';
import { RetentionService } from '../retention/retention.service';
import { ListDocumentsQuery, UpdateDocumentDto, UploadDocumentDto } from './documents.dto';
import { DocumentsService, UploadedFile as StoredUpload } from './documents.service';
import { DocumentSummary, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, StorageUsage, UploadResult } from './documents.types';
import { contentDisposition } from './file-name';
import { UploadErrorsFilter } from './upload-errors.filter';
import { UploadGuard } from './upload.guard';

const summarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
    typeCode: { type: 'string', nullable: true },
    privacyLevel: { type: 'string', enum: ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'] },
    status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNSUPPORTED'] },
    file: { type: 'object', properties: { name: { type: 'string' }, mimeType: { type: 'string' }, byteSize: { type: 'integer' } } },
    privacyOverride: { type: 'string', nullable: true, enum: ['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'] },
    originalAvailable: { type: 'boolean' }, originalDeleting: { type: 'boolean' },
  },
};

@ApiTags('Documents')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('documents')
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RetentionService) private readonly retention: RetentionService,
  ) {}

  @Post()
  @UseGuards(UploadGuard)
  @UseFilters(UploadErrorsFilter)
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 2048, parts: 4 },
    defParamCharset: 'utf8',
  } as Parameters<typeof FileInterceptor>[1]))
  @ApiOperation({ summary: `Tải lên PDF/DOCX/TXT ≤ ${MAX_UPLOAD_MB} MB. Trùng nội dung với tài liệu đã có → 200 và trả tài liệu cũ.` })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string', maxLength: 255 } } } })
  @ApiCreatedResponse({ schema: { type: 'object', properties: { document: summarySchema, duplicate: { type: 'boolean' } } } })
  @ApiPayloadTooLargeResponse({ description: `Tệp quá ${MAX_UPLOAD_MB} MB hoặc vượt hạn mức bản gốc mức 3.` })
  @ApiUnsupportedMediaTypeResponse({ description: 'Không phải PDF, DOCX hoặc TXT UTF-8 (kiểm bằng nội dung tệp).' })
  @ApiTooManyRequestsResponse()
  async upload(
    @UploadedFile() file: StoredUpload | undefined,
    @Body() body: UploadDocumentDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadResult> {
    const result = await this.documents.upload(request.auth!.user.id, file, body.title);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách tài liệu của người dùng hiện tại, mới nhất trước (phân trang bằng cursor).' })
  @ApiOkResponse({ schema: { type: 'object', properties: { items: { type: 'array', items: summarySchema }, nextCursor: { type: 'string', nullable: true } } } })
  list(@Req() request: AuthRequest, @Query() query: ListDocumentsQuery): Promise<{ items: DocumentSummary[]; nextCursor: string | null }> {
    return this.documents.list(request.auth!.user.id, query.cursor, query.limit);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Dung lượng bản gốc mã hóa (mức 3) đã dùng và hạn mức.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { encryptedBytes: { type: 'integer' }, quotaBytes: { type: 'integer' } } } })
  usage(@Req() request: AuthRequest): Promise<StorageUsage> {
    return this.documents.usage(request.auth!.user.id);
  }

  @Get(':id')
  @ApiOkResponse({ schema: summarySchema })
  @ApiNotFoundResponse()
  get(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<DocumentSummary> {
    return this.documents.get(request.auth!.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'P2: đặt mức lưu trữ riêng cho tài liệu (chỉ hạ, không cao hơn tài khoản; null = theo tài khoản).' })
  @ApiOkResponse({ schema: summarySchema })
  @ApiConflictResponse({ description: 'Mức cao hơn mức của tài khoản.' })
  @ApiNotFoundResponse()
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateDocumentDto, @Req() request: AuthRequest): Promise<DocumentSummary> {
    const userId = request.auth!.user.id;
    await this.retention.setDocumentLevel(userId, id, body.privacyLevel);
    return this.documents.get(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'B5: xóa mềm tài liệu. Ẩn khỏi danh sách, khóa mọi đường dẫn, xóa nội dung chữ ngay; bản lưu được worker xóa sau đó.' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Không phải tài liệu của bạn hoặc đã bị xóa.' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<void> {
    await this.retention.deleteDocument(request.auth!.user.id, id);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Bản xem HTML của tệp DOCX (chỉ mức 3 còn bản gốc). Không giữ bố cục trang như Word.' })
  @ApiProduces('text/html')
  @ApiOkResponse({ schema: { type: 'string' } })
  @ApiNotFoundResponse({ description: 'Không phải DOCX của bạn, không ở mức 3 hoặc không còn bản gốc.' })
  @ApiUnprocessableEntityResponse({ description: 'Không tạo được bản xem cho tệp này.' })
  async preview(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest, @Res() response: Response): Promise<void> {
    const html = await this.documents.preview(request.auth!.user.id, id);
    response.status(200).set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    }).send(html);
  }

  @Delete(':id/original')
  @HttpCode(202)
  @ApiOperation({ summary: 'P5: xóa bản gốc mã hóa, giữ tài liệu và dữ liệu đã trích xuất. Blob được worker xóa ngay sau đó.' })
  @ApiAcceptedResponse({ schema: summarySchema })
  @ApiNotFoundResponse({ description: 'Không phải tài liệu của bạn hoặc không có bản gốc.' })
  async deleteOriginal(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest): Promise<DocumentSummary> {
    const userId = request.auth!.user.id;
    await this.retention.deleteOriginal(userId, id);
    return this.documents.get(userId, id);
  }

  @Get(':id/original')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tải bản gốc (chỉ tài liệu mức 3 còn bản gốc mã hóa). Giải mã và gửi dạng luồng.' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ description: 'Không phải tài liệu của bạn, không ở mức 3 hoặc không còn bản gốc.' })
  async original(@Param('id', new ParseUUIDPipe()) id: string, @Req() request: AuthRequest, @Res() response: Response): Promise<void> {
    const file = await this.documents.openOriginal(request.auth!.user.id, id);
    response.status(200).set({
      'Content-Type': file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType,
      'Content-Length': String(file.byteSize),
      'Content-Disposition': contentDisposition(file.fileName),
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    try {
      await pipeline(file.body, file.decrypt, response);
    } catch {
      this.logger.error(`Gửi bản gốc thất bại hoặc dữ liệu không toàn vẹn (document ${id}).`);
      response.destroy();
    }
  }
}
