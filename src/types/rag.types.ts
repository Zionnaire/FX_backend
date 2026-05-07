// src/types/rag.types.ts

import { Types } from 'mongoose';

export interface IRagDocument {
  _id?:          Types.ObjectId;
  userId:        Types.ObjectId;
  fileName:      string;
  fileUrl:       string;
  cloudinaryId:  string;
  mimetype:      string;
  chunkCount:    number;
  status:        'processing' | 'indexed' | 'error';
  type:          'document' | 'rule' | 'observation';
  metadata?:     Record<string, unknown>;  // was Record<string, any>
  createdAt?:    Date;
  updatedAt?:    Date;
}

export interface IRagEmbedding {
  _id?:         Types.ObjectId;
  userId:       Types.ObjectId;
  documentId:   Types.ObjectId;  // was string — must be ObjectId ref
  chunkText:    string;
  chunkIndex:   number;
  embedding:    number[];
  metadata?:    Record<string, unknown>;
  createdAt?:   Date;
  updatedAt?:   Date;
}