import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoService } from './video.service';
import { VeoProvider } from './providers/veo.provider';
import { RunwayProvider } from './providers/runway.provider';
import { KlingProvider } from './providers/kling.provider';
import { SeedanceProvider } from './providers/seedance.provider';
import { TiktokModule } from '../tiktok/tiktok.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigModule, TiktokModule, QueueModule],
  providers: [VideoService, VeoProvider, RunwayProvider, KlingProvider, SeedanceProvider],
  exports: [VideoService],
})
export class VideoModule {}
