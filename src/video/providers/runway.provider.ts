import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult } from './video-provider.interface';

/**
 * Runway Gen-3 provider
 * Docs: https://docs.dev.runwayml.com
 */
@Injectable()
export class RunwayProvider implements VideoProvider {
  readonly name = 'runway';
  readonly displayName = 'Runway Gen-3';
  private readonly logger = new Logger(RunwayProvider.name);

  constructor(private config: ConfigService) {}

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const apiKey = this.config.get('RUNWAY_API_KEY');  // mock value in .env during dev
    const duration = options.durationSeconds ?? 8;

    this.logger.log(`[Runway] Submitting job — ${options.quality}, ${duration}s`);

    const body: any = {
      model: 'gen3a_turbo',
      promptText: options.prompt,
      duration,
      ...(options.imageUrl ? { promptImage: options.imageUrl } : {}),
      ratio: options.quality === '1080p' ? '1920:1080' : '1280:720',
    };

    const submitRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      throw new Error(`[Runway] Submit failed ${submitRes.status}: ${err}`);
    }

    const task = await submitRes.json();
    this.logger.log(`[Runway] Task ID: ${task.id}`);

    const videoPath = await this.pollTask(task.id, apiKey);
    return { videoPath, durationSeconds: duration };
  }

  private async pollTask(taskId: string, apiKey: string): Promise<string> {
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);

      const res = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-Runway-Version': '2024-11-06',
        },
      });

      if (!res.ok) throw new Error(`[Runway] Poll failed: ${res.status}`);

      const data = await res.json();
      this.logger.log(`[Runway] Poll ${i + 1}/${maxAttempts} — status: ${data.status}`);

      if (data.status === 'SUCCEEDED') {
        const url: string = data.output?.[0];
        if (!url) throw new Error('[Runway] Missing output URL');
        return url;
      }

      if (data.status === 'FAILED') {
        throw new Error(`[Runway] Task failed: ${data.failure ?? 'unknown'}`);
      }
    }

    throw new Error('[Runway] Timed out after 10 minutes');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
