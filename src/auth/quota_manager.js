import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { log } from '../utils/logger.js';
import memoryManager, { MemoryPressure } from '../utils/memoryManager.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';

class QuotaManager {
  /**
   * @param {string} filePath - 额度数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), 'quotas.json')) {
    this.filePath = filePath;
    /** @type {Map<string, {lastUpdated: number, models: Object}>} */
    this.cache = new Map();
    this.CACHE_TTL = QUOTA_CACHE_TTL;
    this.CLEANUP_INTERVAL = QUOTA_CLEANUP_INTERVAL;
    this.cleanupTimer = null;
    this.ensureFileExists();
    this.loadFromFile();
    this.startCleanupTimer();
    this.registerMemoryCleanup();
  }

  buildFileData(quotas) {
    return {
      meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
      quotas
    };
  }

  atomicWriteJson(data) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const base = path.basename(this.filePath);
    const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    const content = JSON.stringify(data, null, 2);
    let fd;
    try {
      fd = fs.openSync(tempPath, 'w');
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch (renameError) {
        if (renameError.code === 'EEXIST' || renameError.code === 'EPERM') {
          try {
            fs.unlinkSync(this.filePath);
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
              throw unlinkError;
            }
          }
          fs.renameSync(tempPath, this.filePath);
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          // Ignore close errors after write failures.
        }
      }
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors for temp files.
      }
      throw error;
    }
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      this.atomicWriteJson(this.buildFileData({}));
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed.quotas || {}).forEach(([key, value]) => {
        this.cache.set(key, value);
      });
    } catch (error) {
      log.error('加载额度文件失败:', error.message);
    }
  }

  saveToFile() {
    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      this.atomicWriteJson(this.buildFileData(quotas));
    } catch (error) {
      log.error('保存额度文件失败:', error.message);
    }
  }

  updateQuota(refreshToken, quotas) {
    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: quotas
    });
    this.saveToFile();
  }

  getQuota(refreshToken) {
    const data = this.cache.get(refreshToken);
    if (!data) return null;
    
    // 检查缓存是否过期
    if (Date.now() - data.lastUpdated > this.CACHE_TTL) {
      return null;
    }
    
    return data;
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    this.cache.forEach((value, key) => {
      if (now - value.lastUpdated > this.CLEANUP_INTERVAL) {
        this.cache.delete(key);
        cleaned++;
      }
    });
    
    if (cleaned > 0) {
      log.info(`清理了 ${cleaned} 个过期的额度记录`);
      this.saveToFile();
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // 注册内存清理回调
  registerMemoryCleanup() {
    memoryManager.registerCleanup((pressure) => {
      // 根据压力级别调整缓存 TTL
      if (pressure === MemoryPressure.CRITICAL) {
        // 紧急时清理所有缓存
        const size = this.cache.size;
        if (size > 0) {
          this.cache.clear();
          log.info(`紧急清理 ${size} 个额度缓存`);
        }
      } else if (pressure === MemoryPressure.HIGH) {
        // 高压力时清理过期缓存
        this.cleanup();
      }
    });
  }

  convertToBeijingTime(utcTimeStr) {
    if (!utcTimeStr) return 'N/A';
    try {
      const utcDate = new Date(utcTimeStr);
      return utcDate.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return 'N/A';
    }
  }
}

const quotaManager = new QuotaManager();
export default quotaManager;
