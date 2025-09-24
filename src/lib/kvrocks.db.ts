/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import { Redis } from '@upstash/redis';

import { AdminConfig } from './admin.types';
import { mergeUserSettings } from './settings';
import {
  EpisodeSkipConfig,
  Favorite,
  IStorage,
  PlayRecord,
  User,
  UserSettings,
} from './types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

// 数据类型转换辅助函数
function ensureStringArray(value: any[]): string[] {
  return value.map((item) => String(item));
}

// 添加 Kvrocks 操作重试包装器
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err: any) {
      const isLastAttempt = i === maxRetries - 1;
      const isConnectionError =
        err.message?.includes('Connection') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('ENOTFOUND') ||
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE';

      if (isConnectionError && !isLastAttempt) {
        console.log(
          `Kvrocks operation failed, retrying... (${i + 1}/${maxRetries})`
        );
        console.error('Error:', err.message);

        // 等待一段时间后重试
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }

      throw err;
    }
  }

  throw new Error('Max retries exceeded');
}

/* ---------- 存储实现 ---------- */
export class KvrocksStorage implements IStorage {
  private client: Redis;

  constructor() {
    this.client = getUpstashKvrocks();
  }

  /* ---------- 播放记录 ---------- */
  private prKey(user: string, key: string) {
    return `u:${user}:pr:${key}`;
  }
  async getPlayRecord(userName: string, key: string): Promise<PlayRecord | null> {
    const val = await withRetry(() => this.client.get(this.prKey(userName, key)));
    return val ? (val as PlayRecord) : null;
  }
  async setPlayRecord(userName: string, key: string, record: PlayRecord): Promise<void> {
    await withRetry(() => this.client.set(this.prKey(userName, key), record));
  }
  async getAllPlayRecords(userName: string): Promise<Record<string, PlayRecord>> {
    const pattern = `u:${userName}:pr:*`;
    const keys = await withRetry(() => this.client.keys(pattern));
    const result: Record<string, PlayRecord> = {};
    if (keys.length === 0) return result;

    const values = await withRetry(() => this.client.mget(...keys));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = values[i];
      if (v) {
        const recordKey = k.replace(`u:${userName}:pr:`, '');
        result[recordKey] = v as PlayRecord;
      }
    }
    return result;
  }
  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await withRetry(() => this.client.del(this.prKey(userName, key)));
  }

  /* ---------- 收藏 ---------- */
  private favKey(user: string, key: string) {
    return `u:${user}:fav:${key}`;
  }
  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    const val = await withRetry(() => this.client.get(this.favKey(userName, key)));
    return val ? (val as Favorite) : null;
  }
  async setFavorite(userName: string, key: string, favorite: Favorite): Promise<void> {
    await withRetry(() => this.client.set(this.favKey(userName, key), favorite));
  }
  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    const pattern = `u:${userName}:fav:*`;
    const keys = await withRetry(() => this.client.keys(pattern));
    const result: Record<string, Favorite> = {};
    if (keys.length === 0) return result;

    const values = await withRetry(() => this.client.mget(...keys));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = values[i];
      if (v) {
        const favKey = k.replace(`u:${userName}:fav:`, '');
        result[favKey] = v as Favorite;
      }
    }
    return result;
  }
  async deleteFavorite(userName: string, key: string): Promise<void> {
    await withRetry(() => this.client.del(this.favKey(userName, key)));
  }

  /* ---------- 搜索历史 ---------- */
  private searchHistoryKey(user: string) {
    return `u:${user}:search_history`;
  }
  async getSearchHistory(userName: string): Promise<string[]> {
    const items = await withRetry(() => this.client.lrange(this.searchHistoryKey(userName), 0, -1));
    return ensureStringArray(items);
  }
  async addSearchHistory(userName: string, query: string): Promise<void> {
    const key = this.searchHistoryKey(userName);
    await withRetry(async () => {
      await this.client.lrem(key, 0, query);
      await this.client.lpush(key, query);
      await this.client.ltrim(key, 0, SEARCH_HISTORY_LIMIT - 1);
    });
  }
  async deleteSearchHistory(userName: string, query?: string): Promise<void> {
    const key = this.searchHistoryKey(userName);
    if (query) {
      await withRetry(() => this.client.lrem(key, 0, query));
    } else {
      await withRetry(() => this.client.del(key));
    }
  }

  /* ---------- 片头片尾跳过配置 ---------- */
  private skipConfigKey(userName: string, key: string) {
    return `u:${userName}:skip_config:${key}`;
  }
  async getSkipConfig(userName: string, key: string): Promise<EpisodeSkipConfig | null> {
    const val = await withRetry(() => this.client.get(this.skipConfigKey(userName, key)));
    return val ? (val as EpisodeSkipConfig) : null;
  }
  async setSkipConfig(userName: string, key: string, config: EpisodeSkipConfig): Promise<void> {
    await withRetry(() => this.client.set(this.skipConfigKey(userName, key), config));
  }
  async deleteSkipConfig(userName: string, key: string): Promise<void> {
    await withRetry(() => this.client.del(this.skipConfigKey(userName, key)));
  }
  async getAllSkipConfigs(userName: string): Promise<Record<string, EpisodeSkipConfig>> {
    const pattern = `u:${userName}:skip_config:*`;
    const keys = await withRetry(() => this.client.keys(pattern));
    const result: Record<string, EpisodeSkipConfig> = {};
    if (keys.length === 0) return result;

    const values = await withRetry(() => this.client.mget(...keys));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = values[i];
      if (v) {
        const configKey = k.replace(`u:${userName}:skip_config:`, '');
        result[configKey] = v as EpisodeSkipConfig;
      }
    }
    return result;
  }

  /* ---------- 用户相关 ---------- */
  private userKey(userName: string) {
    return `user:${userName}`;
  }
  private userListKey() {
    return 'user_list';
  }
  async getUser(userName: string): Promise<any> {
    const val = await withRetry(() => this.client.get(this.userKey(userName)));
    return val ? val : null;
  }
  async setUser(userName: string, userData: any): Promise<void> {
    await withRetry(async () => {
      await this.client.set(this.userKey(userName), userData);
      await this.client.sadd(this.userListKey(), userName);
    });
  }
  async getAllUsers(): Promise<User[]> {
    const usernames = await withRetry(() => this.client.smembers(this.userListKey()));
    const ownerUsername = process.env.USERNAME || 'admin';
    const users = await Promise.all(
      usernames.map(async (username) => {
        let created_at = '';
        try {
          const userData = await this.getUser(username);
          if (userData?.created_at) {
            created_at = new Date(userData.created_at).toISOString();
          }
        } catch {
          /* ignore */
        }
        return {
          username,
          role: username === ownerUsername ? 'owner' : 'user',
          created_at,
        };
      })
    );
    return users;
  }
  async registerUser(userName: string, password: string): Promise<void> {
    const userData = { username: userName, password, created_at: Date.now() };
    await this.setUser(userName, userData);
  }
  async verifyUser(userName: string, password: string): Promise<boolean> {
    const userData = await this.getUser(userName);
    return userData && userData.password === password;
  }
  async checkUserExist(userName: string): Promise<boolean> {
    const userData = await this.getUser(userName);
    return userData !== null;
  }
  async changePassword(userName: string, newPassword: string): Promise<void> {
    const userData = await this.getUser(userName);
    if (userData) {
      userData.password = newPassword;
      await this.setUser(userName, userData);
    }
  }
  async deleteUser(userName: string): Promise<void> {
    await withRetry(async () => {
      await this.client.del(this.userKey(userName));
      await this.client.srem(this.userListKey(), userName);
      const patterns = [
        `u:${userName}:pr:*`,
        `u:${userName}:fav:*`,
        `u:${userName}:search_history`,
        `u:${userName}:skip_config:*`,
      ];
      for (const pattern of patterns) {
        const keys = await this.client.keys(pattern);
        if (keys.length) await this.client.del(...keys);
      }
    });
  }

  /* ---------- 管理员配置 ---------- */
  private adminConfigKey() {
    return 'admin_config';
  }
  async getAdminConfig(): Promise<AdminConfig | null> {
    const val = await withRetry(() => this.client.get(this.adminConfigKey()));
    return val ? (val as AdminConfig) : null;
  }
  async setAdminConfig(config: AdminConfig): Promise<void> {
    await withRetry(() => this.client.set(this.adminConfigKey(), config));
  }

  /* ---------- 用户设置 ---------- */
  private userSettingsKey(userName: string) {
    return `u:${userName}:settings`;
  }
  async getUserSettings(userName: string): Promise<UserSettings | null> {
    const val = await withRetry(() => this.client.get(this.userSettingsKey(userName)));
    return val ? (val as UserSettings) : null;
  }
  async setUserSettings(userName: string, settings: UserSettings): Promise<void> {
    await withRetry(() => this.client.set(this.userSettingsKey(userName), settings));
  }
  async updateUserSettings(userName: string, settings: Partial<UserSettings>): Promise<void> {
    const current = await this.getUserSettings(userName);
    const defaultSettings: UserSettings = {
      filter_adult_content: true,
      theme: 'auto',
      language: 'zh-CN',
      auto_play: false,
      video_quality: 'auto',
    };

    const updated = mergeUserSettings(defaultSettings, current ?? undefined, settings);
    await this.setUserSettings(userName, updated);
  }
}

/* ---------- 单例 Upstash Redis 客户端 ---------- */
function getUpstashKvrocks(): Redis {
  const globalKey = Symbol.for('__KATELYATV_KVROCKS_UPSTASH__');
  let client: Redis | undefined = (global as any)[globalKey];

  if (!client) {
    const url = process.env.KVROCKS_URL;
    const token = process.env.KVROCKS_TOKEN; // Upstash 需要 token
    if (!url || !token) {
      throw new Error('KVROCKS_URL 和 KVROCKS_TOKEN 必须配置');
    }
    client = new Redis({ url, token });
    (global as any)[globalKey] = client;
  }
  return client;
}