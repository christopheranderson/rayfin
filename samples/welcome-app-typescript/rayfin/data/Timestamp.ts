import { entity, date, role, uuid } from '@microsoft/rayfin-core';

@entity()
@role('anonymous', '*')
export class Timestamp {
  @uuid() id!: string;
  @date() timestamp!: Date;
}
