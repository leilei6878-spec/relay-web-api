import type { ResultConfidence } from "./provider/generation-boundary.ts";

export type ImageAssetRecord = {
  assetId: string;
  url: string;
  sha256: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  confidence: ResultConfidence;
};
