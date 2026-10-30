import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import type { Youtube } from '../google/youtube.ts';
import { insertCreator } from '../repo/creators.ts';
import { logActivity } from '../repo/state.ts';
import { logger } from '../log.ts';

const log = logger('discover');
const CHANNELS_PER_NICHE = 25;

export interface DiscoveryResult {
  searched: number;
  added: number;
}

/**
 * Finds YouTube channels for each configured niche and stores the ones inside the subscriber
 * range. Each niche costs ~101 quota units (of 10,000/day free).
 */
export async function discoverYoutubeCreators(db: Db, config: Config, youtube: Youtube): Promise<DiscoveryResult> {
  let added = 0;
  for (const niche of config.NICHES) {
    try {
      const ids = await youtube.searchChannels(niche, CHANNELS_PER_NICHE);
      const channels = await youtube.channels(ids);
      for (const ch of channels) {
        if (ch.subscribers !== null && (ch.subscribers < config.MIN_SUBSCRIBERS || ch.subscribers > config.MAX_SUBSCRIBERS)) {
          continue;
        }
        const id = insertCreator(db, {
          platform: 'youtube',
          handle: ch.handle,
          channel_id: ch.id,
          name: ch.title,
          url: `https://www.youtube.com/channel/${ch.id}`,
          followers: ch.subscribers,
          bio: ch.description.slice(0, 1000),
          source: `youtube search: ${niche}`,
        });
        if (id !== null) added++;
      }
    } catch (error) {
      log.error(`niche "${niche}" failed`, error);
      logActivity(db, 'error', `Discovery for "${niche}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logActivity(db, 'discovery', `Searched ${config.NICHES.length} niches, added ${added} new YouTube creators`);
  return { searched: config.NICHES.length, added };
}
