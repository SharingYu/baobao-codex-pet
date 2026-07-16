export type ItempackMediaType = 'image/webp' | 'image/png';
export type ItempackCategory = 'food' | 'toy';
export type ItempackBehavior = 'treat' | 'ball' | 'wand' | 'hideout';

export interface ItempackAssetV1 {
  id: string;
  path: string;
  mediaType: ItempackMediaType;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

export interface ItempackItemV1 {
  id: string;
  displayName: string;
  category: ItempackCategory;
  behavior: ItempackBehavior;
  asset: string;
  scale: number;
  unlockLevel?: 1 | 2 | 3 | 4 | 5;
}

export interface ItempackManifestV1 {
  $schema?: string;
  format: 'com.petdesktop.itempack';
  manifestVersion: '1.0';
  id: string;
  displayName: string;
  description: string;
  license: string;
  assets: ItempackAssetV1[];
  previewAsset?: string;
  items: ItempackItemV1[];
}
