export enum SerializationStatus {
  NotSerialized = 'not-serialized',
  Direct = 'direct',
  Indirect = 'indirect'
}

export interface SitecoreItem {
  id: string;
  name: string;
  path: string;
  templateId?: string;
  templateName?: string;
  sortOrder?: number;
  displayName?: string;
  created?: string;
  updated?: string;
  hasChildren: boolean;
  status: SerializationStatus;
  yamlPath?: string;
  matchedModule?: string;
  pushOperations?: string;
}