import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class LoginDto {
  @ApiProperty({ example: 'ban@example.com', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsString({ message: 'Email phải là chuỗi ký tự.' })
  @IsEmail({}, { message: 'Email không hợp lệ.' })
  @MaxLength(254, { message: 'Email không được vượt quá 254 ký tự.' })
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự.' })
  @Length(12, 128, { message: 'Mật khẩu phải có từ 12 đến 128 ký tự.' })
  password!: string;
}

export class RegisterDto extends LoginDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'Nguyễn An' })
  @IsOptional()
  @IsString({ message: 'Tên hiển thị phải là chuỗi ký tự.' })
  @MaxLength(100, { message: 'Tên hiển thị không được vượt quá 100 ký tự.' })
  displayName?: string;
}

// Empty bodies are optional, but unknown properties are still rejected by ValidationPipe.
export class EmptyAuthDto {}

export class ChallengeIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4', { message: 'Phiên xác minh không hợp lệ.' })
  challengeId!: string;
}

export class VerifyEmailDto extends ChallengeIdDto {
  @ApiProperty({ example: '123456', pattern: '^[0-9]{6}$' })
  @IsString({ message: 'Mã xác minh phải là chuỗi 6 chữ số.' })
  @Matches(/^[0-9]{6}$/, { message: 'Mã xác minh phải có đúng 6 chữ số.' })
  code!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ban@example.com', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? normalizeEmail(value) : value)
  @IsString({ message: 'Email phải là chuỗi ký tự.' })
  @IsEmail({}, { message: 'Email không hợp lệ.' })
  @MaxLength(254, { message: 'Email không được vượt quá 254 ký tự.' })
  email!: string;
}

export class ResetPasswordDto extends VerifyEmailDto {
  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự.' })
  @Length(12, 128, { message: 'Mật khẩu phải có từ 12 đến 128 ký tự.' })
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ maxLength: 128, format: 'password' })
  @IsString({ message: 'Mật khẩu hiện tại phải là chuỗi ký tự.' })
  @Length(1, 128, { message: 'Nhập mật khẩu hiện tại.' })
  currentPassword!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString({ message: 'Mật khẩu mới phải là chuỗi ký tự.' })
  @Length(12, 128, { message: 'Mật khẩu mới phải có từ 12 đến 128 ký tự.' })
  newPassword!: string;
}
