import type { Timestamp } from '../../../rayfin/data/Timestamp';
import { ITimestampService } from '../interfaces/ITimestampService';

import { getRayfinClient } from './RayfinClientService';

/**
 * Implementation of ITimestampService using Rayfin DataApi
 */
export class RayfinTimestampService implements ITimestampService {
  async addTimestamp(): Promise<Timestamp> {
    const client = getRayfinClient();
    const user_id = client.auth.getSession().user?.id;
    if (!user_id) {
      throw new Error('User is not authenticated');
    }
    const now = new Date();

    const result = await client.data.Timestamp.create({
      timestamp: now,
      createdAt: now,
      user_id: user_id, // Populated by DAB from JWT claims
    });

    return result;
  }

  async getTimestamps(): Promise<Timestamp[]> {
    const client = getRayfinClient();

    const result = await client.data.Timestamp.select([
      'id',
      'timestamp',
      'createdAt',
    ])
      .orderBy({ timestamp: 'desc' })
      .execute();

    return result;
  }
}
