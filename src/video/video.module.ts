import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoService } from './video.service';
import { KlingProvider } from './providers/kling.provider';
import { TiktokModule } from '../tiktok/tiktok.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigModule, TiktokModule, QueueModule],
  providers: [VideoService, KlingProvider],
  exports: [VideoService],
})
export class VideoModule {}
