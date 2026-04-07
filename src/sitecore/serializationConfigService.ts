import { SerializationStatus } from '../tree/models';
import serializationConfig from './serializationConfig.json';

export interface SerializationMatch {
  status: SerializationStatus;
  moduleName: string;
  moduleDescription?: string;
  subtreeKey: string;
  subtreePath: string;
  subtreeScope?: string;
  subtreePushOperations?: string;
  subtreeDatabase?: string;
  yamlPath: string;
}

export class SerializationConfigService {
  private static instance: SerializationConfigService;
  private config: any;

  private buildYamlPath(moduleName: string, subtreeKey: string): string {
    return `${moduleName}/${subtreeKey}`;
  }

  private constructor() {
    this.config = serializationConfig;
  }

  static getInstance(): SerializationConfigService {
    if (!SerializationConfigService.instance) {
      SerializationConfigService.instance = new SerializationConfigService();
    }
    return SerializationConfigService.instance;
  }

  /**
   * Normalize path for case-insensitive comparison
   */
  private normalizePath(path: string): string {
    return path.toLowerCase().trim();
  }

  /**
   * Check if an item path is directly serialized
   * Returns match info if found, including serialization status
   */
  checkSerializationStatus(itemPath: string): SerializationMatch | null {
    const normalizedItemPath = this.normalizePath(itemPath);

    for (const module of this.config.modules) {
      for (const subtree of module.subtrees) {
        const normalizedSubtreePath = this.normalizePath(subtree.path);

        // Exact match for SingleItem scope
        if (normalizedItemPath === normalizedSubtreePath) {
          return {
            status: SerializationStatus.Direct,
            moduleName: module.name,
            moduleDescription: module.description,
            subtreeKey: subtree.key,
            subtreePath: subtree.path,
            subtreeScope: subtree.scope,
            subtreePushOperations: subtree.pushOperations,
            subtreeDatabase: subtree.database,
            yamlPath: this.buildYamlPath(module.name, subtree.key)
          };
        }

        // ItemAndChildren scope: check if item is under the subtree
        if (subtree.scope === 'ItemAndChildren' || subtree.scope === undefined) {
          if (normalizedItemPath.startsWith(normalizedSubtreePath + '/')) {
            // Item is a child of the subtree
            return {
              status: SerializationStatus.Indirect,
              moduleName: module.name,
              moduleDescription: module.description,
              subtreeKey: subtree.key,
              subtreePath: subtree.path,
              subtreeScope: subtree.scope,
              subtreePushOperations: subtree.pushOperations,
              subtreeDatabase: subtree.database,
              yamlPath: this.buildYamlPath(module.name, subtree.key)
            };
          }
        }
      }
    }

    // No match found
    return null;
  }

  /**
   * Get all modules and their subtrees
   */
  getAllModules() {
    return this.config.modules;
  }

  /**
   * Get all direct subtree paths (for reference)
   */
  getAllSubtreePaths(): string[] {
    const paths: string[] = [];
    for (const module of this.config.modules) {
      for (const subtree of module.subtrees) {
        paths.push(subtree.path);
      }
    }
    return paths;
  }

  getModuleByName(moduleName: string) {
    return this.config.modules.find((module: any) => module.name === moduleName);
  }

  resolveModuleJsonPath(moduleName: string): string {
    const module = this.getModuleByName(moduleName);
    if (module?.jsonPath) {
      return module.jsonPath;
    }

    const normalizedName = moduleName.toLowerCase();
    return `serialization/${normalizedName}/${normalizedName}.json`;
  }
}
