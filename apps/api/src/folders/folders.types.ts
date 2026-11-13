export interface FolderSummary {
  id: string;
  parentId: string | null;
  name: string;
  purpose: string | null;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderTree {
  folders: FolderSummary[];
  unfiledCount: number;
  totalCount: number;
}

export interface FolderResult {
  folder: FolderSummary;
  renamed: boolean;
}
