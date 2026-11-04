import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrivacyLevel } from '@prisma/client';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { PUBLIC_USER_SELECT, PublicUser } from '../auth/auth.types';
import { RetentionService } from '../retention/retention.service';
import { UpdateAccountDto } from './account.dto';

@Injectable()
export class AccountService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RetentionService) private readonly retention: RetentionService,
  ) {}

  async get(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_USER_SELECT });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản.');
    return user;
  }

  async update(userId: string, input: UpdateAccountDto): Promise<PublicUser> {
    const data: { displayName?: string | null; timezone?: string; privacyLevel?: PrivacyLevel } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName || null;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.privacyLevel !== undefined) data.privacyLevel = input.privacyLevel;
    if (!Object.keys(data).length) throw new BadRequestException('Không có thông tin nào để cập nhật.');
    // Profile settings are last-write-wins; revision still records that the row changed.
    return this.prisma.$transaction(async (transaction) => {
      let previous: PrivacyLevel | null = null;
      if (data.privacyLevel) {
        await lockUserFiles(transaction, userId);
        const current = await transaction.user.findUnique({ where: { id: userId }, select: { privacyLevel: true } });
        if (!current) throw new NotFoundException('Không tìm thấy tài khoản.');
        previous = current.privacyLevel;
      }
      const user = await transaction.user.update({
        where: { id: userId },
        data: { ...data, revision: { increment: 1 } },
        select: PUBLIC_USER_SELECT,
      });
      if (previous && data.privacyLevel) await this.retention.enforceAccount(transaction, userId, previous, data.privacyLevel);
      return user;
    });
  }
}
