import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { VideoProvider, VideoGenerateOptions, VideoGenerateResult, VideoClip } from './video-provider.interface';

const KLING_MAX_CLIP = 10; // Kling max per clip

@Injectable()
export class KlingProvider implements VideoProvider {
  readonly name = 'kling';
  readonly displayName = 'Kling AI';
  private readonly logger = new Logger(KlingProvider.name);
  private readonly baseUrl = 'https://api-singapore.klingai.com/v1';

  constructor(private config: ConfigService) {}

  private generateJwt(): string {
    const accessKey = this.config.get('KLING_ACCESS_KEY');
    const secretKey = this.config.get('KLING_SECRET_KEY');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: accessKey,
      exp: now + 1800,
      nbf: now - 5,
    })).toString('base64url');
    const signature = createHmac('sha256', secretKey)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  async generateVideo(options: VideoGenerateOptions): Promise<VideoGenerateResult> {
    const clips: VideoClip[] = options.clips?.length
      ? options.clips
      : this.buildDefaultClips(options);

    const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);
    this.logger.log(`[Kling] ${totalDuration}s total → ${clips.length} clip(s): [${clips.map(c => `${c.duration}s`).join(', ')}]`);

    if (clips.length === 1) {
      const videoUrl = await this.generateClip({ ...options, prompt: clips[0].prompt }, clips[0].duration, 0);
      return { videoPath: videoUrl, durationSeconds: clips[0].duration };
    }

    const clipUrls: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      this.logger.log(`[Kling] Clip ${i + 1}/${clips.length} (${clips[i].duration}s)...`);
      const url = await this.generateClip({ ...options, prompt: clips[i].prompt }, clips[i].duration, i);
      clipUrls.push(url);
    }

    this.logger.log(`[Kling] Concatenating ${clips.length} clips → ${totalDuration}s`);
    const outputPath = await this.concatenateClips(clipUrls);
    return { videoPath: outputPath, durationSeconds: totalDuration };
  }

  private buildDefaultClips(options: VideoGenerateOptions): VideoClip[] {
    const totalDuration = options.durationSeconds ?? 10;
    const clipsNeeded = Math.ceil(totalDuration / KLING_MAX_CLIP);
    return Array.from({ length: clipsNeeded }, (_, i) => ({
      duration: Math.min(totalDuration - i * KLING_MAX_CLIP, KLING_MAX_CLIP),
      prompt: options.prompt,
    }));
  }

  private async generateClip(
    options: VideoGenerateOptions,
    duration: number,
    clipIndex: number,
  ): Promise<string> {
    const type = options.imageUrl ? 'image2video' : 'text2video';
    const endpoint = `${this.baseUrl}/videos/${type}`;

    const body: any = {
      model: 'kling-v2-master',
      prompt: options.prompt,
      duration,
      cfg_scale: 0.5,
      mode: options.quality === '1080p' ? 'pro' : 'std',
      ...(options.imageUrl ? { image: options.imageUrl } : {}),
    };

    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.generateJwt()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      throw new Error(`[Kling] Clip ${clipIndex + 1} submit failed ${submitRes.status}: ${err}`);
    }

    const result = await submitRes.json();
    if (result.code !== 0) throw new Error(`[Kling] API error: ${result.message}`);

    const taskId: string = result.data.task_id;
    this.logger.log(`[Kling] Clip ${clipIndex + 1} task ID: ${taskId}`);

    return this.pollTask(taskId, type, clipIndex + 1);
  }

  private async pollTask(taskId: string, type: string, clipNum: number): Promise<string> {
    const pollUrl = `${this.baseUrl}/videos/${type}/${taskId}`;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(10_000);
      const res = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${this.generateJwt()}` },
      });
      if (!res.ok) throw new Error(`[Kling] Poll failed: ${res.status}`);

      const data = await res.json();
      const status: string = data.data?.task_status;
      this.logger.log(`[Kling] Clip ${clipNum} poll ${i + 1}/${maxAttempts} — ${status}`);

      if (status === 'succeed') {
        const videoUrl: string = data.data?.task_result?.videos?.[0]?.url;
        if (!videoUrl) throw new Error('[Kling] Missing video URL');
        return videoUrl;
      }
      if (status === 'failed') {
        throw new Error(`[Kling] Clip ${clipNum} failed: ${data.data?.task_status_msg ?? 'unknown'}`);
      }
    }
    throw new Error(`[Kling] Clip ${clipNum} timed out`);
  }

  // ------------------------------------------------------------------
  // Download clips locally then concatenate with ffmpeg
  // ------------------------------------------------------------------
  private async concatenateClips(clipUrls: string[]): Promise<string> {
    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    const ts = Date.now();

    // Download all clips
    const localPaths = await Promise.all(
      clipUrls.map((url, i) => this.downloadFile(url, path.join(tmpDir, `clip_${ts}_${i}.mp4`))),
    );

    // Write ffmpeg concat list
    const listFile = path.join(tmpDir, `list_${ts}.txt`);
    fs.writeFileSync(listFile, localPaths.map((p) => `file '${p}'`).join('\n'));

    const outputFile = path.join(tmpDir, `final_${ts}.mp4`);
    execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}" -y`, { stdio: 'pipe' });

    // Cleanup temp files
    localPaths.forEach((p) => fs.unlink(p, () => null));
    fs.unlink(listFile, () => null);

    this.logger.log(`[Kling] Final video: ${outputFile}`);
    return outputFile;
  }

  private downloadFile(url: string, dest: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          return this.downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', (err) => {
        fs.unlink(dest, () => null);
        reject(err);
      });
    });
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
