import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult } from './video-provider.interface';

/**
 * Seedance 2.0 provider (ByteDance)
 * Accessed via VolcEngine (Ark) API
 * Docs: https://www.volcengine.com/docs/82379
 */
@Injectable()
export class SeedanceProvider implements VideoProvider {
  readonly name = 'seedance';
  readonly displayName = 'Seedance 2.0';
  private readonly logger = new Logger(SeedanceProvider.name);
  private readonly baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';

  constructor(private config: ConfigService) {}

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const apiKey = this.config.get('SEEDANCE_API_KEY');
    const duration = options.durationSeconds ?? 5;

    const resolution = options.quality === '1080p' ? '1920x1080' : '1280x720';

    this.logger.log(`[Seedance] Submitting job — ${options.quality}, ${duration}s`);

    const body: any = {
      model: 'seedance-1-pro',
      content: [
        ...(options.imageUrl
          ? [{ type: 'image_url', image_url: { url: options.imageUrl } }]
          : []),
        { type: 'text', text: options.prompt },
      ],
      parameters: {
        resolution,
        duration,
      },
    };

    const submitRes = await fetch(`${this.baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      throw new Error(`[Seedance] Submit failed ${submitRes.status}: ${err}`);
    }

    const task = await submitRes.json();
    const taskId: string = task.id;
    this.logger.log(`[Seedance] Task ID: ${taskId}`);

    const videoPath = await this.pollTask(taskId, apiKey);
    return { videoPath, durationSeconds: duration };
  }

  private async pollTask(taskId: string, apiKey: string): Promise<string> {
    const pollUrl = `${this.baseUrl}/contents/generations/tasks/${taskId}`;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);

      const res = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!res.ok) throw new Error(`[Seedance] Poll failed: ${res.status}`);

      const data = await res.json();
      const status: string = data.status;
      this.logger.log(`[Seedance] Poll ${i + 1}/${maxAttempts} — status: ${status}`);

      if (status === 'succeeded') {
        const videoUrl: string = data.content?.video_url;
        if (!videoUrl) throw new Error('[Seedance] Missing video URL in response');
        return videoUrl;
      }

      if (status === 'failed') {
        throw new Error(`[Seedance] Task failed: ${data.error?.message ?? 'unknown'}`);
      }
    }

    throw new Error('[Seedance] Timed out after 10 minutes');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
