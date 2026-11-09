import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class UploadDocumentDto {
  @ApiPropertyOptional({ maxLength: 255, description: 'Mặc định là tên tệp (bỏ phần mở rộng).' })
  @IsOptional()
  @IsString({ message: 'Tiêu đề phải là chuỗi ký tự.' })
  @MaxLength(255, { message: 'Tiêu đề không được vượt quá 255 ký tự.' })
  title?: string;
}

export class ListDocumentsQuery {
  @ApiPropertyOptional({ description: 'Giá trị nextCursor của trang trước.' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/, { message: 'Con trỏ phân trang không hợp lệ.' })
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên.' })
  @Min(1, { message: 'limit tối thiểu là 1.' })
  @Max(50, { message: 'limit tối đa là 50.' })
  limit?: number;
}

