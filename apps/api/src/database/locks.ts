import { Prisma } from '@prisma/client';

export async function lockUserFiles(transaction: Prisma.TransactionClient, userId: string): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'user-files:' + userId}, 0))`;
}
