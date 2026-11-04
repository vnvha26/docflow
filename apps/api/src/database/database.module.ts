import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** One PrismaClient (one connection pool) for the whole API process. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
