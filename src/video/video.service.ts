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
      };
    } else {
      options = {
        prompt: job.input.prompt,
        imageUrl: job.input.imageUrl,
        quality: job.input.quality,
      };
    }

    const result = await provider.generateVideo(options);
    job.outputPath = result.videoPath;
  }

  private buildPromptFromProduct(product: { title: string; description: string; price: string }): string {
    return [
      `Create a high-quality product showcase video.`,
      `Product: ${product.title}.`,
      product.description ? `Details: ${product.description}.` : '',
      product.price ? `Price: ${product.price}.` : '',
      `Style: cinematic, professional lighting, smooth transitions, suitable for e-commerce advertising.`,
    ].filter(Boolean).join(' ');
  }
}
