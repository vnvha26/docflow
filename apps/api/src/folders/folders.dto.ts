import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { MAX_FOLDER_NAME, MAX_FOLDER_PURPOSE } from './names';

const given = (_object: object, value: unknown) => value !== undefined;
const present = (_object: object, value: unknown) => value !== undefined && value !== null;
const NAME_TOO_LONG = `Tên thư mục không được vượt quá ${MAX_FOLDER_NAME} ký tự.`;
const PURPOSE_TOO_LONG = `Mục đích không được vượt quá ${MAX_FOLDER_PURPOSE} ký tự.`;

export class CreateFolderDto {
  @ApiProperty({ maxLength: MAX_FOLDER_NAME, example: 'Nhà Cầu Giấy' })
  @IsString({ message: 'Tên thư mục phải là chuỗi ký tự.' })
  @MaxLength(MAX_FOLDER_NAME * 2, { message: NAME_TOO_LONG })
  name!: string;

  @ApiPropertyOptional({ maxLength: MAX_FOLDER_PURPOSE, nullable: true, description: 'Thư mục này dùng để làm gì; dùng cho đề xuất phân loại.' })
  @ValidateIf(present)
  @IsString({ message: 'Mục đích phải là chuỗi ký tự.' })
  @MaxLength(MAX_FOLDER_PURPOSE * 2, { message: PURPOSE_TOO_LONG })
  purpose?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Bỏ trống hoặc null = thư mục ngoài cùng.' })
  @ValidateIf(present)
  @IsUUID(undefined, { message: 'Thư mục cha không hợp lệ.' })
  parentId?: string | null;
}

export class UpdateFolderDto {
  @ApiPropertyOptional({ maxLength: MAX_FOLDER_NAME })
  @ValidateIf(given)
  @IsString({ message: 'Tên thư mục phải là chuỗi ký tự.' })
  @MaxLength(MAX_FOLDER_NAME * 2, { message: NAME_TOO_LONG })
  name?: string;

  @ApiPropertyOptional({ maxLength: MAX_FOLDER_PURPOSE, nullable: true, description: 'null hoặc chuỗi rỗng = xóa mục đích.' })
  @ValidateIf(present)
  @IsString({ message: 'Mục đích phải là chuỗi ký tự.' })
  @MaxLength(MAX_FOLDER_PURPOSE * 2, { message: PURPOSE_TOO_LONG })
  purpose?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Chuyển thư mục; null = ra cấp ngoài cùng.' })
  @ValidateIf(present)
  @IsUUID(undefined, { message: 'Thư mục cha không hợp lệ.' })
  parentId?: string | null;
}
