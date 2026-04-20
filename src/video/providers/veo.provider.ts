import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult } from './video-provider.interface';

@Injectable()
export class VeoProvider implements VideoProvider {
  readonly name = 'veo';
  readonly displayName = 'Google Veo 3';
  private readonly logger = new Logger(VeoProvider.name);

  constructor(private config: ConfigService) {}

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const apiKey = this.config.get<string>('GOOGLE_API_KEY');
    const duration = options.durationSeconds ?? 8;

    this.logger.log(`[Veo] Submitting job — ${options.quality}, ${duration}s`);

    const ai = new GoogleGenAI({ apiKey });

    let operation = await ai.models.generateVideos({
      model: 'veo-3.0-generate-preview',
      prompt: options.prompt,
      ...(options.imageUrl
        ? { image: { gcsUri: options.imageUrl, mimeType: 'image/jpeg' } }
        : {}),
      config: {
        aspectRatio: '16:9',
        durationSeconds: duration,
        numberOfVideos: 1,
      },
    });

    this.logger.log(`[Veo] Operation started, polling…`);

    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);

      if (!operation.done) {
        operation = await ai.operations.getVideosOperation({ operation });
        this.logger.log(`[Veo] Poll ${i + 1}/${maxAttempts} — done: ${operation.done ?? false}`);
      }

      if (operation.done) {
        const videoUrl = operation.response?.generatedVideos?.[0]?.video?.uri;
        if (!videoUrl) throw new Error('[Veo] Missing video URI in response');
        this.logger.log(`[Veo] Done — ${videoUrl}`);
        return { videoPath: videoUrl, durationSeconds: duration };
      }
    }

    throw new Error('[Veo] Timed out after 10 minutes');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
