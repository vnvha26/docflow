import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { PrivacyLevel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, ValidateBy, ValidateIf, ValidationOptions } from 'class-validator';
import { isTimeZone } from './timezone';

function IsTimeZone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: 'isTimeZone', validator: { validate: isTimeZone } }, options);
}

export class UpdateAccountDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true, example: 'Nguyễn An', description: 'Chuỗi rỗng sẽ xóa tên hiển thị.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString({ message: 'Tên hiển thị phải là chuỗi ký tự.' })
  @MaxLength(100, { message: 'Tên hiển thị không được vượt quá 100 ký tự.' })
  displayName?: string;

  @ApiPropertyOptional({ maxLength: 64, example: 'Asia/Ho_Chi_Minh', description: 'Tên múi giờ IANA.' })
  // Not @IsOptional(): it also skips null, which would reach the NOT NULL column as a 500.
  // Omitting the field keeps the current zone; null is rejected like any invalid zone.
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsTimeZone({ message: 'Múi giờ không hợp lệ. Chọn một múi giờ trong danh sách.' })
  timezone?: string;

  @ApiPropertyOptional({
    enum: PrivacyLevel,
    description: 'Mức lưu trữ (P1). Hạ mức sẽ xóa dữ liệu mức mới không cho giữ (P6): bản gốc khi rời mức 3, nội dung chữ khi về mức 1.',
  })
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsEnum(PrivacyLevel, { message: 'Mức lưu trữ không hợp lệ.' })
  privacyLevel?: PrivacyLevel;
}
