declare const validated: unique symbol;

export type DocumentRow = {
  id: string;
  visualText?: string | null | undefined;
  audioText?: string | null | undefined;
  [key: string]: unknown;
};

export type DocumentReply = {
  id: string;
  createdAt?: string | null | undefined;
  [key: string]: unknown;
};

export type DocumentComment = {
  id: string;
  resolvedAt?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  replies?: DocumentReply[] | null | undefined;
  [key: string]: unknown;
};

export type DocumentTag = {
  id?: string | undefined;
  cat: string;
  name: string;
  owner?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
};

export type DocumentShotProp = { id?: string | undefined; name?: string | undefined };

export type DocumentShot = {
  id: string;
  name?: string | undefined;
  desc?: string | undefined;
  status?: unknown;
  reshoot?: unknown;
  notes?: string | undefined;
  owner?: string | undefined;
  audioRef?: string | undefined;
  location?: string | undefined;
  props?: (DocumentShotProp | null | undefined)[] | undefined;
  origin?: string | undefined;
  [key: string]: unknown;
};

export type DocumentShape = {
  title: string;
  docId: string;
  rev: number;
  schema: number;
  rows: DocumentRow[];
  comments: DocumentComment[];
  productionTags: (DocumentTag | null | undefined)[];
  brollShots: DocumentShot[];
  [key: string]: unknown;
};

export type ValidatedDocument = DocumentShape & { readonly [validated]: true };
