import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { MAX_UPLOAD_BYTES } from './documents.types';
import { DOCUMENT_SORTS, DOCUMENT_TYPE_FILTERS, DocumentSort, DocumentTypeFilter } from './documents.types';

export class UploadDocumentDto {
  @ApiPropertyOptional({ maxLength: 255, description: 'Mặc định là tên tệp (bỏ phần mở rộng).' })
  @IsOptional()
  @IsString({ message: 'Tiêu đề phải là chuỗi ký tự.' })
  @MaxLength(255, { message: 'Tiêu đề không được vượt quá 255 ký tự.' })
  title?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Thư mục nhận tài liệu; bỏ trống = "Chưa phân loại".' })
  @IsOptional()
  @IsUUID(undefined, { message: 'Thư mục không hợp lệ.' })
  folderId?: string;

  @ApiPropertyOptional({ enum: ['new', 'supplement'], description: 'Lựa chọn khi tệp trùng nội dung với tài liệu đã có: new = tải thành tài liệu mới; supplement = bổ sung bản gốc cho targetId. Bỏ trống = server tự xử lý hoặc báo trùng.' })
  @IsOptional()
  @IsIn(['new', 'supplement'], { message: 'Lựa chọn khi trùng không hợp lệ.' })
  onDuplicate?: 'new' | 'supplement';

  @ApiPropertyOptional({ format: 'uuid', description: 'Tài liệu nhận bản gốc khi onDuplicate = supplement.' })
  @ValidateIf((object: UploadDocumentDto, value: unknown) => value !== undefined || object.onDuplicate === 'supplement')
  @IsUUID(undefined, { message: 'Tài liệu cần bổ sung bản gốc không hợp lệ.' })
  targetId?: string;
}

export class CheckDuplicateDto {
  @ApiProperty({ description: 'SHA-256 của tệp (hex, chữ thường), tính ở trình duyệt.' })
  @Matches(/^[0-9a-f]{64}$/, { message: 'Mã SHA-256 không hợp lệ.' })
  sha256!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_UPLOAD_BYTES })
  @IsInt({ message: 'Kích thước tệp phải là số nguyên.' })
  @Min(1, { message: 'Tệp rỗng, không có gì để lưu.' })
  @Max(MAX_UPLOAD_BYTES, { message: 'Tệp vượt quá kích thước cho phép.' })
  size!: number;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Thư mục đang mở; null = "Chưa phân loại".' })
  @ValidateIf((_object: object, value: unknown) => value !== undefined && value !== null)
  @IsUUID(undefined, { message: 'Thư mục không hợp lệ.' })
  folderId?: string | null;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ maxLength: 255, description: 'Tên hiển thị mới. Trùng tên trong thư mục → tự thêm hậu tố.' })
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsString({ message: 'Tên tài liệu phải là chuỗi ký tự.' })
  @MaxLength(255, { message: 'Tên tài liệu không được vượt quá 255 ký tự.' })
  title?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Chuyển tới thư mục này; null = "Chưa phân loại".' })
  @ValidateIf((_object: object, value: unknown) => value !== undefined && value !== null)
  @IsUUID(undefined, { message: 'Thư mục không hợp lệ.' })
  folderId?: string | null;
}

export class ListDocumentsQuery {
  @ApiPropertyOptional({ description: 'Giá trị nextCursor của trang trước.' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,2000}$/, { message: 'Con trỏ phân trang không hợp lệ.' })
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên.' })
  @Min(1, { message: 'limit tối thiểu là 1.' })
  @Max(50, { message: 'limit tối đa là 50.' })
  limit?: number;

  @ApiPropertyOptional({ enum: DOCUMENT_TYPE_FILTERS, description: 'Lọc theo loại tệp.' })
  @IsOptional()
  @IsIn(DOCUMENT_TYPE_FILTERS, { message: 'Loại tệp không hợp lệ.' })
  type?: DocumentTypeFilter;

  @ApiPropertyOptional({ description: 'UUID thư mục, hoặc "none" cho tài liệu chưa phân loại. Bỏ trống = mọi thư mục.' })
  @IsOptional()
  @Matches(/^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, { message: 'Thư mục không hợp lệ.' })
  folder?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_SORTS, default: 'created', description: 'created: mới tải lên trước; updated: mới cập nhật trước; name / name-desc: theo tên.' })
  @IsOptional()
  @IsIn(DOCUMENT_SORTS, { message: 'Cách sắp xếp không hợp lệ.' })
  sort?: DocumentSort;
}

