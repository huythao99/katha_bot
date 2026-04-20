import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult } from './video-provider.interface';

@Injectable()
export class VeoProvider implements VideoProvider {
  readonly name = 'veo';
  readonly displayName = 'Google Veo';
  private readonly logger = new Logger(VeoProvider.name);

  constructor(private config: ConfigService) {}

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const project = this.config.get('GOOGLE_CLOUD_PROJECT');
    const location = this.config.get('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const apiKey = this.config.get('GOOGLE_CLOUD_API_KEY');  // mock value in .env during dev
    const duration = options.durationSeconds ?? 8;

    const resolution = options.quality === '1080p' ? '1920x1080' : '1280x720';

    this.logger.log(`[Veo] Submitting job — ${options.quality}, ${duration}s`);

    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/veo-2:generateVideo`;

    const body: any = {
      instances: [{
        prompt: options.prompt,
        ...(options.imageUrl ? { image: { gcsUri: options.imageUrl } } : {}),
      }],
      parameters: {
        duration_seconds: duration,
        resolution,
      },
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
      throw new Error(`[Veo] Submit failed ${submitRes.status}: ${err}`);
    }

    const operation = await submitRes.json();
    this.logger.log(`[Veo] Operation: ${operation.name}`);

    const videoPath = await this.pollOperation(operation.name, apiKey, location);
    return { videoPath, durationSeconds: duration };
  }

  private async pollOperation(
    operationName: string,
    apiKey: string,
    location: string,
  ): Promise<string> {
    const pollUrl = `https://${location}-aiplatform.googleapis.com/v1/${operationName}`;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);

      const res = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!res.ok) throw new Error(`[Veo] Poll failed: ${res.status}`);

      const data = await res.json();
      this.logger.log(`[Veo] Poll ${i + 1}/${maxAttempts} — done: ${data.done ?? false}`);

      if (data.done) {
        if (data.error) throw new Error(`[Veo] ${JSON.stringify(data.error)}`);
        const uri: string = data.response?.predictions?.[0]?.video?.gcsUri;
        if (!uri) throw new Error('[Veo] Missing video URI in response');
        return uri;
      }
    }

    throw new Error('[Veo] Timed out after 10 minutes');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
