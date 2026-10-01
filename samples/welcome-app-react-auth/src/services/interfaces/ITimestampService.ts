import type { Timestamp } from '../../../rayfin/data/Timestamp';

export interface ITimestampService {
  addTimestamp(): Promise<Timestamp>;
  getTimestamps(): Promise<Timestamp[]>;
}
