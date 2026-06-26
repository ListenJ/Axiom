/**
 * DRE 虚拟文件系统 (VFS)
 *
 * 设计哲学:
 * - 统一挂载点: /kb (知识库), /proj (项目), /cache (缓存), /log (日志)
 * - 最长前缀匹配路由
 * - 写入自动版本快照
 * - 内容哈希 (sha256) 保证确定性
 */

import { createHash } from "crypto";

/** 节点类型 */
export enum NodeType {
  File = "file",
  Directory = "directory",
  Symlink = "symlink",
  KnowledgeNode = "knowledge_node",
  ProjectNode = "project_node",
}

/** Inode 元数据 */
export interface Inode {
  path: string;
  type: NodeType;
  nodeId?: string;        // 关联 knowledge_node.node_id
  contentHash: string;    // sha256
  size: number;
  mtime: number;
  revision: number;
}

/** 存储后端接口 */
export interface IBackend {
  read(path: string): Promise<string | null>;
  write(path: string, data: string, reason: string): Promise<boolean>;
  stat(path: string): Promise<Inode | null>;
  list(dir: string): Promise<Inode[]>;
  delete(path: string): Promise<boolean>;
}

/**
 * 虚拟文件系统
 * 单例模式，统一管理所有挂载点
 */
export class VFS {
  private static _instance: VFS | null = null;
  private mounts = new Map<string, IBackend>();

  static instance(): VFS {
    if (!VFS._instance) {
      VFS._instance = new VFS();
    }
    return VFS._instance;
  }

  /**
   * 挂载后端到指定挂载点
   */
  mount(mountPoint: string, backend: IBackend): void {
    this.mounts.set(mountPoint, backend);
  }

  /**
   * 卸载挂载点
   */
  unmount(mountPoint: string): boolean {
    return this.mounts.delete(mountPoint);
  }

  /**
   * 列出所有挂载点
   */
  listMounts(): string[] {
    return Array.from(this.mounts.keys());
  }

  /**
   * 读取文件
   */
  async read(path: string): Promise<string | null> {
    const { backend, relativePath } = this.resolve(path);
    if (!backend) return null;
    return backend.read(relativePath);
  }

  /**
   * 写入文件 (自动版本快照)
   */
  async write(path: string, data: string, reason: string = "manual"): Promise<boolean> {
    const { backend, relativePath } = this.resolve(path);
    if (!backend) return false;
    return backend.write(relativePath, data, reason);
  }

  /**
   * 获取文件元数据
   */
  async stat(path: string): Promise<Inode | null> {
    const { backend, relativePath } = this.resolve(path);
    if (!backend) return null;
    return backend.stat(relativePath);
  }

  /**
   * 列出目录内容
   */
  async list(dir: string): Promise<Inode[]> {
    const { backend, relativePath } = this.resolve(dir);
    if (!backend) return [];
    return backend.list(relativePath);
  }

  /**
   * 删除文件
   */
  async delete(path: string): Promise<boolean> {
    const { backend, relativePath } = this.resolve(path);
    if (!backend) return false;
    return backend.delete(relativePath);
  }

  /**
   * 计算内容哈希 (确定性)
   */
  static contentHash(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /**
   * 解析路径，找到匹配的后端
   * 使用最长前缀匹配
   */
  private resolve(path: string): { backend: IBackend | null; relativePath: string } {
    let bestBackend: IBackend | null = null;
    let bestLength = 0;

    for (const [mountPoint, backend] of this.mounts) {
      if (path.startsWith(mountPoint) && mountPoint.length > bestLength) {
        bestBackend = backend;
        bestLength = mountPoint.length;
      }
    }

    if (!bestBackend) {
      return { backend: null, relativePath: path };
    }

    const relativePath = path.slice(bestLength) || "/";
    return { backend: bestBackend, relativePath };
  }
}
