import * as path from 'path';

import Utils from './utils';

/**
 * Builds application context (services, controllers, etc.)
 * It uses singleton pattern for now.
 */
export default class Context {
  private instances: Map<string, any>;

  constructor() {
    this.instances = new Map<string, any>();
  }

  /**
   * Build context by scanning directories
   * @param paths - directory with classes
   */
  public async build(...paths: string[]) {
    for (const dir of paths) {
      const filenames: string[] = await Utils.listDir(path.resolve(__dirname, dir));
      for (const filename of filenames) {
        if (filename.endsWith('.map')) {
          continue;
        }
        const absFilename = path.resolve(__dirname, dir, filename);
        const clazz = require(absFilename).default;
        this.register(new clazz());
      }
    }

    for (const item of this.instances.values()) {
      item.setContext(this);
    }
  }

  /**
   * Gets controller instances
   */
  public getControllers(): any[] {
    const controllers: any[] = [];
    for (const key of this.instances.keys()) {
      if (key.endsWith('Controller')) {
        controllers.push(this.instances.get(key));
      }
    }
    return controllers;
  }

  /**
   * Registers single class instance
   * @param instance - Class instance
   */
  private register<T>(instance: T): void {
    this.instances.set(instance.constructor.name, instance);
  }

  /**
   * Looks up for instance by name
   * @param name - Instance name
   */
  public lookup<T>(name: string): T {
    return this.instances.get(name);
  }
}