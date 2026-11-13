import { HttpException, HttpStatus } from '@nestjs/common';

export function fieldError(field: string, message: string, status = HttpStatus.BAD_REQUEST): HttpException {
  return new HttpException({ statusCode: status, message, fieldErrors: { [field]: message } }, status);
}
