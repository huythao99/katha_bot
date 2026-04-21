import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TiktokService } from '../tiktok/tiktok.service';
import { QueueService, VideoJob } from '../queue/queue.service';
import { VeoProvider } from './providers/veo.provider';
import { RunwayProvider } from './providers/runway.provider';
import { KlingProvider } from './providers/kling.provider';
import { SeedanceProvider } from './providers/seedance.provider';
import { VideoProvider, VideoGenerateOptions } from './providers/video-provider.interface';

@Injectable()
export class VideoService implements OnModuleInit {
  private readonly logger = new Logger(VideoService.name);
  private readonly providers: Map<string, VideoProvider>;

  // Per-user provider selection (chatId → provider name)
  private userProvider = new Map<number, string>();

  constructor(
    private config: ConfigService,
    private tiktok: TiktokService,
    private queue: QueueService,
    veo: VeoProvider,
    runway: RunwayProvider,
    kling: KlingProvider,
    seedance: SeedanceProvider,
  ) {
    this.providers = new Map<string, VideoProvider>([
      ['veo', veo],
      ['runway', runway],
      ['kling', kling],
      ['seedance', seedance],
    ]);
  }

  onModuleInit() {
    this.queue.registerHandler((job) => this.processJob(job));
  }

  setCallbacks(
    onReady: (job: VideoJob) => void,
    onFailed: (job: VideoJob) => void,
  ) {
    this.queue.onJobDone(onReady);
    this.queue.onJobFailed(onFailed);
  }

  /** Set per-user provider. Returns false if provider name is unknown. */
  setUserProvider(chatId: number, providerName: string): boolean {
    if (!this.providers.has(providerName)) return false;
    this.userProvider.set(chatId, providerName);
    return true;
  }

  /** Get the provider active for a specific user */
  getUserProvider(chatId: number): string {
    return this.userProvider.get(chatId) ?? this.config.get('VIDEO_PROVIDER', 'veo');
  }

  /** All available providers with display names */
  listProviders(): Array<{ name: string; displayName: string }> {
    return Array.from(this.providers.values()).map((p) => ({
      name: p.name,
      displayName: p.displayName,
    }));
  }

  async queueFromTiktok(url: string, chatId: number, quality: '720p' | '1080p') {
    return this.queue.add({ type: 'tiktok', url, quality }, chatId);
  }

  async queueFromImage(imageUrl: string, prompt: string, chatId: number, quality: '720p' | '1080p') {
    return this.queue.add({ type: 'image', imageUrl, prompt, quality }, chatId);
  }

  getJob(id: string) {
    return this.queue.getJob(id);
  }

  private async processJob(job: VideoJob) {
    const providerName = this.getUserProvider(job.chatId);
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(
        `Unknown provider "${providerName}". Available: ${Array.from(this.providers.keys()).join(', ')}`,
      );
    }

    this.logger.log(`[Job ${job.id}] Provider: ${provider.displayName}`);

    let options: VideoGenerateOptions;

    if (job.input.type === 'tiktok') {
      const product = await this.tiktok.scrapeProduct(job.input.url);
      this.logger.log(`[Job ${job.id}] Scraped: ${product.title}`);
      options = {
        prompt: this.buildPromptFromProduct(product),
        imageUrl: product.images[0],
        quality: job.input.quality,
        durationSeconds: Number(this.config.get('VIDEO_DURATION_SECONDS', 5)),
      };
    } else {
      options = {
        prompt: job.input.prompt,
        imageUrl: job.input.imageUrl,
        quality: job.input.quality,
        durationSeconds: Number(this.config.get('VIDEO_DURATION_SECONDS', 5)),
      };
    }

    const result = await provider.generateVideo(options);
    job.outputPath = result.videoPath;
  }

  private buildPromptFromProduct(product: { title: string; description: string; price: string }): string {
    return [
      // Scene: person using the product
      `A short, realistic TikTok-style product advertisement.`,
      `A real person is naturally using "${product.title}" in an everyday lifestyle setting.`,
      `The product looks exactly as shown in the reference image — same colors, shape, and design must be preserved.`,

      // Action & interaction
      `The person confidently picks up, holds, and actively uses the product.`,
      `Their facial expression is happy and satisfied, showing genuine enjoyment.`,
      `The product is clearly visible and stays in frame throughout.`,

      // Description context
      product.description ? `The video highlights these product features naturally: ${product.description}.` : '',

      // Camera
      `Camera: handheld feel with slight motion, close-up on product in use, then pull back to show the person's full reaction.`,

      // Environment & lighting
      `Setting: bright, natural daylight environment — home, outdoors, or a casual lifestyle space.`,
      `Lighting: natural and flattering, not studio-like. Realistic shadows and textures.`,

      // Style
      `Style: ultra-realistic, authentic, cinematic quality. Smooth natural motion. No floating effects, no text overlays.`,
      `Feels like a real person's genuine product review, suitable for TikTok and Instagram Reels.`,
    ].filter(Boolean).join(' ');
  }
}
