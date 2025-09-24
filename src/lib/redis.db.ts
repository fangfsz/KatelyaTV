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
function ensureString(value: any): string {
  return String(value);
}
function ensureStringArray(value: any[]): string[] {
  return value.map((item) => String(item));
}

// 添加 Redis 操作重试包装器
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
          `Redis operation failed, retrying... (${i + 1}/${maxRetries})`
        );
        console.error('Error:', err.message);
        // 指数退避
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

/* ---------- 存储实现 ---------- */
export class RedisStorage implements IStorage {
  private client: Redis;

  constructor() {
    this.client = getUpstashRedis();
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
    const keys: string[] = await withRetry(() => this.client.keys(pattern));
    if (keys.length === 0) return {};
    const values = await withRetry(() => this.client.mget(...keys));
    const result: Record<string, PlayRecord> = {};
    keys.forEach((fullKey, idx) => {
      const raw = values[idx];
      if (raw) {
        const keyPart = ensureString(fullKey.replace(`u:${userName}:pr:`, ''));
        result[keyPart] = raw as PlayRecord;
      }
    });
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
    if (keys.length === 0) return {};
    const values = await withRetry(() => this.client.mget(...keys));
    const result: Record<string, Favorite> = {};
    keys.forEach((fullKey, idx) => {
      const raw = values[idx];
      if (raw) {
        const keyPart = ensureString(fullKey.replace(`u:${userName}:fav:`, ''));
        result[keyPart] = raw as Favorite;
      }
    });
    return result;
  }
  async deleteFavorite(userName: string, key: string): Promise<void> {
    await withRetry(() => this.client.del(this.favKey(userName, key)));
  }

  /* ---------- 用户注册 / 登录 ---------- */
  private userPwdKey(user: string) {
    return `u:${user}:pwd`;
  }
  async registerUser(userName: string, password: string): Promise<void> {
    await withRetry(() => this.client.set(this.userPwdKey(userName), password));
  }
  async verifyUser(userName: string, password: string): Promise<boolean> {
    const stored = await withRetry(() => this.client.get(this.userPwdKey(userName)));
    return stored ? ensureString(stored) === password : false;
  }
  async checkUserExist(userName: string): Promise<boolean> {
    const exists = await withRetry(() => this.client.exists(this.userPwdKey(userName)));
    return exists === 1;
  }
  async changePassword(userName: string, newPassword: string): Promise<void> {
    await withRetry(() => this.client.set(this.userPwdKey(userName), newPassword));
  }
  async deleteUser(userName: string): Promise<void> {
    await withRetry(() => this.client.del(this.userPwdKey(userName)));
    await withRetry(() => this.client.del(this.shKey(userName)));

    const playRecordPattern = `u:${userName}:pr:*`;
    const playRecordKeys = await withRetry(() => this.client.keys(playRecordPattern));
    if (playRecordKeys.length) await withRetry(() => this.client.del(...playRecordKeys));

    const favoritePattern = `u:${userName}:fav:*`;
    const favoriteKeys = await withRetry(() => this.client.keys(favoritePattern));
    if (favoriteKeys.length) await withRetry(() => this.client.del(...favoriteKeys));

    await withRetry(() => this.client.del(this.userSettingsKey(userName)));
  }

  /* ---------- 用户设置 ---------- */
  private userSettingsKey(user: string) {
    return `u:${user}:settings`;
  }
  async getUserSettings(userName: string): Promise<UserSettings | null> {
    const data = await withRetry(() => this.client.get(this.userSettingsKey(userName)));
    if (data) return data as UserSettings;

    const defaultSettings: UserSettings = {
      filter_adult_content: true,
      theme: 'auto',
      language: 'zh-CN',
      auto_play: true,
      video_quality: 'auto',
    };
    return defaultSettings;
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
      auto_play: true,
      video_quality: 'auto',
    };

