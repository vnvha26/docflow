import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { API_CONFIG, ApiConfig } from '../config';

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    const mail = config.mail ?? {
      host: '127.0.0.1', port: 1025, secure: false, from: 'DocFlow <no-reply@docflow.local>',
    };
    this.from = mail.from;
    this.transport = nodemailer.createTransport({
      host: mail.host, port: mail.port, secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
      // Production requires implicit TLS or a successful STARTTLS upgrade.
      requireTLS: config.production && !mail.secure,
      tls: { minVersion: 'TLSv1.2' },
      logger: false, debug: false,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
    });
  }

  async sendCode(email: string, purpose: 'REGISTER' | 'RESET_PASSWORD', code: string): Promise<void> {
    const operation = purpose === 'REGISTER' ? 'xác minh email đăng ký' : 'đặt lại mật khẩu';
    await this.transport.sendMail({
      from: this.from, to: email,
      subject: `DocFlow — Mã ${operation}`,
      text: `Mã ${operation} DocFlow của bạn: ${code}\n\nMã có hiệu lực trong 10 phút và chỉ dùng một lần.\nKhông chia sẻ mã này với bất kỳ ai. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
    });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
