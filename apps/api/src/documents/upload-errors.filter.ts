import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { Response } from 'express';
import { TOO_LARGE_MESSAGE } from './documents.types';

const MULTIPART_ERRORS = /^(File too large|Too many (parts|files|fields)|Field (name|value) (too long|missing)|Unexpected file field|Field name nesting too deep|Field name array index too large|Invalid field name|Multipart: Boundary not found|Malformed part header|Unexpected end of (form|file))/;

@Catch(PayloadTooLargeException, BadRequestException)
export class UploadErrorsFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();
    const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;
    if (typeof message === 'string' && MULTIPART_ERRORS.test(message)) {
      response.status(status).json(status === 413
        ? { statusCode: 413, message: TOO_LARGE_MESSAGE, fieldErrors: { file: TOO_LARGE_MESSAGE } }
        : { statusCode: 400, message: 'Yêu cầu tải lên không hợp lệ. Gửi đúng một tệp trong trường "file".' });
      return;
    }
    response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
