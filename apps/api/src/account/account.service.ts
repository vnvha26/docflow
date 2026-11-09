import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PUBLIC_USER_SELECT, PublicUser } from '../auth/auth.types';
import { UpdateAccountDto } from './account.dto';

@Injectable()
export class AccountService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_USER_SELECT });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản.');
    return user;
  }

  async update(userId: string, input: UpdateAccountDto): Promise<PublicUser> {
    const data: { displayName?: string | null; timezone?: string } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName || null;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (!Object.keys(data).length) throw new BadRequestException('Không có thông tin nào để cập nhật.');
    return this.prisma.user.update({
      where: { id: userId },
      data: { ...data, revision: { increment: 1 } },
      select: PUBLIC_USER_SELECT,
    });
  }
}
