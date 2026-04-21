import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TiktokService } from '../tiktok/tiktok.service';
import { QueueService, VideoJob } from '../queue/queue.service';
import { VeoProvider } from './providers/veo.provider';
import { RunwayProvider } from './providers/runway.provider';
import { KlingProvider } from './providers/kling.provider';
import { SeedanceProvider } from './providers/seedance.provider';
import { VideoProvider, VideoGenerateOptions } from './providers/video-provider.interface';
import type { VideoClip } from './providers/video-provider.interface';

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
        durationSeconds: 15,
        clips: this.buildClipsFromProduct(product),
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

  private buildClipsFromProduct(product: { title: string; description: string; price: string }): VideoClip[] {
    return [
      {
        // Clip 1 (5s): product showcase — no person, product is the star
        duration: 5,
        prompt: [
          `Product showcase video of "${product.title}".`,
          `The product appears exactly as in the reference image — preserve all colors, shape, and design.`,
          `The product sits on a clean surface or floats gently in a bright, minimal environment.`,
          `Camera slowly orbits and zooms into key product details.`,
          product.description ? `Highlight these features visually: ${product.description}.` : '',
          `Style: cinematic, sharp focus, soft studio lighting, no person, no hands, no text.`,
          `Some frames may use stylized or slightly artistic rendering to make the product visually striking.`,
        ].filter(Boolean).join(' '),
      },
      {
        // Clip 2 (10s): person using product — no face shown
        duration: 10,
        prompt: [
          `A person is actively using "${product.title}" in a real-life lifestyle setting.`,
          `Show only the person's hands and body — never show their face.`,
          `The product looks identical to the reference image throughout.`,
          `The hands interact naturally with the product: picking it up, using it, and demonstrating its value.`,
          product.description ? `The interaction highlights: ${product.description}.` : '',
          `Camera: close-up on hands and product, occasional wider shots of the lifestyle environment.`,
          `Setting: natural daylight, home or outdoor casual environment.`,
          `Style: authentic and realistic overall, but some frames may have a stylized or cinematic look for visual impact.`,
          `No face, no text overlays, smooth continuous motion.`,
        ].filter(Boolean).join(' '),
      },
    ];
  }

  private buildPromptFromProduct(product: { title: string; description: string; price: string }): string {
    // Fallback prompt used by non-Kling providers (Veo, Runway, Seedance)
    return [
      `A short TikTok-style product advertisement for "${product.title}".`,
      product.description ? `Product details: ${product.description}.` : '',
      `Show a person naturally using the product in a lifestyle setting.`,
      `Style: realistic, cinematic, vibrant colors, suitable for social media.`,
    ].filter(Boolean).join(' ');
  }
}
