import { UserSettings } from './types';

// Merge helper: prefer values from `partial`, then `current`, then `defaults`.
export function mergeUserSettings(
  defaults: UserSettings,
  current: UserSettings | null | undefined,
  partial: Partial<UserSettings>
): UserSettings {
  return {
    filter_adult_content:
      partial.filter_adult_content ?? current?.filter_adult_content ?? defaults.filter_adult_content,
    theme: partial.theme ?? current?.theme ?? defaults.theme,
    language: partial.language ?? current?.language ?? defaults.language,
    auto_play: partial.auto_play ?? current?.auto_play ?? defaults.auto_play,
    video_quality: partial.video_quality ?? current?.video_quality ?? defaults.video_quality,
  };
}