    const updated = mergeUserSettings(defaultSettings, current ?? undefined, settings);
    await this.setUserSettings(userName, updated);
  }

  /* ---------- 搜索历史 ---------- */
  private shKey(user: string) {
    return `u:${user}:sh`;
  }
  async getSearchHistory(userName: string): Promise<string[]> {
    const list = await withRetry(() => this.client.lrange(this.shKey(userName), 0, -1));
    return ensureStringArray(list);
  }
  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    const key = this.shKey(userName);
    await withRetry(() => this.client.lrem(key, 0, keyword));
    await withRetry(() => this.client.lpush(key, keyword));
    await withRetry(() => this.client.ltrim(key, 0, SEARCH_HISTORY_LIMIT - 1));
  }
  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    const key = this.shKey(userName);
    if (keyword) {
      await withRetry(() => this.client.lrem(key, 0, keyword));
    } else {
      await withRetry(() => this.client.del(key));
    }
  }

  /* ---------- 获取全部用户 ---------- */
  async getAllUsers(): Promise<User[]> {
    const keys = await withRetry(() => this.client.keys('u:*:pwd'));
    const ownerUsername = process.env.USERNAME || 'admin';

    const usernames = keys
      .map((k) => {
        const match = k.match(/^u:(.+?):pwd$/);
        return match ? ensureString(match[1]) : undefined;
      })
      .filter((u): u is string => typeof u === 'string');

    const users = await Promise.all(
      usernames.map(async (username) => {
        const createdAtKey = `u:${username}:created_at`;
        let created_at = '';
        try {
          const timestamp = await withRetry(() => this.client.get(createdAtKey));
          if (timestamp) created_at = new Date(parseInt(timestamp as string)).toISOString();
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

  /* ---------- 管理员配置 ---------- */
  private adminConfigKey() {
    return 'admin:config';
  }
  async getAdminConfig(): Promise<AdminConfig | null> {
    const val = await withRetry(() => this.client.get(this.adminConfigKey()));
    return val ? (val as AdminConfig) : null;
  }
  async setAdminConfig(config: AdminConfig): Promise<void> {
    await withRetry(() => this.client.set(this.adminConfigKey(), config));
  }

  /* ---------- 跳过配置 ---------- */
  private skipConfigKey(userName: string, key: string) {
    return `katelyatv:skip_config:${userName}:${key}`;
  }
  private skipConfigsKey(userName: string) {
    return `katelyatv:skip_configs:${userName}`;
  }
  async getSkipConfig(userName: string, key: string): Promise<EpisodeSkipConfig | null> {
    const data = await withRetry(() => this.client.get(this.skipConfigKey(userName, key)));
    return data ? (data as EpisodeSkipConfig) : null;
  }
  async setSkipConfig(userName: string, key: string, config: EpisodeSkipConfig): Promise<void> {
    await withRetry(async () => {
      await this.client.set(this.skipConfigKey(userName, key), config);
      await this.client.sadd(this.skipConfigsKey(userName), key);
    });
  }
  async getAllSkipConfigs(userName: string): Promise<{ [key: string]: EpisodeSkipConfig }> {
    const keys = await withRetry(() => this.client.smembers(this.skipConfigsKey(userName)));
    const configs: { [key: string]: EpisodeSkipConfig } = {};
    for (const k of keys) {
      const data = await withRetry(() => this.client.get(this.skipConfigKey(userName, k)));
      if (data) configs[k] = data as EpisodeSkipConfig;
    }
    return configs;
  }
  async deleteSkipConfig(userName: string, key: string): Promise<void> {
    await withRetry(async () => {
      await this.client.del(this.skipConfigKey(userName, key));
      await this.client.srem(this.skipConfigsKey(userName), key);
    });
  }
}

/* ---------- 单例 Upstash Redis 客户端 ---------- */
function getUpstashRedis(): Redis {
  const globalKey = Symbol.for('__KATELYATV_UPSTASH_REDIS__');
  let client: Redis | undefined = (global as any)[globalKey];

  if (!client) {
    const url = process.env.REDIS_URL;
    const token = process.env.REDIS_TOKEN;
    if (!url || !token) {
      throw new Error('REDIS_URL 和 REDIS_TOKEN 必须配置');
    }
    client = new Redis({ url, token });
    (global as any)[globalKey] = client;
  }
  return client;
}