import {
  entity,
  role,
  uuid,
  text,
  boolean,
  set,
  date,
  one,
  int,
  decimal,
} from '@microsoft/rayfin-core';

import { Category } from './Category.js';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Todo {
  @uuid() id!: string;
  @text({ min: 1, max: 50 }) Title!: string;
  @text({ optional: true }) description?: string;
  @boolean() isCompleted!: boolean;
  @set('low', 'medium', 'high') priority!: 'low' | 'medium' | 'high';
  @date({ optional: true }) dueDate?: Date;
  @int({ default: 2 }) points!: number;
  @decimal() percentComplete!: number;
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
  @one(() => Category, { optional: true }) category?: Category;
  @text() user_id!: string;
}
