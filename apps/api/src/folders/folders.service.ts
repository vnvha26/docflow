import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { fieldError } from '../common/field-error';
import { lockUserFiles } from '../database/locks';
import { PrismaService } from '../database/prisma.service';
import { CreateFolderDto, UpdateFolderDto } from './folders.dto';
import { FolderResult, FolderSummary, FolderTree } from './folders.types';
import { cleanFolderName, cleanPurpose, freeFolderName, MAX_FOLDER_DEPTH, MAX_FOLDER_NAME, MAX_FOLDER_PURPOSE } from './names';
import { depthOf, heightOf, isInside, TreeNode } from './tree';

const LISTED: Prisma.DocumentWhereInput = { deletedAt: null, versions: { some: {} } };
const FOLDER_SELECT = {
  id: true, parentId: true, name: true, purpose: true, createdAt: true, updatedAt: true,
  _count: { select: { documents: { where: LISTED } } },
} satisfies Prisma.FolderSelect;
type FolderRow = Prisma.FolderGetPayload<{ select: typeof FOLDER_SELECT }>;

const NAME_INVALID = `Tên thư mục cần 1–${MAX_FOLDER_NAME} ký tự và không chứa dấu / hoặc \\.`;
const TOO_DEEP = `Thư mục chỉ được lồng tối đa ${MAX_FOLDER_DEPTH} cấp.`;
const MAX_FOLDERS = 500;

function toSummary(row: FolderRow): FolderSummary {
  return {
    id: row.id, parentId: row.parentId, name: row.name, purpose: row.purpose, documentCount: row._count.documents,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

@Injectable()
export class FoldersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async tree(userId: string): Promise<FolderTree> {
    const [rows, unfiledCount, totalCount] = await Promise.all([
      this.prisma.folder.findMany({ where: { userId, deletedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: FOLDER_SELECT }),
      this.prisma.document.count({ where: { userId, folderId: null, ...LISTED } }),
      this.prisma.document.count({ where: { userId, ...LISTED } }),
    ]);
    return { folders: rows.map(toSummary), unfiledCount, totalCount };
  }

  private nodes(transaction: Prisma.TransactionClient, userId: string): Promise<TreeNode[]> {
    return transaction.folder.findMany({ where: { userId, deletedAt: null }, select: { id: true, parentId: true } });
  }

  private purpose(value: string | null | undefined): string | null {
    const purpose = cleanPurpose(value);
    if (purpose && purpose.length > MAX_FOLDER_PURPOSE) throw fieldError('purpose', `Mục đích không được vượt quá ${MAX_FOLDER_PURPOSE} ký tự.`);
    return purpose;
  }

  async create(userId: string, input: CreateFolderDto): Promise<FolderResult> {
    const wanted = cleanFolderName(input.name);
    if (!wanted) throw fieldError('name', NAME_INVALID);
    const purpose = this.purpose(input.purpose);
    const parentId = input.parentId ?? null;
    return this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const nodes = await this.nodes(transaction, userId);
      if (parentId && !nodes.some((node) => node.id === parentId)) throw fieldError('parentId', 'Không tìm thấy thư mục cha.', HttpStatus.NOT_FOUND);
      if (depthOf(nodes, parentId) + 1 > MAX_FOLDER_DEPTH) throw fieldError('parentId', TOO_DEEP);
      if (nodes.length >= MAX_FOLDERS) throw fieldError('name', `Mỗi tài khoản có tối đa ${MAX_FOLDERS} thư mục.`);
      const free = await freeFolderName(transaction, userId, parentId, wanted);
      const row = await transaction.folder.create({ data: { userId, parentId, name: free.name, purpose }, select: FOLDER_SELECT });
      return { folder: toSummary(row), renamed: free.renamed };
    });
  }

  async update(userId: string, folderId: string, input: UpdateFolderDto): Promise<FolderResult> {
    if (input.name === undefined && input.purpose === undefined && input.parentId === undefined) {
      throw fieldError('name', 'Không có thay đổi nào để lưu.');
    }
    const wanted = input.name === undefined ? undefined : cleanFolderName(input.name);
    if (wanted === null) throw fieldError('name', NAME_INVALID);
    const purpose = input.purpose === undefined ? undefined : this.purpose(input.purpose);
    return this.prisma.$transaction(async (transaction) => {
      await lockUserFiles(transaction, userId);
      const current = await transaction.folder.findFirst({ where: { id: folderId, userId, deletedAt: null }, select: { id: true, parentId: true, name: true } });
      if (!current) throw new NotFoundException('Không tìm thấy thư mục.');
      const parentId = input.parentId === undefined ? current.parentId : input.parentId;
      if (parentId !== current.parentId) {
        const nodes = await this.nodes(transaction, userId);
        if (parentId && !nodes.some((node) => node.id === parentId)) throw fieldError('parentId', 'Không tìm thấy thư mục đích.', HttpStatus.NOT_FOUND);
        if (isInside(nodes, parentId, current.id)) throw fieldError('parentId', 'Không thể chuyển thư mục vào chính nó hoặc thư mục con của nó.');
        if (depthOf(nodes, parentId) + 1 + heightOf(nodes, current.id) > MAX_FOLDER_DEPTH) throw fieldError('parentId', TOO_DEEP);
      }
      const free = await freeFolderName(transaction, userId, parentId, wanted ?? current.name, current.id);
      const row = await transaction.folder.update({
        where: { id: current.id },
        data: { name: free.name, parentId, ...(purpose === undefined ? {} : { purpose }), revision: { increment: 1 } },
        select: FOLDER_SELECT,
      });
      return { folder: toSummary(row), renamed: free.renamed };
    });
  }
}
