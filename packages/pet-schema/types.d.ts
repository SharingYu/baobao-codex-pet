export type PetpackMediaType = 'image/webp' | 'image/png';

export interface PetpackAssetV1 {
  id: string;
  path: string;
  mediaType: PetpackMediaType;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
}

export interface SpriteAnimationV1 {
  row: number;
  frames: number[];
  frameDurationsMs: number[];
  loop: boolean;
}

export interface LookDirectionV1 {
  degrees: number;
  row: number;
  column: number;
}

export interface SpriteAtlasRendererV1 {
  type: 'sprite-atlas';
  atlasAsset: string;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  anchor: { x: number; y: number };
  defaultScale: number;
  animations: Record<string, SpriteAnimationV1>;
  lookDirections?: LookDirectionV1[];
}

export interface PetTouchZoneV1 {
  id: string;
  label?: string;
  event: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetpackManifestV1 {
  $schema?: string;
  format: 'com.baofeifei.petpack';
  manifestVersion: '1.0';
  id: string;
  displayName: string;
  description: string;
  license: string;
  source: {
    kind: 'native' | 'codex-v2';
    spriteVersionNumber?: number;
  };
  assets: PetpackAssetV1[];
  previewAsset?: string;
  renderer: SpriteAtlasRendererV1;
  interactions: {
    eventMap: Record<string, string>;
    touchZones?: PetTouchZoneV1[];
  };
}
