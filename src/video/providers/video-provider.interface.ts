export interface VideoClip {
  duration: number;
  prompt: string;
}

export interface VideoGenerateOptions {
  prompt: string;
  title?: string;       // product title — used for text overlay
  imageUrl?: string;
  quality: '720p' | '1080p';
  durationSeconds?: number;
  clips?: VideoClip[]; // per-clip duration + prompt (used by Kling)
}

export interface VideoGenerateResult {
  videoPath: string;    // local path or GCS/S3 URI
  durationSeconds: number;
}

export interface VideoProvider {
  readonly name: string;         // internal key used in .env / config
  readonly displayName: string;  // shown to user in Telegram
  generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult>;
}
