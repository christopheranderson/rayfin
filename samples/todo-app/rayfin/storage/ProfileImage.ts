import { role } from '@microsoft/rayfin-core';
import {
  blob,
  ContentTypes,
  mb,
  StorageObject,
} from '@microsoft/rayfin-core/experimental';

/** A user's profile image: images only, max 2 MB. */
@blob({ maxSize: mb(2), allowedContentTypes: [ContentTypes.AnyImage] })
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class ProfileImage extends StorageObject {}
