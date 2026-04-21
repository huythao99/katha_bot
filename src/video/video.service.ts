import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TiktokService } from '../tiktok/tiktok.service';
import { QueueService, VideoJob } from '../queue/queue.service';
import { KlingProvider } from './providers/kling.provider';
import { VideoGenerateOptions } from './providers/video-provider.interface';
import type { VideoClip } from './providers/video-provider.interface';

@Injectable()
export class VideoService implements OnModuleInit {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private config: ConfigService,
    private tiktok: TiktokService,
    private queue: QueueService,
    private kling: KlingProvider,
  ) {}

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
    this.logger.log(`[Job ${job.id}] Provider: Kling AI`);

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

    const result = await this.kling.generateVideo(options);
    job.outputPath = result.videoPath;
  }

  private buildClipsFromProduct(product: { title: string; description: string; price: string }): VideoClip[] {
    return [
      {
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
    return [
      `A short TikTok-style product advertisement for "${product.title}".`,
      product.description ? `Product details: ${product.description}.` : '',
      `Show a person naturally using the product in a lifestyle setting.`,
      `Style: realistic, cinematic, vibrant colors, suitable for social media.`,
    ].filter(Boolean).join(' ');
  }
}
