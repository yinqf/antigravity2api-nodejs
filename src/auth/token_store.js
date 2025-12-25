import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from '../utils/paths.js';
import { FILE_CACHE_TTL } from '../constants/index.js';
import { log } from '../utils/logger.js';

/**
 * 负责 token 文件的读写与简单缓存
 * 不关心业务字段，只处理 JSON 数组的加载和保存
 */
class TokenStore {
  constructor(filePath = path.join(getDataDir(), 'accounts.json')) {
    this.filePath = filePath;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = FILE_CACHE_TTL;
    this._lastReadOk = true;
  }

  async _ensureFileExists() {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      // 目录已存在等情况忽略
    }

    try {
      await fs.access(this.filePath);
    } catch (e) {
      // 文件不存在时创建空数组
      await fs.writeFile(this.filePath, '[]', 'utf8');
      log.info('✓ 已创建账号配置文件');
    }
  }

  async _atomicWrite(content) {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    let handle;

    try {
      handle = await fs.open(tempPath, 'w');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      try {
        await fs.rename(tempPath, this.filePath);
      } catch (renameError) {
        if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
          try {
            await fs.unlink(this.filePath);
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
              throw unlinkError;
            }
          }
          await fs.rename(tempPath, this.filePath);
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          // Ignore close errors after write failures.
        }
      }
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors for temp files.
      }
      throw error;
    }
  }

  _isCacheValid() {
    if (!this._cache) return false;
    const now = Date.now();
    return (now - this._cacheTime) < this._cacheTTL;
  }

  /**
   * 读取全部 token（包含禁用的），带简单内存缓存
   * @returns {Promise<Array<object>>}
   */
  async readAll() {
    if (this._isCacheValid()) {
      return this._cache;
    }

    await this._ensureFileExists();
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data || '[]');
      if (!Array.isArray(parsed)) {
        log.warn('账号配置文件格式异常，保留缓存并跳过本次读取');
        this._lastReadOk = false;
        if (this._cache) {
          this._cacheTime = Date.now();
          return this._cache;
        }
        return [];
      } else {
        this._cache = parsed;
        this._lastReadOk = true;
      }
    } catch (error) {
      log.error('读取账号配置文件失败:', error.message);
      this._lastReadOk = false;
      if (this._cache) {
        this._cacheTime = Date.now();
        return this._cache;
      }
      return [];
    }
    this._cacheTime = Date.now();
    return this._cache;
  }

  /**
   * 覆盖写入全部 token，更新缓存
   * @param {Array<object>} tokens
   */
  async writeAll(tokens) {
    await this._ensureFileExists();
    const normalized = Array.isArray(tokens) ? tokens : [];
    try {
      await this._atomicWrite(JSON.stringify(normalized, null, 2));
      this._cache = normalized;
      this._cacheTime = Date.now();
      this._lastReadOk = true;
    } catch (error) {
      log.error('保存账号配置文件失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据内存中的启用 token 列表，将对应记录合并回文件
   * - 仅按 refresh_token 匹配并更新已有记录
   * - 未出现在 activeTokens 中的记录（例如已禁用账号）保持不变
   * @param {Array<object>} activeTokens - 内存中的启用 token 列表（可能包含 sessionId）
   * @param {object|null} tokenToUpdate - 如果只需要单个更新，可传入该 token 以减少遍历
   */
  async mergeActiveTokens(activeTokens, tokenToUpdate = null) {
    const allTokens = [...await this.readAll()];
    const hasActiveTokens = Array.isArray(activeTokens) && activeTokens.length > 0;

    const applyUpdate = (targetToken) => {
      if (!targetToken) return;
      const index = allTokens.findIndex(t => t.refresh_token === targetToken.refresh_token);
      if (index !== -1) {
        const { sessionId, ...plain } = targetToken;
        allTokens[index] = { ...allTokens[index], ...plain };
      }
    };

    if (!this._lastReadOk && allTokens.length === 0) {
      log.warn('账号配置文件读取失败，跳过写入以避免覆盖');
      return;
    }

    if (allTokens.length === 0 && hasActiveTokens) {
      const rebuilt = activeTokens.map(({ sessionId, ...plain }) => ({ ...plain }));
      await this.writeAll(rebuilt);
      return;
    }

    if (tokenToUpdate) {
      applyUpdate(tokenToUpdate);
    } else if (Array.isArray(activeTokens) && activeTokens.length > 0) {
      for (const memToken of activeTokens) {
        applyUpdate(memToken);
      }
    }

    await this.writeAll(allTokens);
  }
}

export default TokenStore;
