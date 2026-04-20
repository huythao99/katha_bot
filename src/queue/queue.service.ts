import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface VideoJob {
  id: string;
  chatId: number;
  status: 'pending' | 'processing' | 'done' | 'failed';
  input: {
    type: 'tiktok' | 'image';
    url?: string;
    imageUrl?: string;
    prompt?: string;
    quality: '720p' | '1080p';
  };
  outputPath?: string;
  error?: string;
  createdAt: Date;
}

export type JobHandler = (job: VideoJob) => Promise<void>;

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private jobs = new Map<string, VideoJob>();
  private emitter = new EventEmitter();
  private handler: JobHandler;

  registerHandler(handler: JobHandler) {
    this.handler = handler;
  }

  async add(input: VideoJob['input'], chatId: number): Promise<string> {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const job: VideoJob = {
      id,
      chatId,
      status: 'pending',
      input,
      createdAt: new Date(),
    };
    this.jobs.set(id, job);
    this.logger.log(`Job queued: ${id}`);

    // Process asynchronously (non-blocking)
    setImmediate(() => this.process(id));

    return id;
  }

  getJob(id: string): VideoJob | undefined {
    return this.jobs.get(id);
  }

  onJobDone(callback: (job: VideoJob) => void) {
    this.emitter.on('done', callback);
  }

  onJobFailed(callback: (job: VideoJob) => void) {
    this.emitter.on('failed', callback);
  }

  private async process(id: string) {
    const job = this.jobs.get(id);
    if (!job || !this.handler) return;

    job.status = 'processing';
    this.logger.log(`Processing job: ${id}`);

    try {
      await this.handler(job);
      job.status = 'done';
      this.emitter.emit('done', job);
      this.logger.log(`Job done: ${id}`);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      this.emitter.emit('failed', job);
      this.logger.error(`Job failed: ${id} — ${err.message}`);
    }
  }
}
