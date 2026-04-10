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

export interface ModuleSubtree {
  path: string;
  scope?: string;
  database?: string;
}

export interface SerializationIncludeInfo {
  include: string;
  path?: string;
  scope?: string;
  pushOperations?: string;
  database?: string;
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

  private normalizeModuleName(moduleName: string): string {
    return moduleName.toLowerCase().trim();
  }

  private getModuleByNormalizedName(moduleName: string) {
    const normalizedModuleName = this.normalizeModuleName(moduleName);
    return this.config.modules.find((module: any) => this.normalizeModuleName(module.name) === normalizedModuleName);
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

  checkSerializationStatusForModule(itemPath: string, moduleName: string, database?: string): SerializationMatch | null {
    const normalizedItemPath = this.normalizePath(itemPath);
    const normalizedModuleName = moduleName.toLowerCase().trim();
    const databaseFilter = database?.toLowerCase().trim();

    for (const module of this.config.modules) {
      if (this.normalizePath(module.name) !== normalizedModuleName) {
        continue;
      }

      for (const subtree of module.subtrees) {
        const normalizedSubtreePath = this.normalizePath(subtree.path);
        const subtreeDatabase = typeof subtree.database === 'string' ? subtree.database.toLowerCase().trim() : undefined;

        if (databaseFilter && subtreeDatabase && subtreeDatabase !== databaseFilter) {
          continue;
        }

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

        if (subtree.scope === 'ItemAndChildren' || subtree.scope === undefined) {
          if (normalizedItemPath.startsWith(normalizedSubtreePath + '/')) {
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

    return null;
  }

  hasSerializedDescendants(itemPath: string, database?: string, moduleName?: string): boolean {
    const normalizedItemPath = this.normalizePath(itemPath);
    const databaseFilter = database?.toLowerCase().trim();
    const moduleFilter = moduleName?.toLowerCase().trim();

    for (const module of this.config.modules) {
      if (moduleFilter && this.normalizePath(module.name) !== moduleFilter) {
        continue;
      }

      for (const subtree of module.subtrees) {
        const normalizedSubtreePath = this.normalizePath(subtree.path);
        const subtreeDatabase = typeof subtree.database === 'string' ? subtree.database.toLowerCase().trim() : undefined;

        if (databaseFilter && subtreeDatabase && subtreeDatabase !== databaseFilter) {
          continue;
        }

        if (normalizedSubtreePath.startsWith(normalizedItemPath + '/')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get all modules and their subtrees
   */
  getAllModules() {
    return this.config.modules;
  }

  getModuleSubtrees(moduleName: string, database?: string): ModuleSubtree[] {
    const module = this.getModuleByName(moduleName);
    if (!module?.subtrees) {
      return [];
    }

    const databaseFilter = database?.toLowerCase().trim();
    return module.subtrees
      .filter((subtree: { database?: string }) => {
        if (!databaseFilter || !subtree.database) {
          return true;
        }

        return subtree.database.toLowerCase().trim() === databaseFilter;
      })
      .map((subtree: { path: string; scope?: string; database?: string }) => ({
        path: subtree.path,
        scope: subtree.scope,
        database: subtree.database
      }));
  }

  getModuleNames(): string[] {
    return this.config.modules.map((module: { name: string }) => module.name);
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
    return this.getModuleByNormalizedName(moduleName);
  }

  inferIncludeFromYamlPath(yamlPath?: string): string | undefined {
    if (!yamlPath) {
      return undefined;
    }

    const normalizedYamlPath = yamlPath.replace(/\\/g, '/');
    const itemsMatch = normalizedYamlPath.match(/\/items\/([^/]+)\//i);
    if (itemsMatch?.[1]) {
      return itemsMatch[1];
    }

    return undefined;
  }

  getIncludeInfo(moduleName: string, includeName?: string): SerializationIncludeInfo | undefined {
    const normalizedIncludeName = includeName?.toLowerCase().trim();
    if (!normalizedIncludeName) {
      return undefined;
    }

    const module = this.getModuleByNormalizedName(moduleName);
    if (!module?.subtrees) {
      return undefined;
    }

    const subtree = module.subtrees.find((entry: any) => typeof entry?.key === 'string' && entry.key.toLowerCase().trim() === normalizedIncludeName);
    if (!subtree) {
      return undefined;
    }

    return {
      include: subtree.key,
      path: subtree.path,
      scope: subtree.scope,
      pushOperations: subtree.pushOperations,
      database: subtree.database
    };
  }

  resolveModuleJsonPath(moduleName: string): string {
    const module = this.getModuleByNormalizedName(moduleName);
    if (module?.jsonPath) {
      return module.jsonPath;
    }

    const normalizedName = moduleName.toLowerCase();
    return `serialization/${normalizedName}/${normalizedName}.json`;
  }
}
