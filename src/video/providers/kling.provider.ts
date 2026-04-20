import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult } from './video-provider.interface';

/**
 * Kling AI provider
 * Docs: https://docs.klingai.com/api-reference
 */
@Injectable()
export class KlingProvider implements VideoProvider {
  readonly name = 'kling';
  readonly displayName = 'Kling AI';
  private readonly logger = new Logger(KlingProvider.name);
  private readonly baseUrl = 'https://api.klingai.com/v1';

  constructor(private config: ConfigService) {}

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const apiKey = this.config.get('KLING_API_KEY');
    const duration = options.durationSeconds ?? 5; // Kling supports 5 or 10s

    const endpoint = options.imageUrl
      ? `${this.baseUrl}/videos/image2video`
      : `${this.baseUrl}/videos/text2video`;

    this.logger.log(`[Kling] Submitting ${options.imageUrl ? 'image2video' : 'text2video'} — ${options.quality}, ${duration}s`);

    const body: any = {
      model: 'kling-v2-master',
      prompt: options.prompt,
      duration: duration <= 5 ? 5 : 10,
      cfg_scale: 0.5,
      mode: options.quality === '1080p' ? 'pro' : 'std',
      ...(options.imageUrl ? { image: options.imageUrl } : {}),
    };

    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      throw new Error(`[Kling] Submit failed ${submitRes.status}: ${err}`);
    }

    const result = await submitRes.json();
    if (result.code !== 0) {
      throw new Error(`[Kling] API error: ${result.message}`);
    }

    const taskId: string = result.data.task_id;
    this.logger.log(`[Kling] Task ID: ${taskId}`);

    const videoPath = await this.pollTask(taskId, apiKey, options.imageUrl ? 'image2video' : 'text2video');
    return { videoPath, durationSeconds: duration };
  }

  private async pollTask(taskId: string, apiKey: string, type: string): Promise<string> {
    const pollUrl = `${this.baseUrl}/videos/${type}/${taskId}`;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);

      const res = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!res.ok) throw new Error(`[Kling] Poll failed: ${res.status}`);

      const data = await res.json();
      const status: string = data.data?.task_status;
      this.logger.log(`[Kling] Poll ${i + 1}/${maxAttempts} — status: ${status}`);

      if (status === 'succeed') {
        const videoUrl: string = data.data?.task_result?.videos?.[0]?.url;
        if (!videoUrl) throw new Error('[Kling] Missing video URL in response');
        return videoUrl;
      }

      if (status === 'failed') {
        throw new Error(`[Kling] Task failed: ${data.data?.task_status_msg ?? 'unknown'}`);
      }
    }

    throw new Error('[Kling] Timed out after 10 minutes');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
