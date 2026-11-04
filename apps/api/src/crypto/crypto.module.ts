import { Module } from '@nestjs/common';
import { FileVault } from './file-vault.service';

@Module({ providers: [FileVault], exports: [FileVault] })
export class CryptoModule {}
